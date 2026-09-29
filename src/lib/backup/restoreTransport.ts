import { getServerAuthHeader, getServerUrl } from "../client";
import { store } from "../../store/state.svelte";
import { canonicalRestoreJson, RestoreError, type RestoreTarget } from "./restoreOperation";
import type { RestoreTransport, SuwayomiRestoreStatus } from "./restoreRuntime";

const submitQuery = `mutation RestoreBackup($backup: Upload!, $clientMutationId: String!) {
  restoreBackup(input: { backup: $backup, clientMutationId: $clientMutationId }) {
    clientMutationId id status { state mangaProgress totalManga }
  }
}`;
const statusQuery = `query RestoreStatus($id: String!) {
  restoreStatus(id: $id) { state mangaProgress totalManga }
}`;

/** Only used inside an admitted restore. No generic mutation lease or retry loop. */
export function createProductionRestoreTransport(options: {
  file: File;
  target: RestoreTarget;
  validateAdmission(): Promise<RestoreTarget | null>;
}): RestoreTransport {
  const target = structuredClone(options.target);
  const url = `${getServerUrl()}/api/graphql`;
  const authorization = getServerAuthHeader();
  const profile = store.runtimeResolvedLocalProfileId;
  function assertCurrent() {
    if (url !== `${getServerUrl()}/api/graphql` || authorization !== getServerAuthHeader()
      || profile !== store.runtimeResolvedLocalProfileId || profile !== target.profileId) {
      throw new RestoreError("RESTORE_CONNECTION_CHANGED");
    }
  }
  async function validate() {
    assertCurrent();
    const current = await options.validateAdmission();
    assertCurrent();
    if (!current || canonicalRestoreJson(current) !== canonicalRestoreJson(target)) throw new RestoreError("RESTORE_TARGET_CHANGED");
    return current;
  }
  async function request<T>(body: BodyInit, json: boolean): Promise<T> {
    await validate();
    assertCurrent();
    // Exactly one fetch invocation. A rejected response is not proof of nonacceptance.
    const response = await fetch(url, { method: "POST", body,
      headers: { ...(json ? { "Content-Type": "application/json" } : {}), ...(authorization ? { Authorization: authorization } : {}) } });
    assertCurrent();
    if (!response.ok) throw new RestoreError("RESTORE_HTTP_RESPONSE_UNCERTAIN");
    const result = await response.json();
    assertCurrent();
    if (!result || result.errors?.length || !result.data) throw new RestoreError("RESTORE_GRAPHQL_RESPONSE_UNCERTAIN");
    return result.data as T;
  }
  return {
    async generation() {
      try { return (await validate()).backendGeneration; } catch { return null; }
    },
    async send(intent) {
      if (canonicalRestoreJson(intent.target) !== canonicalRestoreJson(target)) throw new RestoreError("RESTORE_TARGET_CHANGED");
      // This cutover preserves the existing full-backup selection. Unknown partial
      // flags are refused before fetch rather than silently ignored.
      if (Object.keys(intent.flags).length) throw new RestoreError("RESTORE_FLAGS_UNSUPPORTED");
      const form = new FormData();
      form.append("operations", JSON.stringify({ query: submitQuery, variables: { backup: null, clientMutationId: intent.clientMutationId } }));
      form.append("map", JSON.stringify({ "0": ["variables.backup"] }));
      form.append("0", options.file);
      const result = await request<{ restoreBackup: Awaited<ReturnType<RestoreTransport["send"]>> }>(form, false);
      return result.restoreBackup;
    },
    async status(id) {
      const result = await request<{ restoreStatus: SuwayomiRestoreStatus | null }>(JSON.stringify({ query: statusQuery, variables: { id } }), true);
      return result.restoreStatus ?? null;
    },
  };
}
