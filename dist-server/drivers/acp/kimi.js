// Kimi Code harness support — Moonshot's `kimi` CLI over ACP stdio
// (`kimi acp`), on the Kimi Code subscription login
// (~/.kimi-code/credentials/kimi-code.json), not a Moonshot API key.
// The generic protocol runtime lives in acp/core.ts; this file is only the
// per-harness quirks. Verified against kimi-code 0.29.1: initialize reports
// loadSession:true (session/load resume works), mcpCapabilities http+sse,
// and a full session/new → session/prompt roundtrip streams
// agent_thought_chunk + agent_message_chunk and settles with end_turn.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isEffortLevel } from "../../contracts.js";
import { execCli } from "../../procs.js";
import { createAcpDriver } from "./core.js";
function credentialsPath(env) {
    const dataRoot = env.KIMI_CODE_HOME || join(env.HOME || homedir(), ".kimi-code");
    return join(dataRoot, "credentials", "kimi-code.json");
}
function configPath(env) {
    const dataRoot = env.KIMI_CODE_HOME || join(env.HOME || homedir(), ".kimi-code");
    return join(dataRoot, "config.toml");
}
const support = {
    driverKind: "kimiAgent",
    displayName: "Kimi",
    defaultCli: "kimi",
    nativeSource: "kimi.acp",
    loginNote: "Kimi Code CLI is not signed in — run `kimi login` in a terminal",
    // Official installers put the binary on PATH without requiring an existing
    // Node install. Keep the commands platform-specific so Windows never gets a
    // POSIX-only curl|bash instruction.
    install: {
        command: {
            darwin: "curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash",
            linux: "curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash",
            win32: "irm https://code.kimi.com/kimi-code/install.ps1 | iex",
        },
        docsUrl: "https://moonshotai.github.io/kimi-code/en/guides/getting-started.html",
        signInCommand: "kimi login",
    },
    spawnArgs: () => ["acp"],
    applySelection: async (request, sessionId, turn) => {
        if (turn.model)
            await request("session/set_model", { sessionId, modelId: turn.model });
        if (turn.effort) {
            await request("session/set_config_option", {
                sessionId,
                configId: "thinking",
                value: turn.effort,
            });
        }
    },
    // Subscription CLI: a leaked Moonshot/Kimi API key must not flip billing
    // to pay-as-you-go inside the spawned agent (mirrors claude/grok).
    transformEnv: (env) => {
        delete env.MOONSHOT_API_KEY;
        delete env.KIMI_API_KEY;
    },
    // The only advertised authMethod is {id:"login", type:"terminal"} — a
    // device-code flow that cannot be driven over ACP. Never pick it; ride
    // the ambient login from a prior `kimi login` instead.
    pickAuthMethod: () => null,
    authFailure: "continue",
    // Match the child CLI's own data-root precedence. A custom instance HOME or
    // KIMI_CODE_HOME must not be checked against the server user's home instead.
    isAuthenticated: (env) => existsSync(credentialsPath(env)),
    catalog: (config, env) => new Promise((resolve, reject) => {
        execCli(config.cli, ["provider", "list", "--json"], { timeout: 20_000, env }, (error, stdout) => {
            if (error)
                return reject(error);
            try {
                const payload = JSON.parse(stdout);
                const options = Object.entries(payload?.models ?? {}).map(([id, raw]) => {
                    const model = raw;
                    const capabilities = Array.isArray(model.capabilities) ? model.capabilities : [];
                    const efforts = Array.isArray(model.supportEfforts)
                        ? model.supportEfforts.filter((effort) => typeof effort === "string")
                        : [];
                    return {
                        id,
                        label: typeof model.displayName === "string" ? model.displayName : id,
                        ...(efforts.length ? { efforts } : {}),
                        ...(typeof model.defaultEffort === "string" ? { defaultEffort: model.defaultEffort } : {}),
                        toolUse: capabilities.includes("tool_use"),
                    };
                });
                if (!options.length)
                    throw new Error("Kimi provider list returned no models");
                let configured = "";
                try {
                    configured = readFileSync(configPath(env), "utf8");
                }
                catch {
                    // Missing config means the CLI will use its catalog default.
                }
                const requestedModel = /^\s*default_model\s*=\s*"([^"]+)"/m.exec(configured)?.[1];
                const model = requestedModel && options.some((option) => option.id === requestedModel)
                    ? requestedModel
                    : options[0].id;
                const thinking = /\[thinking\]([\s\S]*?)(?:\n\[|$)/.exec(configured)?.[1] ?? "";
                const configuredEffort = /^\s*effort\s*=\s*"([^"]+)"/m.exec(thinking)?.[1];
                const selected = options.find((option) => option.id === model);
                resolve({
                    default: {
                        model,
                        ...(isEffortLevel(configuredEffort)
                            ? { effort: configuredEffort }
                            : isEffortLevel(selected.defaultEffort)
                                ? { effort: selected.defaultEffort }
                                : {}),
                    },
                    options,
                });
            }
            catch (error) {
                reject(error);
            }
        });
    }),
    buildPromptText: (turn) => (turn.system ? `${turn.system}\n\n${turn.text}` : turn.text),
};
export const KimiAgentDriver = createAcpDriver(support);
