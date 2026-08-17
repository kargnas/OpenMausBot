// Model picker: an instance rail + model list, backed by /api/instances.
// Routing is by exact instanceId only — an entry is never inferred from a
// driver kind. Missing a cloud login does not grey an engine out: a local
// model on that CLI is still a valid pick, so every icon stays clickable
// and Custom is always at the bottom of the list.
import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, ChevronLeft, ChevronRight, LoaderCircle, RefreshCw } from "lucide-react";
import { useStore, type Bot, type InstanceInfo } from "@/state/store";
import { ProviderMark } from "./ProviderIcons";
import { EngineSetup, needsSignIn } from "./EngineSetup";
import { cn } from "@/lib/cn";

// app tsconfig은 server/contracts.ts의 값 import를 허용하지 않으므로
// EffortLevel 가드를 UI에 로컬로 둔다 (동일 6레벨 목록)
const isEffortLevel = (value: unknown): value is NonNullable<Bot["modelSelection"]["effort"]> =>
  typeof value === "string" && ["none", "low", "medium", "high", "xhigh", "max"].includes(value);

function modelLabel(instance: InstanceInfo | undefined, model: string): string {
  return (instance?.models.options.find((o) => o.id === model)?.label ?? model) || "CLI default";
}

export function ModelPicker({ bot, className }: { bot: Bot; className?: string }) {
  const { state, dispatch, refreshInstances } = useStore();
  const [open, setOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [railId, setRailId] = useState<string | null>(null);
  const [pane, setPane] = useState<"main" | "custom">("main");
  const rootRef = useRef<HTMLDivElement>(null);

  const selection = bot.modelSelection;
  const active = state.instances.find((i) => i.instanceId === selection.instanceId);
  const pickerInstances = state.instances.filter(
    (instance) => instance.models.options.length > 0 || Boolean(instance.models.error) || Boolean(instance.install),
  );
  const railInstance =
    pickerInstances.find((i) => i.instanceId === (railId ?? selection.instanceId)) ??
    pickerInstances[0];

  const refresh = () => {
    setRefreshError(null);
    setRefreshing(true);
    void refreshInstances()
      .catch((error) => setRefreshError(error instanceof Error ? error.message : String(error)))
      .finally(() => setRefreshing(false));
  };

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (pane === "custom") setPane("main");
      else setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, pane]);

  const pick = (instance: InstanceInfo, option: InstanceInfo["models"]["options"][number]) => {
    // setModel replaces the whole selection, so a configured effort has to be
    // carried across deliberately. Same engine, different model: keep the
    // user's level — silently resetting it is not what "pick a model" means.
    // Different engine: take the option's catalog default, since effort
    // vocabularies are per-driver.
    const sameInstance = instance.instanceId === selection.instanceId;
    dispatch({
      type: "setModel",
      botId: bot.id,
      selection: {
        instanceId: instance.instanceId,
        model: option.id,
        ...(sameInstance && selection.effort
          ? { effort: selection.effort }
          : isEffortLevel(option.defaultEffort)
            ? { effort: option.defaultEffort }
            : {}),
        ...(option.serviceTiers?.length ? { serviceTier: option.defaultServiceTier ?? null } : {}),
      },
    });
    if (!option.efforts?.length && !option.serviceTiers?.length) setOpen(false);
  };

  const updateOption = (patch: { effort?: string; serviceTier?: string | null }) => {
    const { effort: rawEffort, ...rest } = patch;
    const effort = rawEffort !== undefined && isEffortLevel(rawEffort) ? rawEffort : undefined;
    dispatch({
      type: "setModel",
      botId: bot.id,
      selection: { ...selection, ...rest, ...(effort !== undefined ? { effort } : {}) },
    });
  };

  return (
    <div ref={rootRef} className={cn("relative", className)}>
      <button
        onClick={() => {
          setRailId(selection.instanceId);
          setOpen((o) => {
            const next = !o;
            if (next) {
              const inst = state.instances.find((i) => i.instanceId === selection.instanceId);
              const isCustom = inst?.models.options.some((opt) => opt.id === selection.model && opt.custom);
              setPane(isCustom ? "custom" : "main");
            }
            return next;
          });
        }}
        className="flex items-center gap-1.5 rounded-full border border-hairline/40 bg-raised/60 py-1 pl-2 pr-2.5 text-[13px] text-ink hover:bg-raised"
        title={active ? `${active.displayName} · ${modelLabel(active, selection.model)}` : selection.model}
      >
        {active && <ProviderMark driverKind={active.driverKind} size={14} />}
        <span className="max-w-[160px] truncate">{modelLabel(active, selection.model)}</span>
        <ChevronDown size={14} className="text-ink-secondary" />
      </button>

      {open && (
        <div
          data-model-picker-content
          className="absolute right-0 top-full z-30 mt-2 flex max-h-[min(420px,calc(100dvh-8rem))] w-[320px] overflow-hidden rounded-xl border border-hairline/50 bg-card shadow-2xl shadow-black/50"
        >
          {/* instance rail */}
          <div className="flex flex-col gap-1 overflow-y-auto border-r border-hairline/40 bg-panel p-2">
            {pickerInstances.map((instance) => {
              const unavailable =
                instance.snapshot.state !== "available" || instance.snapshot.authenticated === false;
              const onRail = instance.instanceId === railInstance?.instanceId;
              return (
                <button
                  key={instance.instanceId}
                  onClick={() => {
                    setRailId(instance.instanceId);
                    setPane("main");
                  }}
                  title={
                    unavailable
                      ? `${instance.displayName} — ${
                          instance.snapshot.reason ??
                          (instance.snapshot.authenticated === false ? "sign-in required" : "unavailable")
                        }`
                      : instance.displayName
                  }
                  className={cn(
                    "flex size-9 items-center justify-center rounded-lg",
                    onRail ? "bg-raised" : "hover:bg-raised/60",
                    unavailable && "opacity-40",
                  )}
                >
                  <ProviderMark driverKind={instance.driverKind} size={18} />
                </button>
              );
            })}
          </div>

          {/* model list for the rail-selected instance */}
          <div className="flex min-h-0 min-w-0 flex-1 flex-col p-2">
            {railInstance ? (
              <>
                <div className="flex shrink-0 items-start justify-between gap-2 px-2 pb-1 pt-1">
                  <div className="min-w-0">
                    <div className="text-[13px] font-semibold text-ink">
                      {pane === "custom" ? "Custom" : railInstance.displayName}
                    </div>
                    <div className="truncate text-[11px] text-ink-secondary">
                      {pane === "custom"
                        ? "Inject a local model into this agent"
                        : railInstance.snapshot.state === "available" &&
                            railInstance.snapshot.authenticated !== false
                          ? (railInstance.snapshot.version ?? "ready")
                          : (railInstance.snapshot.reason ?? "sign-in required")}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={refresh}
                    disabled={refreshing}
                    aria-label="Refresh models"
                    title="Refresh models"
                    className="flex size-7 shrink-0 items-center justify-center rounded-md text-ink-secondary hover:bg-raised hover:text-ink disabled:cursor-wait"
                  >
                    {refreshing ? <LoaderCircle size={14} className="animate-spin" /> : <RefreshCw size={14} />}
                  </button>
                </div>
                {refreshError && <div className="px-2 py-1 text-[11px] text-red-400">{refreshError}</div>}
                {railInstance.models.error && (
                  <div className="px-2 py-2 text-[12px] text-red-400">{railInstance.models.error}</div>
                )}
                {/* Official-pane setup only. Custom is the inject list and
                    must stay visible even when the cloud CLI is unsigned
                    or the packaged app has not found it on PATH yet. */}
                {pane === "main" &&
                  (railInstance.snapshot.state !== "available" || needsSignIn(railInstance)) && (
                  <div className="shrink-0 border-b border-hairline/40 px-2 pb-2.5">
                    <EngineSetup instance={railInstance} />
                  </div>
                )}
                {(() => {
                  const official = railInstance.models.options.filter((o) => !o.custom);
                  const custom = railInstance.models.options.filter((o) => o.custom);
                  const rows = pane === "custom" ? custom : official;
                  const customCurrent =
                    selection.instanceId === railInstance.instanceId &&
                    custom.some((o) => o.id === selection.model);

                  const row = (option: (typeof official)[number]) => {
                    const current =
                      selection.instanceId === railInstance.instanceId && selection.model === option.id;
                    const disabled =
                      !option.custom &&
                      (railInstance.snapshot.state !== "available" || needsSignIn(railInstance));
                    return (
                      <>
                      <button
                        key={option.id}
                        disabled={disabled}
                        onClick={() => pick(railInstance, option)}
                        className={cn(
                          "flex w-full items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-left text-[13px]",
                          disabled ? "cursor-not-allowed text-ink-secondary/50" : "text-ink hover:bg-raised/60",
                          current && "bg-raised",
                        )}
                      >
                        <span className="flex min-w-0 items-center gap-2">
                          <span className="truncate">{option.label}</span>
                          {option.id === railInstance.models.default.model && (
                            <span className="shrink-0 rounded bg-inset px-1 py-px text-[10px] text-ink-secondary">
                              default
                            </span>
                          )}
                        </span>
                        {current && <Check size={14} className="shrink-0 text-accent" />}
                      </button>
                      {current && (option.efforts?.length || option.serviceTiers?.length) ? (
                        <div className="grid grid-cols-2 gap-2 px-2 pb-2">
                          {option.efforts?.length ? (
                            <label className="text-[11px] text-ink-secondary">
                              Effort
                              <select
                                value={selection.effort ?? option.defaultEffort ?? ""}
                                onChange={(event) => updateOption({ effort: event.target.value })}
                                className="mt-1 w-full rounded-md border border-hairline/50 bg-inset px-2 py-1 text-[12px] text-ink"
                              >
                                {option.efforts.map((effort) => (
                                  <option key={effort} value={effort}>{effort}</option>
                                ))}
                              </select>
                            </label>
                          ) : <span />}
                          {option.serviceTiers?.length ? (
                            <label className="text-[11px] text-ink-secondary">
                              Processing
                              <select
                                value={
                                  selection.serviceTier === undefined
                                    ? option.defaultServiceTier ?? ""
                                    : selection.serviceTier ?? ""
                                }
                                onChange={(event) => updateOption({ serviceTier: event.target.value || null })}
                                className="mt-1 w-full rounded-md border border-hairline/50 bg-inset px-2 py-1 text-[12px] text-ink"
                              >
                                <option value="">Standard</option>
                                {option.serviceTiers.map((tier) => (
                                  <option key={tier.id} value={tier.id}>{tier.label}</option>
                                ))}
                              </select>
                            </label>
                          ) : null}
                        </div>
                      ) : null}
                    </>
                  );
                };

                  return (
                    <>
                      <div className="min-h-0 flex-1 overflow-y-auto">
                        {pane === "custom" && (
                          <button
                            onClick={() => setPane("main")}
                            className="mb-0.5 flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-left text-[13px] text-ink-secondary hover:bg-raised/60"
                          >
                            <ChevronLeft size={14} />
                            <span>Back</span>
                          </button>
                        )}
                        {rows.map(row)}
                        {pane === "custom" && custom.length === 0 && (
                          <div className="px-2 py-3 text-[13px] text-ink-secondary">
                            Start oMLX, Ollama, Unsloth, LM Studio, or EXO — live models show up here
                          </div>
                        )}
                      </div>
                      {pane === "main" && (
                        <button
                          onClick={() => setPane("custom")}
                          className={cn(
                            "mt-1 flex w-full shrink-0 items-center justify-between gap-2 border-t border-hairline/40 px-2 pb-0.5 pt-1.5 text-left text-[13px] text-ink hover:bg-raised/60",
                            customCurrent && "bg-raised",
                          )}
                        >
                          <span>
                            Custom
                            {custom.length > 0 && (
                              <span className="ml-1.5 text-[11px] text-ink-secondary">{custom.length}</span>
                            )}
                          </span>
                          <ChevronRight size={14} className="shrink-0 text-ink-secondary" />
                        </button>
                      )}
                    </>
                  );
                })()}
              </>
            ) : (
              <div className="px-2 py-3 text-[13px] text-ink-secondary">
                No providers — is the server running?
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
