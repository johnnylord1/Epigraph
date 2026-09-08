/** UI-owned capability. Restore services never import the reader component. */
export type ReaderPreparationResult = { ok: true } | {
  ok: false; code: "RESTORE_REFUSED_READER_NOT_FLUSHED"; reason: string;
};
export interface NovelReaderPreparation {
  prepareNovelReaderForRestore(): Promise<ReaderPreparationResult>;
}
type Prepare = () => Promise<ReaderPreparationResult>;
const refused = (reason: string): ReaderPreparationResult => ({ ok: false, code: "RESTORE_REFUSED_READER_NOT_FLUSHED", reason });
let registered: Prepare | null = null;

export function registerNovelReaderPreparation(prepare: Prepare) {
  if (registered) throw new Error("READER_PREPARATION_ALREADY_REGISTERED");
  registered = prepare;
  return () => { if (registered === prepare) registered = null; };
}
export function prepareNovelReaderForRestore(): Promise<ReaderPreparationResult> {
  return registered ? registered() : Promise.resolve(refused("application_unavailable"));
}

export function createNovelReaderPreparation(
  currentReader: () => NovelReaderPreparation | null,
  hasActiveReader: () => boolean,
): Prepare {
  let pending: Promise<ReaderPreparationResult> | null = null;
  let unresolved: NovelReaderPreparation | null = null;
  return () => {
    if (pending) return pending;
    const reader = currentReader();
    if (unresolved && reader !== unresolved) return Promise.resolve(refused("previous_reader_unresolved"));
    if (!reader) return Promise.resolve(hasActiveReader() ? refused("reader_not_mounted") : { ok: true });
    unresolved = reader;
    let request: Promise<ReaderPreparationResult>;
    try { request = reader.prepareNovelReaderForRestore(); }
    catch { request = Promise.resolve(refused("save_failed")); }
    pending = request.then(result => {
      if (!result || result.ok !== true) return result?.ok === false ? result : refused("invalid_acknowledgement");
      if (currentReader() && currentReader() !== reader) return refused("reader_changed");
      if (hasActiveReader()) return refused("reader_still_active");
      unresolved = null;
      return result;
    }, () => refused("save_failed")).finally(() => { pending = null; });
    return pending;
  };
}
