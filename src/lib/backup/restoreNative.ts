import { invoke } from "@tauri-apps/api/core";
import { createRestoreJournal } from "./restoreJournal";
import { RestoreError, type RestoreInput, type RestoreRecord, type RestoreTarget } from "./restoreOperation";

interface JournalRead { contents: string; sha256: string }
export async function openNativeRestoreContext(profileId: string, serverUrl: string) {
  const context = await invoke<{ contextId: string; target: RestoreTarget }>("restore_context", { profileId, serverUrl });
  const { contextId, target } = context;
  if (!contextId || !target || target.profileId !== profileId) throw new RestoreError("RESTORE_CONTEXT_UNAVAILABLE");
  const admissions = new Map<string, string>();
  const raw = (operationId: string) => invoke<JournalRead | null>("restore_journal_read", { contextId, operationId });
  const journal = createRestoreJournal({
    async read(operationId) { return (await raw(operationId))?.contents ?? null; },
    async compareAndSwap(operationId, expectedDigest, next) {
      await invoke("restore_journal_cas", { contextId, operationId, expectedSha256: expectedDigest, contents: next });
    },
  });
  return {
    target, journal,
    async settleTerminal(operationId: string) {
      const current = await raw(operationId);
      if (!current) throw new RestoreError("RESTORE_NOT_FOUND");
      await invoke("restore_operation_settle_terminal", { contextId, operationId, expectedSha256: current.sha256 });
    },
    async putInput(file: File, input: RestoreInput) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = "";
      for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
      await invoke("restore_input_put", { contextId, digest: input.digest, size: input.size, base64: btoa(binary) });
    },
    async readInput(operationId: string, input: RestoreInput, name: string) {
      const encoded = await invoke<string>("restore_input_read", { contextId, operationId, digest: input.digest });
      const bytes = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0));
      if (bytes.length !== input.size) throw new RestoreError("RESTORE_INPUT_CHANGED");
      return new File([bytes], name);
    },
    async list() {
      const entries = await invoke<JournalRead[]>("restore_journal_list", { contextId });
      const records: RestoreRecord[] = [];
      for (const entry of entries) {
        const id: unknown = JSON.parse(entry.contents)?.payload?.operationId;
        if (typeof id !== "string") throw new RestoreError("JOURNAL_CORRUPT");
        const record = await journal.read(id);
        if (!record) throw new RestoreError("JOURNAL_CONFLICT");
        records.push(record);
      }
      return records;
    },
    async admit(_target: RestoreTarget, operationId: string) {
      const record = await journal.read(operationId);
      if (!record) throw new RestoreError("RESTORE_NOT_FOUND");
      if (record.phase === "completed" || record.phase === "cancelled") return async () => {};
      const current = await raw(operationId);
      if (!current) throw new RestoreError("RESTORE_NOT_FOUND");
      const admitted = await invoke<{ token: string; reconciliationOnly: boolean }>("restore_operation_admit", { contextId, operationId, expectedSha256: current.sha256 });
      admissions.set(operationId, admitted.token);
      return async () => {
        const current = await raw(operationId);
        if (!current) throw new RestoreError("RESTORE_NOT_FOUND");
        // Native retains unresolved ownership even after the executor returns.
        await invoke("restore_operation_settle", { contextId, operationId, token: admitted.token, expectedSha256: current.sha256 });
        admissions.delete(operationId);
      };
    },
    async validateTarget(operationId: string) {
      const token = admissions.get(operationId);
      if (!token) {
        const record = await journal.read(operationId);
        if (record?.phase === "completed" || record?.phase === "cancelled") return record.target;
        throw new RestoreError("RESTORE_NOT_ADMITTED");
      }
      const result = await invoke<{ matches: boolean; currentTarget: RestoreTarget }>("restore_operation_validate", { contextId, operationId, token });
      return result.matches ? result.currentTarget : null;
    },
  };
}
