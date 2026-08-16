// Codex driver — upstream CodexDriver skeleton over agentcal's
// drivers/codex.js runtime: the official `codex` CLI headless over its
// app-server JSON-RPC protocol (newline-delimited JSON on stdio).
// Completion is a real `turn/completed` notification; approval requests
// arrive as in-process server→client JSON-RPC requests and surface as
// canonical request.opened events (answered via respondToRequest — no MCP
// proxy or unix socket needed, unlike claude). Verified against
// codex-cli 0.144.4 by agentcal.
//
// resumeCursor is the codex thread id; a later turn tries thread/resume
// and falls back to a fresh thread/start.
import { homedir } from "node:os";

import { describeSpawnFailure, execCli, killCliTree, spawnCli } from "../procs.ts";

import type {
  DriverCreateInput,
  ModelCatalog,
  ProviderDriver,
  ProviderInstance,
  ProviderSnapshot,
  RuntimeEvent,
  RuntimeEventListener,
  SendTurnInput,
} from "../contracts.ts";
import { newEventId, newId } from "../contracts.ts";
import { augmentedPath } from "../env-path.ts";
import { appendNative } from "./native.ts";

const DRIVER_KIND = "codex";

export interface CodexConfig {
  cli: string;
  fullAuto: boolean;
}

function decodeConfig(raw: unknown): CodexConfig {
  const o = (raw ?? {}) as Record<string, unknown>;
  return {
    cli: typeof o.cli === "string" ? o.cli : "codex",
    fullAuto: o.fullAuto === true,
  };
}

const QUESTION_TIMEOUT_NOTE = "No answer was given — use your best judgment.";
const DENY_TIMEOUT_NOTE =
  "OpenMausBot: nobody answered this permission request in time. Skip this action and finish what you can without it.";

