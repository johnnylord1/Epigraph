import { addToast, dismissToast, setRuntimeSettingsTab, setSettingsOpen } from "../store/state.svelte";
import { translate } from "./i18n/runtime";
import { checkSuwayomiRuntimeUpdate, type SuwayomiUpdateCheckResult } from "./suwayomiRuntimeUpdate";

const SUWAYOMI_UPDATE_TOAST_ID = "suwayomi-compatible-update";

type RefreshOptions = {
  notify?: boolean;
};

class SuwayomiUpdateUxState {
  lastCheck: SuwayomiUpdateCheckResult | null = $state(null);
  lastCheckedAt: number | null = $state(null);
  dismissedToastVersion: string | null = $state(null);
  checking = $state(false);

  updateAvailable = $derived(this.lastCheck?.status === "updateAvailable");
  latestVersion = $derived(this.lastCheck?.latestCompatibleVersion ?? null);
}

export const suwayomiUpdateUx = new SuwayomiUpdateUxState();

export function openSuwayomiUpdateSettings() {
  setRuntimeSettingsTab("about");
  setSettingsOpen(true);
}

export function dismissSuwayomiUpdateToast() {
  suwayomiUpdateUx.dismissedToastVersion = suwayomiUpdateUx.latestVersion;
  dismissToast(SUWAYOMI_UPDATE_TOAST_ID);
}

export function clearSuwayomiUpdateUx() {
  suwayomiUpdateUx.lastCheck = null;
  suwayomiUpdateUx.lastCheckedAt = null;
  dismissToast(SUWAYOMI_UPDATE_TOAST_ID);
}

export function recordSuwayomiUpdateCheck(result: SuwayomiUpdateCheckResult, options: RefreshOptions = {}) {
  suwayomiUpdateUx.lastCheck = result;
  suwayomiUpdateUx.lastCheckedAt = Date.now();

  if (result.status !== "updateAvailable" || !result.latestCompatibleVersion || !result.updateAllowed) {
    dismissToast(SUWAYOMI_UPDATE_TOAST_ID);
    return;
  }

  if (options.notify && suwayomiUpdateUx.dismissedToastVersion !== result.latestCompatibleVersion) {
    addToast({
      id: SUWAYOMI_UPDATE_TOAST_ID,
      kind: "info",
      title: translate("suwayomi.update.toastTitle"),
      body: translate("suwayomi.update.toastBody", {
        current: result.currentVersion ?? translate("suwayomi.update.unknown"),
        next: result.latestCompatibleVersion,
      }),
      duration: 0,
      actions: [
        { label: translate("suwayomi.update.updateNow"), run: openSuwayomiUpdateSettings },
        { label: translate("suwayomi.update.remindLater"), run: dismissSuwayomiUpdateToast },
      ],
    });
  }
}

export async function refreshSuwayomiUpdateUx(options: RefreshOptions = {}) {
  suwayomiUpdateUx.checking = true;
  try {
    const result = await checkSuwayomiRuntimeUpdate();
    recordSuwayomiUpdateCheck(result, options);
    return result;
  } finally {
    suwayomiUpdateUx.checking = false;
  }
}
