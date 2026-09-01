export interface VisibleReaderPage {
  pageNumber: number;
  visibleRatio: number;
  centerDistance: number;
}

interface ReaderWindowHost {
  onCloseRequested(handler: (event: { preventDefault(): void }) => Promise<void>): Promise<() => void>;
  close(): Promise<void>;
}

/** A web unload event cannot wait for asynchronous disk/IPC writes. */
export async function attachReaderCloseGuard(
  host: ReaderWindowHost,
  flush: () => Promise<void>,
  onError: (error: unknown) => void,
): Promise<() => void> {
  let disposed = false;
  let saving = false;
  let allowClose = false;
  const unlisten = await host.onCloseRequested(async (event) => {
    if (allowClose || disposed) return;
    event.preventDefault();
    if (saving) return;
    saving = true;
    try {
      await flush();
      if (disposed) return;
      allowClose = true;
      await host.close();
    } catch (error) {
      allowClose = false;
      onError(error);
    } finally {
      saving = false;
    }
  });
  return () => { disposed = true; unlisten(); };
}

export function registerReaderCloseGuard(flush: () => Promise<void>, onError: (error: unknown) => void): () => void {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return () => {};
  let disposed = false;
  let cleanup: (() => void) | undefined;
  void import("@tauri-apps/api/window")
    .then(({ getCurrentWindow }) => attachReaderCloseGuard(getCurrentWindow(), flush, onError))
    .then((unlisten) => { if (disposed) unlisten(); else cleanup = unlisten; })
    .catch(onError);
  return () => { disposed = true; cleanup?.(); };
}

export function clampReaderPage(pageNumber: number, totalPages: number): number {
  const upper = Math.max(1, Math.trunc(totalPages) || 1);
  const candidate = Number.isFinite(pageNumber) ? Math.trunc(pageNumber) : 1;
  return Math.max(1, Math.min(upper, candidate));
}

export function selectDominantReaderPage(
  candidates: Iterable<VisibleReaderPage>,
): number | null {
  let selected: VisibleReaderPage | null = null;
  for (const candidate of candidates) {
    if (candidate.visibleRatio <= 0) continue;
    if (
      !selected
      || candidate.visibleRatio > selected.visibleRatio
      || (
        candidate.visibleRatio === selected.visibleRatio
        && candidate.centerDistance < selected.centerDistance
      )
      || (
        candidate.visibleRatio === selected.visibleRatio
        && candidate.centerDistance === selected.centerDistance
        && candidate.pageNumber < selected.pageNumber
      )
    ) {
      selected = candidate;
    }
  }
  return selected?.pageNumber ?? null;
}
