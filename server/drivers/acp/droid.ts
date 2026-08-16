// Factory Droid harness support — the `droid` CLI over ACP stdio
// (`droid exec -o acp`), on the Factory login (~/.factory/auth.v2.file) or a
// FACTORY_API_KEY. The generic protocol runtime lives in acp/core.ts; this
// file is only the per-harness quirks. Verified against droid 0.196.0:
// initialize reports protocolVersion 1, loadSession:true (session/load resume
// works), promptCapabilities image+embeddedContext, and authMethods
// device-pairing + factory-api-key.
//
// UNLIKE every other ACP harness here, droid ignores argv for session
// settings. `droid exec --help` says so under "Stream JSON-RPC Mode": "CLI
// flags do not configure JSON-RPC sessions: -m/--model, --auto,
// -r/--reasoning-effort, and --disable-builtin-skills are still validated,
// but session settings come from JSON-RPC requests." So a `-m` that only
// reaches argv is accepted and then ignored, and the session runs whatever
// ~/.factory/settings.json selected. Model and autonomy are session config
// options set over the wire (session/set_model, session/set_mode), which is
// why both live in configureSession() below and NOT in spawnArgs.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ModelCatalog } from "../../contracts.ts";
import { execCli } from "../../procs.ts";
import { createAcpDriver, type AcpSupport } from "./core.ts";

// FACTORY_HOME_OVERRIDE replaces the HOME the CLI resolves, NOT the data root:
// droid builds every path as <home>/.factory/… (verified against 0.196.0 —
// `FACTORY_HOME_OVERRIDE=/tmp/x droid exec -o acp` created /tmp/x/.factory/).
// Kimi's KIMI_CODE_HOME is a data root; this one is not, so the `.factory`
// segment stays on both branches.
//
// Which credential file exists depends on the `secure_auth_storage` feature
// flag droid fetches for the account: with secure storage on it writes
// auth.v2.loginkeychain (macOS) or auth.v2.keyring (keytar), and only falls
// back to auth.v2.file when that write fails. droid's own check tries all of
// them, so checking one name alone reports a fresh signed-in login as logged
// out. Names read from the 0.196.0 binary.
const AUTH_FILES = ["auth.v2.file", "auth.v2.loginkeychain", "auth.v2.keyring"];

function authFilePaths(env: Record<string, string | undefined>) {
  const home = env.FACTORY_HOME_OVERRIDE || env.HOME || homedir();
  return AUTH_FILES.map((name) => join(home, ".factory", name));
}

// droid's real catalog is half user-local: `custom:` providers (Azure, a
// local LM Studio server, …) live in ~/.factory/settings.json, the user
// orders the picker with modelFavorites, and sessionDefaultSettings.model is
// the model the CLI itself starts on. None of that can be enumerated from a
// static list, so read it and fall back to the built-in slice if unreadable.
interface FactorySettings {
  customModels?: Array<{ id?: string; displayName?: string }>;
  modelFavorites?: string[];
  sessionDefaultSettings?: { model?: string; reasoningEffort?: string };
}

function readSettings(env: Record<string, string | undefined>): FactorySettings {
  const home = env.FACTORY_HOME_OVERRIDE || env.HOME || homedir();
  return JSON.parse(readFileSync(join(home, ".factory", "settings.json"), "utf8")) as FactorySettings;
}

function catalogFromHelp(help: string, env: Record<string, string | undefined>): ModelCatalog {
  const modelBlock = /Available Models:\s*\n([\s\S]*?)\n\s*Model details:/.exec(help)?.[1] ?? "";
  const listed = modelBlock.split(/\r?\n/).flatMap((line) => {
    const match = /^\s{2,}(\S+)\s{2,}(.+?)\s*$/.exec(line);
    if (!match) return [];
    const isDefault = /\s+\(default\)$/.test(match[2]);
    return [{ id: match[1], label: match[2].replace(/\s+\(default\)$/, ""), isDefault }];
  });
  if (!listed.length) throw new Error("Droid CLI help returned no models");

  const details = new Map<string, { efforts: string[]; defaultEffort: string }>();
  for (const match of help.matchAll(
    /^\s*-\s*(.+?): supports reasoning: (?:Yes|No); supported: \[([^\]]*)\]; default: (\S+)\s*$/gm,
  )) {
    details.set(match[1], {
      efforts: match[2].split(",").map((effort) => effort.trim()).filter(Boolean),
      defaultEffort: match[3],
    });
  }

  let settings: FactorySettings;
  try {
    settings = readSettings(env);
  } catch {
    settings = {};
  }

  const custom: ModelCatalog["options"] = (settings.customModels ?? []).flatMap((m) =>
    m.id ? [{ id: m.id, label: m.displayName || m.id }] : [],
  );
  const discovered: ModelCatalog["options"] = listed.map(({ id, label }) => {
    const detail = details.get(label);
    return {
      id,
      label,
      ...(detail?.efforts.length ? { efforts: detail.efforts } : {}),
      ...(detail?.defaultEffort ? { defaultEffort: detail.defaultEffort } : {}),
    };
  });
  const merged = [...custom, ...discovered.filter((option) => !custom.some((entry) => entry.id === option.id))];

  // Favourites first, in the user's own order; everything else keeps its
  // existing order (Array.prototype.sort is stable).
  const rank = new Map((settings.modelFavorites ?? []).map((id, i) => [id, i]));
  const options = merged.sort((a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity));

  const configured = settings.sessionDefaultSettings?.model;
  const cliDefault = listed.find((option) => option.isDefault)?.id;
  const model = configured && options.some((option) => option.id === configured)
    ? configured
    : cliDefault && options.some((option) => option.id === cliDefault)
      ? cliDefault
      : options[0].id;
  const selected = options.find((option) => option.id === model)!;
  const configuredEffort = settings.sessionDefaultSettings?.reasoningEffort;
  return {
    default: {
      model,
      ...(configuredEffort ? { effort: configuredEffort } : selected.defaultEffort ? { effort: selected.defaultEffort } : {}),
    },
    options,
  };
}

