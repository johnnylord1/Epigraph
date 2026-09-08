export type RestoreDomain = "manga" | "novels" | "books" | "app";
export type DomainStatus = "pending" | "running" | "succeeded" | "failed" | "unknown" | "cancelled";
export interface DomainInvocation {
  id: string;
  domain: RestoreDomain;
  execute(): Promise<void>;
  reconcile?(): Promise<void>;
}
export interface SharedRestoreSnapshot {
  operationId: string;
  target: string;
  running: boolean;
  cancelled: boolean;
  units: Record<string, DomainStatus>;
}
const activeTargets = new Set<string>();
const unresolvedMangaTargets = new Map<string, Set<string>>();

/** Flat file/domain orchestration; adapters own commits, merge and external evidence. */
export function createSharedRestoreCoordinator(options: {
  target(): string;
  ready(units: readonly DomainInvocation[]): Promise<boolean>;
}) {
  const target = options.target();
  const state: SharedRestoreSnapshot = { operationId: crypto.randomUUID(), target, running: false, cancelled: false, units: {} };
  const observers = new Set<(state: SharedRestoreSnapshot) => void>();
  let plan: string | null = null;
  const snapshot = () => structuredClone(state);
  const publish = () => { for (const observer of observers) { try { observer(snapshot()); } catch { /* presentation cannot change a commit */ } } };
  const assertTarget = () => { if (!target || options.target() !== target) throw Error("RESTORE_TARGET_CHANGED"); };
  const retainUnknown = (id: string) => {
    const ids = unresolvedMangaTargets.get(target) ?? new Set<string>();
    ids.add(id); unresolvedMangaTargets.set(target, ids);
  };
  const settleUnknown = (id: string) => {
    const ids = unresolvedMangaTargets.get(target);
    ids?.delete(id);
    if (ids?.size === 0) unresolvedMangaTargets.delete(target);
  };
  return {
    snapshot,
    observe(observer: (state: SharedRestoreSnapshot) => void) { observers.add(observer); observer(snapshot()); return () => observers.delete(observer); },
    detach() { observers.clear(); },
    cancel() { state.cancelled = true; publish(); },
    async run(requested: readonly DomainInvocation[]) {
      const units = Object.freeze(requested.map(unit => Object.freeze({ ...unit })));
      assertTarget();
      const definition = JSON.stringify(units.map(u => [u.id, u.domain]));
      if (plan !== null && plan !== definition) throw Error("RESTORE_PLAN_CHANGED");
      if (new Set(units.map(u => u.id)).size !== units.length) throw Error("RESTORE_UNIT_IDENTITY_CONFLICT");
      plan = definition;
      if (activeTargets.has(target)) throw Error("RESTORE_CONFLICT");
      activeTargets.add(target);
      state.running = true;
      let failure: unknown = null;
      try {
        if (!await options.ready(units)) throw Error("RESTORE_WAITING_FOR_DEPENDENCIES");
        assertTarget();
        for (const unit of units) {
          assertTarget();
          if (state.units[unit.id] === "succeeded") continue;
          if (state.cancelled) {
            if (state.units[unit.id] === "unknown") failure = Error("RESTORE_EXTERNAL_UNRESOLVED");
            else if (!state.units[unit.id] || state.units[unit.id] === "pending") state.units[unit.id] = "cancelled";
            continue;
          }
          const uncertain = state.units[unit.id] === "unknown" || (unit.domain === "manga" && unresolvedMangaTargets.has(target));
          if (uncertain && !unit.reconcile) {
            failure = Error("RESTORE_EXTERNAL_UNRESOLVED"); continue;
          }
          state.units[unit.id] = "running"; publish();
          try {
            await (uncertain ? unit.reconcile!() : unit.execute());
            // An acknowledged local commit remains successful even if later work fails.
            state.units[unit.id] = "succeeded";
            if (uncertain && unit.domain === "manga") settleUnknown(unit.id);
          } catch (error) {
            const externalUncertain = unit.domain === "manga" && !(error && typeof error === "object"
              && (("provenNotAccepted" in error && error.provenNotAccepted === true) || ("externalTerminal" in error && error.externalTerminal === true)));
            state.units[unit.id] = externalUncertain ? "unknown" : "failed";
            if (externalUncertain) retainUnknown(unit.id);
            else if (uncertain && unit.domain === "manga") settleUnknown(unit.id);
            failure = error instanceof Error ? error : Error("RESTORE_DOMAIN_FAILED");
          }
          publish();
        }
        if (failure) throw failure;
        return snapshot();
      } finally {
        state.running = false;
        activeTargets.delete(target);
        publish();
      }
    },
  };
}
