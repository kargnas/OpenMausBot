// Kimi Code harness support — Moonshot's `kimi` CLI over ACP stdio
// (`kimi acp`), on the Kimi Code subscription login
// (~/.kimi-code/credentials/kimi-code.json), not a Moonshot API key.
// The generic protocol runtime lives in acp/core.ts; this file is only the
// per-harness quirks. Verified against kimi-code 0.29.1: initialize reports
// loadSession:true (session/load resume works), mcpCapabilities http+sse,
// and a full session/new → session/prompt roundtrip streams
// agent_thought_chunk + agent_message_chunk and settles with end_turn.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { execCli } from "../../procs.ts";
import { decodeInjectId, hostApiKey, localHost, mergeLocalInject } from "../local-inject.ts";
import type { ModelCatalog } from "../../contracts.ts";
import { createAcpDriver, type AcpSupport } from "./core.ts";

function configPath(env: Record<string, string | undefined>) {
  const dataRoot = env.KIMI_CODE_HOME || join(env.HOME || homedir(), ".kimi-code");
  return join(dataRoot, "config.toml");
}

function kimiDataRoot(env: Record<string, string | undefined>): string {
  return env.KIMI_CODE_HOME || join(env.HOME || env.USERPROFILE || homedir(), ".kimi-code");
}

function credentialsPath(env: Record<string, string | undefined>) {
  return join(kimiDataRoot(env), "credentials", "kimi-code.json");
}

function quoteToml(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function quoteTomlKey(key: string): string {
  if (/^[A-Za-z0-9_-]+$/.test(key)) return key;
  return quoteToml(key);
}

function hasTomlTable(text: string, heading: string): boolean {
  return text.split(/\r?\n/).some((line) => line.trim() === heading);
}

/** Write [providers.host] + [models."host/alias"] so `kimi -m` hits the local host. */
export function ensureKimiInjectAlias(
  modelId: string,
  env: Record<string, string | undefined> = process.env,
): string {
  const inject = decodeInjectId(modelId);
  if (!inject) return modelId;
  const host = localHost(inject.host);
  if (!host) return modelId;

  const alias = `${inject.host}/${inject.model.replace(/\//g, "-")}`;
  const dataRoot = kimiDataRoot(env);
  mkdirSync(dataRoot, { recursive: true });
  const path = join(dataRoot, "config.toml");
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch {
    text = "";
  }

  const providerHeading = `[providers.${inject.host}]`;
  const modelHeading = `[models.${quoteTomlKey(alias)}]`;
  const blocks: string[] = [];
  if (!hasTomlTable(text, providerHeading)) {
    blocks.push(
      [
        providerHeading,
        `type = "openai_legacy"`,
        `base_url = ${quoteToml(host.baseUrl)}`,
        `api_key = ${quoteToml(hostApiKey(host, env))}`,
        "",
      ].join("\n"),
    );
  }
  if (!hasTomlTable(text, modelHeading)) {
    blocks.push(
      [modelHeading, `provider = ${quoteToml(inject.host)}`, `model = ${quoteToml(inject.model)}`, ""].join("\n"),
    );
  }
  if (blocks.length) {
    const prefix = text && !text.endsWith("\n") ? `${text}\n\n` : text ? `${text}\n` : "";
    writeFileSync(path, `${prefix}${blocks.join("\n")}`);
  }
  return alias;
}

const support: AcpSupport = {
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
    if (turn.model) await request("session/set_model", { sessionId, modelId: turn.model });
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

  catalog: async (config, env) =>
    mergeLocalInject(
      await new Promise<ModelCatalog>((resolve, reject) => {
      execCli(config.cli, ["provider", "list", "--json"], { timeout: 20_000, env }, (error, stdout) => {
        if (error) return reject(error);
        try {
          const payload = JSON.parse(stdout);
          const options = Object.entries(payload?.models ?? {}).map(([id, raw]) => {
            const model = raw as Record<string, unknown>;
            const capabilities = Array.isArray(model.capabilities) ? model.capabilities : [];
            const efforts = Array.isArray(model.supportEfforts)
              ? model.supportEfforts.filter((effort): effort is string => typeof effort === "string")
              : [];
            return {
              id,
              label: typeof model.displayName === "string" ? model.displayName : id,
              ...(efforts.length ? { efforts } : {}),
              ...(typeof model.defaultEffort === "string" ? { defaultEffort: model.defaultEffort } : {}),
              toolUse: capabilities.includes("tool_use"),
            };
          });
          if (!options.length) throw new Error("Kimi provider list returned no models");
          let configured = "";
          try {
            configured = readFileSync(configPath(env), "utf8");
          } catch {
            // Missing config means the CLI will use its catalog default.
          }
          const requestedModel = /^\s*default_model\s*=\s*"([^"]+)"/m.exec(configured)?.[1];
          const model = requestedModel && options.some((option) => option.id === requestedModel)
            ? requestedModel
            : options[0].id;
          const thinking = /\[thinking\]([\s\S]*?)(?:\n\[|$)/.exec(configured)?.[1] ?? "";
          const configuredEffort = /^\s*effort\s*=\s*"([^"]+)"/m.exec(thinking)?.[1];
          const selected = options.find((option) => option.id === model)!;
          resolve({
            default: {
              model,
              ...(configuredEffort
                ? { effort: configuredEffort }
                : selected.defaultEffort
                  ? { effort: selected.defaultEffort }
                  : {}),
            },
            options,
          });
        } catch (error) {
          reject(error);
        }
      });
      }),
      env,
    ),

  buildPromptText: (turn) => (turn.system ? `${turn.system}\n\n${turn.text}` : turn.text),
};

export const KimiAgentDriver = createAcpDriver(support);