function readDroidCatalog(cli: string, env: Record<string, string | undefined>): Promise<ModelCatalog> {
  return new Promise((resolve, reject) => {
    execCli(cli, ["exec", "--help"], { timeout: 20_000, env }, (error, stdout) => {
      if (error) return reject(error);
      try {
        resolve(catalogFromHelp(stdout, env));
      } catch (catalogError) {
        reject(catalogError);
      }
    });
  });
}

// droid answers a rejected setting with a bare JSON-RPC message ("Model not
// recognized", "Method not found") that reaches the error card verbatim,
// naming neither the engine nor the setting that failed. Say what we asked for.
async function applySetting(
  request: (method: string, params: unknown, timeoutMs?: number) => Promise<any>,
  method: string,
  params: Record<string, unknown>,
  what: string,
) {
  try {
    await request(method, params);
  } catch (e) {
    throw new Error(
      `Droid rejected ${what} via ${method}: ${(e as Error).message}. ` +
        `Check that \`droid\` is current (0.196.0+ supports it) and that this account can use that value.`,
    );
  }
}

// Autonomy maps onto droid's session modes (session/new advertises
// normal | spec | auto-low | auto-medium | auto-high). Always set it
// explicitly: ~/.factory/settings.json can pin a mode, and inheriting it
// would either make every session yolo or make fullAuto silently ask.
const MODE_DEFAULT = "normal"; // auto-approves reads only; everything else asks
const MODE_FULL_AUTO = "auto-high";

const support: AcpSupport = {
  driverKind: "droidAgent",
  displayName: "Droid",
  defaultCli: "droid",
  nativeSource: "droid.acp",
  loginNote: "Droid CLI is not signed in — run `droid` once and log in, or set FACTORY_API_KEY",

  install: {
    command: {
      darwin: "curl -fsSL https://app.factory.ai/cli | sh",
      linux: "curl -fsSL https://app.factory.ai/cli | sh",
      win32: "irm https://app.factory.ai/cli/windows | iex",
    },
    docsUrl: "https://docs.factory.ai/droid-cli/quickstart",
    signInCommand: "droid",
  },

  // No model/mode flags here on purpose: see the header note. `-o acp` is the
  // ACP entry point; everything else is negotiated over the protocol.
  spawnArgs: () => ["exec", "-o", "acp"],
  credentialEnv: ["FACTORY_API_KEY"],

  // The advertised methods are device-pairing (a browser flow that cannot be
  // driven over ACP) and factory-api-key (read from the child env, no
  // authenticate call needed). Ride the ambient login instead, like Kimi.
  pickAuthMethod: () => null,
  authFailure: "continue",
  // The signed-in CLI is the primary source; FACTORY_API_KEY is the fallback
  // droid itself advertises, and it is checked last so an ambient key can
  // never be what makes an otherwise logged-out instance look ready.
  isAuthenticated: (env) => authFilePaths(env).some(existsSync) || Boolean(env.FACTORY_API_KEY),
  catalog: (config, env) => readDroidCatalog(config.cli, env),

  async configureSession({ request, sessionId, config, env, turn }) {
    const modeId = config.fullAuto ? MODE_FULL_AUTO : MODE_DEFAULT;
    await applySetting(request, "session/set_mode", { sessionId, modeId }, `autonomy mode "${modeId}"`);
    // Pin the model for the same reason as the mode: with no set_model the
    // session runs whatever ~/.factory/settings.json selected, which can be a
    // `custom:` provider pointing at its own endpoint and key.
    const modelId = turn.model || (await readDroidCatalog(config.cli, env)).default.model;
    await applySetting(request, "session/set_model", { sessionId, modelId }, `model "${modelId}"`);
    if (turn.effort) {
      await applySetting(
        request,
        "session/set_config_option",
        { sessionId, configId: "reasoning_effort", value: turn.effort },
        `reasoning effort "${turn.effort}"`,
      );
    }
  },

  // House convention for ACP harnesses (grok, gemini, kimi all do this): the
  // persona rides in the prompt text rather than a CLI system-prompt flag.
  buildPromptText: (turn) => (turn.system ? `${turn.system}\n\n${turn.text}` : turn.text),
};

export const DroidAgentDriver = createAcpDriver(support);