async function readCatalog(cli: string, environment: Record<string, string>): Promise<ModelCatalog> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    ...environment,
    PATH: augmentedPath(),
    NPM_CONFIG_LOGLEVEL: "error",
  };
  delete env.OPENAI_API_KEY;
  const child = spawnCli(cli, ["app-server"], { env, stdio: ["pipe", "pipe", "pipe"] });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let buffer = "";
  let nextId = 1;
  let stderr = "";
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  const fail = (error: Error) => {
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  };
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
    if (stderr.length > 4096) stderr = stderr.slice(-4096);
  });
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      try {
        const message = JSON.parse(line);
        const request = pending.get(message.id);
        if (!request) continue;
        pending.delete(message.id);
        if (message.error) request.reject(new Error(message.error.message ?? "Codex catalog request failed"));
        else request.resolve(message.result);
      } catch {
        // App-server logs must not make a valid later JSON-RPC response unreadable.
      }
    }
  });
  child.on("error", (error) => fail(error));
  child.on("close", (code) => fail(new Error(`codex app-server exited ${code}${stderr ? `: ${stderr.trim()}` : ""}`)));

  const request = (method: string, params: unknown, timeoutMs = 20_000) =>
    new Promise<any>((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`codex ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();
      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });

  try {
    await request("initialize", { clientInfo: { name: "openmausbot", version: "1" } });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} }) + "\n");
    const listed: any[] = [];
    let cursor: string | null = null;
    do {
      const page = await request("model/list", cursor ? { cursor } : {});
      if (Array.isArray(page?.data)) listed.push(...page.data);
      cursor = typeof page?.nextCursor === "string" && page.nextCursor ? page.nextCursor : null;
    } while (cursor);
    const configured = await request("config/read", { includeLayers: false });
    const options: ModelCatalog["options"] = listed
      .filter((model: any) => typeof model?.id === "string" && model.hidden !== true)
      .map((model: any) => {
        const additionalSpeedTiers = Array.isArray(model.additionalSpeedTiers)
          ? model.additionalSpeedTiers.filter((id: unknown): id is string => typeof id === "string")
          : [];
        const serviceTiers: Array<{ id: string; label: string }> = Array.isArray(model.serviceTiers)
          ? model.serviceTiers
              .filter((tier: any) => typeof tier?.id === "string")
              .map((tier: any) => ({ id: tier.id, label: typeof tier.name === "string" ? tier.name : tier.id }))
          : [];
        for (const id of additionalSpeedTiers) {
          if (id === "fast") {
            // Codex reports the same speed mode under both IDs; keep the ID used by current config values.
            const priorityIndex = serviceTiers.findIndex((tier) => tier.id === "priority" && tier.label === "Fast");
            if (priorityIndex !== -1) serviceTiers.splice(priorityIndex, 1);
          }
          if (!serviceTiers.some((tier) => tier.id === id)) {
            serviceTiers.push({ id, label: id.charAt(0).toUpperCase() + id.slice(1) });
          }
        }
        return {
          id: model.id,
          label: typeof model.displayName === "string" ? model.displayName : model.id,
          efforts: Array.isArray(model.supportedReasoningEfforts)
            ? model.supportedReasoningEfforts
                .map((effort: any) => effort?.reasoningEffort)
                .filter((effort: unknown): effort is string => typeof effort === "string")
            : [],
          ...(typeof model.defaultReasoningEffort === "string"
            ? { defaultEffort: model.defaultReasoningEffort }
            : {}),
          serviceTiers,
          defaultServiceTier: typeof model.defaultServiceTier === "string" ? model.defaultServiceTier : null,
          provider: "codex",
        };
      });
    if (!options.length) throw new Error("codex model/list returned no visible models");
    const config = configured?.config ?? {};
    const reportedDefault = listed.find((model) => model?.isDefault === true)?.id;
    const option =
      (typeof config.model === "string" ? options.find((candidate) => candidate.id === config.model) : undefined) ??
      options.find((candidate) => candidate.id === reportedDefault) ??
      options[0];
    const defaultModel = option.id;
    return {
      default: {
        model: defaultModel,
        ...(typeof config.model_reasoning_effort === "string"
          ? { effort: config.model_reasoning_effort }
          : option.defaultEffort
            ? { effort: option.defaultEffort }
            : {}),
        ...(config.service_tier !== undefined
          ? { serviceTier: typeof config.service_tier === "string" ? config.service_tier : null }
          : { serviceTier: option.defaultServiceTier ?? null }),
      },
      options,
    };
  } finally {
    killCliTree(child);
  }
}

export const CodexDriver: ProviderDriver<CodexConfig> = {
  driverKind: DRIVER_KIND,
  metadata: { displayName: "Codex", supportsMultipleInstances: true },
  install: {
    command: {
      darwin: "npm install -g @openai/codex",
      linux: "npm install -g @openai/codex",
      win32: "npm install -g @openai/codex",
    },
    needsNode: true,
    docsUrl: "https://github.com/openai/codex",
    signInCommand: "codex",
  },
  decodeConfig,
  defaultConfig: () => decodeConfig({}),

  async create(input: DriverCreateInput<CodexConfig>): Promise<ProviderInstance> {
    const { instanceId, config } = input;
    const listeners = new Set<RuntimeEventListener>();
    interface Turn {
      stop: () => void;
      turnId: string;
      asks: Map<string, (behavior: string, message?: string) => void>;
    }
    const active = new Map<string, Turn>();

    const emit = (event: RuntimeEvent) => {
      for (const l of [...listeners]) l(event);
    };
    const base = (threadId: string, turnId: string) => ({
      eventId: newEventId(),
      provider: DRIVER_KIND,
      threadId,
      turnId,
      createdAt: new Date().toISOString(),
    });

    const sendTurn = async (turn: SendTurnInput) => {
      const { threadId } = turn;
      if (active.has(threadId)) throw new Error("a turn is already running on this thread");
      const turnId = newId();

      const env: Record<string, string | undefined> = { ...process.env, PATH: augmentedPath(), NPM_CONFIG_LOGLEVEL: "error" };
      // the CLI owns its own ChatGPT login; a leaked API key silently flips
      // billing to pay-as-you-go (agentcal)
      delete env.OPENAI_API_KEY;

      const child = spawnCli(config.cli, ["app-server"], {
        cwd: turn.cwd ?? homedir(),
        env,
        stdio: ["pipe", "pipe", "pipe"],
      });

      const state = { settled: false, lastText: "", sawStreamDelta: false };
      const asks = new Map<string, (behavior: string, message?: string) => void>();
      let nextId = 1;
      const rpcPending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();

      const send = (obj: unknown) => {
        try {
          child.stdin.write(JSON.stringify(obj) + "\n");
        } catch {}
        appendNative(threadId, { dir: "out", source: "codex.app-server", msg: obj });
      };
      const request = (method: string, params: unknown, timeoutMs = 60_000) =>
        new Promise<any>((resolve, reject) => {
          const id = nextId++;
          // a wedged app-server can accept stdin and never reply; without this
          // the handshake await hangs forever and the bot stays busy for good
          const timer = setTimeout(() => {
            if (rpcPending.delete(id)) reject(new Error(`codex ${method} timed out after ${timeoutMs}ms`));
          }, timeoutMs);
          if (typeof timer.unref === "function") timer.unref();
          rpcPending.set(id, {
            resolve: (v) => {
              clearTimeout(timer);
              resolve(v);
            },
            reject: (e) => {
              clearTimeout(timer);
              reject(e);
            },
          });
          send({ jsonrpc: "2.0", id, method, params });
        });

      const stop = () => killCliTree(child);

      const settle = (ok: boolean, stopReason: string | null) => {
        if (state.settled) return;
        state.settled = true;
        for (const finish of [...asks.values()]) finish("deny", "OpenMausBot: the turn ended");
        for (const p of rpcPending.values()) p.reject(new Error("turn settled"));
        rpcPending.clear();
        active.delete(threadId);
        emit({ ...base(threadId, turnId), type: "turn.completed", ok, stopReason, cost: null });
        stop(); // the app-server never exits on its own
      };

      // server→client approval request → canonical request.opened
      const handleServerRequest = (msg: any) => {
        const method = msg.method as string;
        const params = msg.params ?? {};
        const legacy = method === "execCommandApproval" || method === "applyPatchApproval";
        const isQuestion = method === "item/tool/requestUserInput";
        const tool =
          method === "item/fileChange/requestApproval" || method === "applyPatchApproval"
            ? "edit"
            : isQuestion
              ? "ask_user"
              : "shell";
        if (config.fullAuto && !isQuestion) {
          return send({ jsonrpc: "2.0", id: msg.id, result: { decision: legacy ? "approved" : "accept" } });
        }
        const requestId = newId();
        const summary =
          typeof params.command === "string"
            ? params.command.slice(0, 200)
            : Array.isArray(params.questions)
              ? params.questions.map((q: any) => q.question ?? q.header).filter(Boolean).join(" · ")
              : typeof params.reason === "string"
                ? params.reason
                : tool;
        const choices = isQuestion
          ? (params.questions?.[0]?.options ?? []).map((o: any) => o.label).slice(0, 5)
          : undefined;
        const finish = (behavior: string, message?: string) => {
          if (!asks.delete(requestId)) return;
          clearTimeout(timer);
          if (isQuestion) {
            const answers: Record<string, { answers: string[] }> = {};
            for (const q of Array.isArray(params.questions) ? params.questions : []) {
              answers[q.id] = { answers: [message || QUESTION_TIMEOUT_NOTE] };
            }
            send({ jsonrpc: "2.0", id: msg.id, result: { answers } });
          } else {
            send({
              jsonrpc: "2.0",
              id: msg.id,
              result: { decision: behavior === "allow" ? (legacy ? "approved" : "accept") : legacy ? "denied" : "decline" },
            });
          }
          emit({ ...base(threadId, turnId), type: "request.resolved", requestId, behavior, source: "user" });
        };
        const timer = setTimeout(
          () => (isQuestion ? finish("answer", QUESTION_TIMEOUT_NOTE) : finish("deny", DENY_TIMEOUT_NOTE)),
          15 * 60_000,
        );
        timer.unref?.();
        asks.set(requestId, finish);
        emit({
          ...base(threadId, turnId),
          type: "request.opened",
          requestId,
          requestType: isQuestion ? "question" : "permission",
          tool,
          summary,
          choices,
        });
      };

      const handleNotification = (msg: any) => {
        const p = msg.params ?? {};
        switch (msg.method) {
          // token-level chat text; the item/completed frame follows with the
          // whole message, so its delta is only a fallback when none streamed
          case "item/agentMessage/delta": {
            const delta = typeof p.delta === "string" ? p.delta : "";
            if (delta) {
              state.sawStreamDelta = true;
              emit({ ...base(threadId, turnId), type: "content.delta", streamKind: "assistant_text", delta });
            }
            break;
          }
          case "item/reasoning/textDelta":
          case "item/reasoning/summaryTextDelta": {
            const delta = typeof p.delta === "string" ? p.delta : "";
            if (delta) emit({ ...base(threadId, turnId), type: "content.delta", streamKind: "reasoning_text", delta });
            break;
          }
          case "item/started": {
            const item = p.item ?? {};
            const title =
              item.type === "commandExecution"
                ? String(item.command ?? "shell").slice(0, 80)
                : item.type === "fileChange"
                  ? "edit"
                  : item.type === "mcpToolCall"
                    ? (item.tool ?? item.name ?? "mcp")
                    : item.type === "webSearch"
                      ? "web_search"
                      : null;
            if (title) emit({ ...base(threadId, turnId), type: "item.started", itemType: "tool", itemId: item.id, title });
            break;
          }
          case "item/completed": {
            const item = p.item ?? {};
            if (item.type === "agentMessage") {
              if (item.text?.trim()) {
                state.lastText = item.text;
                if (!state.sawStreamDelta) {
                  emit({ ...base(threadId, turnId), type: "content.delta", streamKind: "assistant_text", delta: item.text });
                }
                state.sawStreamDelta = false;
                emit({ ...base(threadId, turnId), type: "item.completed", itemType: "assistant_text", text: item.text });
              }
            } else if (["commandExecution", "fileChange", "mcpToolCall"].includes(item.type)) {
              emit({
                ...base(threadId, turnId),
                type: "item.completed",
                itemType: "tool",
                itemId: item.id,
                ok: item.status !== "failed" && item.status !== "declined",
              });
            } else if (item.type === "reasoning") {
              emit({ ...base(threadId, turnId), type: "item.updated", itemType: "reasoning", tokens: null });
            }
            break;
          }
          case "thread/tokenUsage/updated": {
            const t = p.tokenUsage?.total;
            if (t) {
              emit({
                ...base(threadId, turnId),
                type: "thread.token-usage.updated",
                input: t.inputTokens ?? 0,
                output: t.outputTokens ?? 0,
              });
            }
            break;
          }
          case "turn/completed": {
            const t = p.turn ?? {};
            settle(t.status === "completed", t.status === "completed" ? null : (t.error?.message ?? t.status ?? "failed"));
            break;
          }
          case "error":
            // shape drift: 0.144 sends {message}, 0.139 nests it under
            // {error:{message}} — surface either (agentcal armor)
            {
              const message = p.message ?? p.error?.message;
              if (message) emit({ ...base(threadId, turnId), type: "runtime.error", message: String(message).slice(0, 400) });
            }
            break;
        }
      };

      let buf = "";
      // decode as UTF-8 across chunk boundaries — a raw `buf += chunk` splits
      // multibyte characters that straddle two reads and corrupts the text
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        buf += chunk;
        let nl;
        while ((nl = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (!line.trim()) continue;
          let msg: any;
          try {
            msg = JSON.parse(line);
          } catch {
            continue;
          }
          appendNative(threadId, { dir: "in", source: "codex.app-server", msg });
          if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
            const pend = rpcPending.get(msg.id);
            if (pend) {
              rpcPending.delete(msg.id);
              msg.error ? pend.reject(new Error(msg.error.message ?? JSON.stringify(msg.error))) : pend.resolve(msg.result);
            }
          } else if (msg.id !== undefined && msg.method) {
            handleServerRequest(msg);
          } else if (msg.method) {
            handleNotification(msg);
          }
        }
      });

      let stderr = "";
      child.stderr.on("data", (c) => {
        stderr += c;
        if (stderr.length > 8192) stderr = stderr.slice(-8192);
      });
      child.on("error", (e) => {
        emit({ ...base(threadId, turnId), type: "runtime.error", ...describeSpawnFailure(e, config.cli) });
        settle(false, "spawn_error");
      });
      child.on("close", (code) => {
        if (!state.settled) {
          emit({
            ...base(threadId, turnId),
            type: "runtime.error",
            message: `codex exited ${code} before turn/completed${stderr ? `: ${stderr.trim().slice(-300)}` : ""}`,
          });
          settle(false, "exit_before_result");
        }
      });

      active.set(threadId, { stop, turnId, asks });
      emit({ ...base(threadId, turnId), type: "turn.started" });

      // handshake + kickoff; any refusal surfaces as failure, not a hang
      (async () => {
        try {
          await request("initialize", { clientInfo: { name: "openmausbot", version: "1" } });
          send({ jsonrpc: "2.0", method: "initialized", params: {} });
          const cursor = typeof turn.resumeCursor === "string" ? turn.resumeCursor : null;
          let codexThreadId: string | null = null;
          let startedModel: string | null = null;
          if (cursor) {
            try {
              const resumed = await request("thread/resume", {
                threadId: cursor,
                ...(turn.model ? { model: turn.model } : {}),
                ...(turn.serviceTier !== undefined ? { serviceTier: turn.serviceTier } : {}),
              });
              codexThreadId = resumed?.thread?.id ?? cursor;
            } catch {
              /* resume unsupported or thread gone — start fresh below */
            }
          }
          if (!codexThreadId) {
            const started = await request("thread/start", {
              cwd: turn.cwd ?? homedir(),
              model: turn.model || null,
              ...(turn.serviceTier !== undefined ? { serviceTier: turn.serviceTier } : {}),
              sandbox: config.fullAuto ? "danger-full-access" : "workspace-write",
              approvalPolicy: config.fullAuto ? "never" : "on-request",
              ephemeral: false,
            });
            codexThreadId = started?.thread?.id ?? null;
            startedModel = started?.model ?? null;
          }
          emit({ ...base(threadId, turnId), type: "session.started", sessionId: codexThreadId, model: startedModel ?? turn.model ?? null });
          await request("turn/start", {
            threadId: codexThreadId,
            input: [{ type: "text", text: turn.system ? `${turn.system}\n\n${turn.text}` : turn.text }],
            ...(turn.model ? { model: turn.model } : {}),
            ...(turn.effort ? { effort: turn.effort } : {}),
            ...(turn.serviceTier !== undefined ? { serviceTier: turn.serviceTier } : {}),
          });
        } catch (e) {
          if (!state.settled) {
            emit({ ...base(threadId, turnId), type: "runtime.error", message: (e as Error).message });
            settle(false, "rpc_error");
          }
        }
      })();

      return { turnId };
    };

    const snapshot = async (): Promise<ProviderSnapshot> => {
      const version = await new Promise<string | null>((resolve) => {
        execCli(config.cli, ["--version"], { timeout: 8000, env: { ...process.env, PATH: augmentedPath() } }, (err, stdout) =>
          resolve(err ? null : stdout.trim()),
        );
      });
      if (!version) return { state: "unavailable", reason: `\`${config.cli}\` CLI not found` };
      return { state: "available", version };
    };

    return {
      instanceId,
      driverKind: DRIVER_KIND,
      displayName: input.displayName,
      enabled: input.enabled,
      catalog: () => readCatalog(config.cli, input.environment),
      snapshot,
      adapter: {
        provider: DRIVER_KIND,
        capabilities: { sessionModelSwitch: "unsupported" },
        sendTurn,
        interruptTurn: async (threadId) => active.get(threadId)?.stop(),
        respondToRequest: async (threadId, requestId, decision) => {
          const turn = active.get(threadId);
          const finish = turn?.asks.get(requestId);
          if (!finish) throw new Error("no such pending request");
          finish(decision.behavior, decision.message);
        },
        hasSession: (threadId) => active.has(threadId),
        stopAll: async () => {
          for (const { stop } of active.values()) stop();
        },
        onEvent: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
      dispose: async () => {
        for (const { stop } of active.values()) stop();
        listeners.clear();
      },
    };
  },
};
