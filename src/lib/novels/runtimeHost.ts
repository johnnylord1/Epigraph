import { invoke } from "@tauri-apps/api/core";
import { emitTo, listen } from "@tauri-apps/api/event";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { WebviewWindow, getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

import {
  createDefaultNovelRuntimeCapabilityProfile,
  isNovelRuntimeActionWhitelisted,
  type NovelCatalogEntry,
  type NovelRepositoryRecord,
  type NovelRuntimeCapabilityProfile,
  type NovelRuntimeHostAdapter,
  type NovelRuntimeHostKind,
  type NovelRuntimeInvokeAction,
} from "./contracts";

export const NOVEL_RUNTIME_HOST_LABEL = "novel-runtime-host";
export const NOVEL_RUNTIME_HOST_URL = "index.html?novelRuntimeHost=1";
export const NOVEL_RUNTIME_HOST_READY_EVENT = "novel-runtime-host:ready";
export const NOVEL_RUNTIME_HOST_INVOKE_EVENT = "novel-runtime-host:invoke";
export const NOVEL_RUNTIME_HOST_RESPONSE_EVENT = "novel-runtime-host:response";
export const NOVEL_RUNTIME_HOST_CANCEL_EVENT = "novel-runtime-host:cancel";
export const NOVEL_RUNTIME_HOST_SHUTDOWN_REQUEST_EVENT = "novel-runtime-host:shutdown-request";
export const NOVEL_RUNTIME_HOST_SHUTDOWN_COMPLETE_EVENT = "novel-runtime-host:shutdown-complete";
export const NOVEL_RUNTIME_HOST_START_TIMEOUT_MS = 12_000;
export const NOVEL_RUNTIME_HOST_REQUEST_TIMEOUT_MS = 15_000;
export const NOVEL_RUNTIME_HOST_STOP_TIMEOUT_MS = 5_000;

export interface NovelRuntimeHostReadyPayload {
  label: string;
  hostKind: NovelRuntimeHostKind;
  startedAtMs: number;
  capabilityProfile: NovelRuntimeCapabilityProfile;
}

export interface NovelRuntimeHostInvokeRequest<TPayload = unknown> {
  requestId: string;
  action: NovelRuntimeInvokeAction;
  payload: TPayload;
  replyToLabel: string;
}

export interface NovelRuntimeHostShutdownRequest {
  replyToLabel: string;
  requestedAtMs: number;
}

export interface NovelRuntimeHostShutdownCompletePayload {
  label: string;
  closedAtMs: number;
}

export interface NovelRuntimeHostResponse<TResult = unknown> {
  requestId: string;
  ok: boolean;
  payload?: TResult;
  error?: {
    code: string;
    message: string;
  };
}

export interface NovelRuntimeSmokeResult {
  ok: boolean;
  repositoryId: string;
  repositoryUrl: string;
  pluginId: string;
  pluginName: string | null;
  artifactUrl: string;
  startupConfirmed: boolean;
  shutdownConfirmed: boolean;
  detailsConfirmed: boolean;
  chapterConfirmed: boolean;
  detailsName: string | null;
  detailsChapterCount: number | null;
  detailsProbePath: string | null;
  chapterProbePath: string | null;
  chapterPreview: string | null;
  chapterContentLength: number | null;
  detailsSummaryPresent: boolean;
  controlledErrorMessage: string | null;
  health: NovelRuntimeHostReadyPayload;
  pluginSettingsKeys: string[];
  filterKeys: string[];
  observedAtMs: number;
}

const NOVEL_RUNTIME_SMOKE_DETAIL_PROBES = {
  "69shu": {
    novelPath: "/book/6644",
  },
  hotnovelpub: {
    novelPath: "shadow-slave",
  },
  fictionzone: {
    novelPath: "novel/shadow-slave",
  },
} as const;

function createRequestId(): string {
  return `novel-runtime-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getCurrentReplyTargetLabel(): string {
  return getCurrentWebviewWindow().label || "main";
}

function buildNovelRuntimeHostUrl(replyToLabel: string): string {
  const params = new URLSearchParams({
    novelRuntimeHost: "1",
    replyToLabel,
  });
  return `index.html?${params.toString()}`;
}

async function waitForHostWindowClosed(timeoutMs: number): Promise<boolean> {
  const startedAtMs = Date.now();

  while (Date.now() - startedAtMs < timeoutMs) {
    const isOpen = await invoke<boolean>("novel_runtime_host_is_open").catch(async () => {
      const existing = await WebviewWindow.getByLabel(NOVEL_RUNTIME_HOST_LABEL);
      return existing != null;
    });
    if (!isOpen) {
      return true;
    }

    await new Promise((resolve) => globalThis.setTimeout(resolve, 50));
  }

  return invoke<boolean>("novel_runtime_host_is_open")
    .then((isOpen) => !isOpen)
    .catch(async () => (await WebviewWindow.getByLabel(NOVEL_RUNTIME_HOST_LABEL)) == null);
}

async function waitForReadyEvent(timeoutMs: number): Promise<NovelRuntimeHostReadyPayload> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let stopListening: (() => void) | null = null;
    const timeoutId = globalThis.setTimeout(() => {
      settled = true;
      stopListening?.();
      reject(new Error("Novel runtime host did not report ready before timeout."));
    }, timeoutMs);

    void listen<NovelRuntimeHostReadyPayload>(NOVEL_RUNTIME_HOST_READY_EVENT, (event) => {
      if (settled) return;
      if (event.payload?.label !== NOVEL_RUNTIME_HOST_LABEL) return;
      settled = true;
      globalThis.clearTimeout(timeoutId);
      stopListening?.();
      resolve(event.payload);
    }).then((stop) => {
      stopListening = stop;
    }).catch((error) => {
      settled = true;
      globalThis.clearTimeout(timeoutId);
      reject(error);
    });
  });
}

async function waitForShutdownCompleteEvent(timeoutMs: number): Promise<NovelRuntimeHostShutdownCompletePayload> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let stopListening: (() => void) | null = null;
    const timeoutId = globalThis.setTimeout(() => {
      settled = true;
      stopListening?.();
      reject(new Error("Novel runtime host did not acknowledge shutdown before timeout."));
    }, timeoutMs);

    void listen<NovelRuntimeHostShutdownCompletePayload>(NOVEL_RUNTIME_HOST_SHUTDOWN_COMPLETE_EVENT, (event) => {
      if (settled) return;
      if (event.payload?.label !== NOVEL_RUNTIME_HOST_LABEL) return;
      settled = true;
      globalThis.clearTimeout(timeoutId);
      stopListening?.();
      resolve(event.payload);
    }).then((stop) => {
      stopListening = stop;
    }).catch((error) => {
      settled = true;
      globalThis.clearTimeout(timeoutId);
      reject(error);
    });
  });
}

function getNovelRuntimeSmokeDetailProbe(pluginId: string): { novelPath: string } | null {
  return NOVEL_RUNTIME_SMOKE_DETAIL_PROBES[pluginId as keyof typeof NOVEL_RUNTIME_SMOKE_DETAIL_PROBES] ?? null;
}

export class TauriNovelRuntimeHostAdapter implements NovelRuntimeHostAdapter {
  kind: NovelRuntimeHostKind = "tauri-webview-window";
  private windowHandle: WebviewWindow | null = null;
  private readyInfo: NovelRuntimeHostReadyPayload | null = null;
  private startPromise: Promise<void> | null = null;

  async start(): Promise<void> {
    if (this.readyInfo) {
      return;
    }
    if (this.startPromise) {
      return this.startPromise;
    }

    this.startPromise = this.startFresh();
    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  private async startFresh(): Promise<void> {
    const existing = await WebviewWindow.getByLabel(NOVEL_RUNTIME_HOST_LABEL);
    if (existing) {
      await existing.destroy().catch(() => {});
      await waitForHostWindowClosed(1_500);
    }

    const readyPromise = waitForReadyEvent(NOVEL_RUNTIME_HOST_START_TIMEOUT_MS);
    const replyToLabel = getCurrentReplyTargetLabel();
    const windowHandle = new WebviewWindow(NOVEL_RUNTIME_HOST_LABEL, {
      url: buildNovelRuntimeHostUrl(replyToLabel),
      visible: false,
      focus: false,
      skipTaskbar: true,
      title: "Novel Runtime Host",
      decorations: false,
      width: 360,
      height: 240,
    });

    windowHandle.once("tauri://error", (event) => {
      console.error("Novel runtime host creation error", event);
    }).catch(() => {});
    windowHandle.once("tauri://destroyed", () => {
      if (this.windowHandle?.label === windowHandle.label) {
        this.windowHandle = null;
      }
      this.readyInfo = null;
    }).catch(() => {});

    this.windowHandle = windowHandle;
    this.readyInfo = await readyPromise;
  }

  async stop(): Promise<void> {
    const existing = this.windowHandle ?? await WebviewWindow.getByLabel(NOVEL_RUNTIME_HOST_LABEL);
    this.windowHandle = null;
    this.readyInfo = null;
    if (!existing) {
      return;
    }

    const replyToLabel = getCurrentReplyTargetLabel();
    const shutdownAckPromise = waitForShutdownCompleteEvent(Math.floor(NOVEL_RUNTIME_HOST_STOP_TIMEOUT_MS / 2));
    const shutdownRequested = await emitTo(NOVEL_RUNTIME_HOST_LABEL, NOVEL_RUNTIME_HOST_SHUTDOWN_REQUEST_EVENT, {
      replyToLabel,
      requestedAtMs: Date.now(),
    } satisfies NovelRuntimeHostShutdownRequest).then(() => true, () => false);
    if (shutdownRequested) {
      await shutdownAckPromise.catch(() => null);
      const closedAfterHostShutdown = await waitForHostWindowClosed(Math.floor(NOVEL_RUNTIME_HOST_STOP_TIMEOUT_MS / 2));
      if (closedAfterHostShutdown) {
        return;
      }
    }

    const closedByBackend = await invoke("close_novel_runtime_host").then(
      async () => waitForHostWindowClosed(Math.floor(NOVEL_RUNTIME_HOST_STOP_TIMEOUT_MS / 2)),
      async () => false,
    );
    if (closedByBackend) {
      return;
    }

    await existing.close().catch(() => {});
    const closedAfterClose = await waitForHostWindowClosed(Math.floor(NOVEL_RUNTIME_HOST_STOP_TIMEOUT_MS / 2));
    if (closedAfterClose) {
      return;
    }

    await existing.destroy().catch(() => {});
    const closedAfterDestroy = await waitForHostWindowClosed(NOVEL_RUNTIME_HOST_STOP_TIMEOUT_MS);
    if (!closedAfterDestroy) {
      throw new Error("Novel runtime host did not close cleanly.");
    }
  }

  getReadyInfo(): NovelRuntimeHostReadyPayload | null {
    return this.readyInfo;
  }

  async invoke<TPayload = unknown, TResult = unknown>(action: NovelRuntimeInvokeAction, payload: TPayload): Promise<TResult> {
    if (!isNovelRuntimeActionWhitelisted(action)) {
      throw new Error(`Novel runtime action ${action} is not whitelisted.`);
    }

    await this.start();

    const requestId = createRequestId();
    return new Promise<TResult>((resolve, reject) => {
      let settled = false;
      let stopListening: (() => void) | null = null;
      const timeoutId = globalThis.setTimeout(() => {
        settled = true;
        stopListening?.();
        reject(new Error(`Novel runtime request ${action} timed out.`));
      }, NOVEL_RUNTIME_HOST_REQUEST_TIMEOUT_MS);

      void listen<NovelRuntimeHostResponse<TResult>>(NOVEL_RUNTIME_HOST_RESPONSE_EVENT, (event) => {
        if (settled) return;
        if (event.payload?.requestId !== requestId) return;
        settled = true;
        globalThis.clearTimeout(timeoutId);
        stopListening?.();

        if (!event.payload.ok) {
          reject(new Error(event.payload.error?.message ?? "Novel runtime request failed."));
          return;
        }

        resolve(event.payload.payload as TResult);
      }).then((stop) => {
        stopListening = stop;
        return emitTo(NOVEL_RUNTIME_HOST_LABEL, NOVEL_RUNTIME_HOST_INVOKE_EVENT, {
          requestId,
          action,
          payload,
          replyToLabel: getCurrentReplyTargetLabel(),
        } satisfies NovelRuntimeHostInvokeRequest<TPayload>);
      }).catch((error) => {
        settled = true;
        globalThis.clearTimeout(timeoutId);
        stopListening?.();
        reject(error);
      });
    });
  }

  async cancel(requestId: string): Promise<void> {
    await emitTo(NOVEL_RUNTIME_HOST_LABEL, NOVEL_RUNTIME_HOST_CANCEL_EVENT, { requestId });
  }

  async health(): Promise<{ ok: boolean; hostKind: NovelRuntimeHostKind }> {
    await this.start();
    return {
      ok: true,
      hostKind: this.kind,
    };
  }
}

async function fetchNovelPluginArtifactText(url: string): Promise<string> {
  const response = await tauriFetch(url, {
    method: "GET",
    headers: {
      Accept: "application/javascript,text/plain;q=0.9,*/*;q=0.8",
    },
  });

  if (!response.ok) {
    throw new Error(`Plugin artifact fetch failed with HTTP ${response.status}.`);
  }

  return response.text();
}

export async function runNovelRuntimeSmokeTest(input: {
  repository: NovelRepositoryRecord;
  catalogEntry: NovelCatalogEntry;
}): Promise<NovelRuntimeSmokeResult> {
  const host = new TauriNovelRuntimeHostAdapter();
  let smokeResult: Omit<NovelRuntimeSmokeResult, "shutdownConfirmed"> | null = null;
  let stopErrorMessage: string | null = null;

  try {
    await host.start();
    await host.health();

    const readyInfo = host.getReadyInfo() ?? {
      label: NOVEL_RUNTIME_HOST_LABEL,
      hostKind: host.kind,
      startedAtMs: Date.now(),
      capabilityProfile: createDefaultNovelRuntimeCapabilityProfile(),
    };

    const pluginSource = await fetchNovelPluginArtifactText(input.catalogEntry.artifactUrl);
    const settings = await host.invoke<{
      pluginId: string;
      artifactUrl: string;
      pluginSource: string;
    }, {
      name: string | null;
      pluginSettings: Record<string, unknown>;
      pluginSettingKeys: string[];
    }>("source.settings.read", {
      pluginId: input.catalogEntry.pluginId,
      artifactUrl: input.catalogEntry.artifactUrl,
      pluginSource,
    });

    const filters = await host.invoke<{
      pluginId: string;
      artifactUrl: string;
      pluginSource: string;
    }, {
      filterKeys: string[];
    }>("source.filters.read", {
      pluginId: input.catalogEntry.pluginId,
      artifactUrl: input.catalogEntry.artifactUrl,
      pluginSource,
    });

    const detailProbe = getNovelRuntimeSmokeDetailProbe(input.catalogEntry.pluginId);
    if (!detailProbe) {
      throw new Error(`Novel runtime smoke does not have a trusted details probe for ${input.catalogEntry.pluginId}.`);
    }

    let details: {
      name: string | null;
      chapterCount: number | null;
      novelPath: string;
      firstChapterPath: string | null;
      hasSummary: boolean;
    };
    try {
      details = await host.invoke<{
        pluginId: string;
        artifactUrl: string;
        pluginSource: string;
        novelPath: string;
      }, {
        name: string | null;
        chapterCount: number | null;
        novelPath: string;
        firstChapterPath: string | null;
        hasSummary: boolean;
      }>("source.details", {
        pluginId: input.catalogEntry.pluginId,
        artifactUrl: input.catalogEntry.artifactUrl,
        pluginSource,
        novelPath: detailProbe.novelPath,
      });
    } catch (error) {
      throw new Error(
        `Novel runtime details smoke failed for ${input.catalogEntry.pluginId} at ${detailProbe.novelPath}: ${normalizeErrorMessage(error)}`,
      );
    }

    let chapterResult: {
      chapterPath: string;
      contentLength: number;
      hasContent: boolean;
      preview: string | null;
    } | null = null;
    if (details.firstChapterPath) {
      try {
        chapterResult = await host.invoke<{
          pluginId: string;
          artifactUrl: string;
          pluginSource: string;
          chapterPath: string;
        }, {
          chapterPath: string;
          contentLength: number;
          hasContent: boolean;
          preview: string | null;
        }>("source.chapter", {
          pluginId: input.catalogEntry.pluginId,
          artifactUrl: input.catalogEntry.artifactUrl,
          pluginSource,
          chapterPath: details.firstChapterPath,
        });
      } catch (error) {
        throw new Error(
          `Novel runtime chapter smoke failed for ${input.catalogEntry.pluginId} at ${details.firstChapterPath}: ${normalizeErrorMessage(error)}`,
        );
      }
    }

    let controlledErrorMessage: string | null = null;
    try {
      await host.invoke("source.settings.read", {
        pluginId: `${input.catalogEntry.pluginId}.broken`,
        artifactUrl: input.catalogEntry.artifactUrl,
        pluginSource: "module.exports =",
      });
    } catch (error) {
      controlledErrorMessage = normalizeErrorMessage(error);
    }

    smokeResult = {
      ok: true,
      repositoryId: input.repository.id,
      repositoryUrl: input.repository.normalizedUrl,
      pluginId: input.catalogEntry.pluginId,
      pluginName: settings.name,
      artifactUrl: input.catalogEntry.artifactUrl,
      startupConfirmed: true,
      detailsConfirmed: Boolean(details.name) && typeof details.chapterCount === "number" && details.chapterCount > 0,
      chapterConfirmed: Boolean(chapterResult?.hasContent),
      detailsName: details.name,
      detailsChapterCount: details.chapterCount,
      detailsProbePath: details.novelPath,
      chapterProbePath: chapterResult?.chapterPath ?? details.firstChapterPath ?? null,
      chapterPreview: chapterResult?.preview ?? null,
      chapterContentLength: chapterResult?.contentLength ?? null,
      detailsSummaryPresent: details.hasSummary,
      controlledErrorMessage,
      health: readyInfo,
      pluginSettingsKeys: settings.pluginSettingKeys ?? Object.keys(settings.pluginSettings ?? {}),
      filterKeys: filters.filterKeys,
      observedAtMs: Date.now(),
    };
  } finally {
    await host.stop().catch((error) => {
      stopErrorMessage = normalizeErrorMessage(error);
    });
  }

  const shutdownConfirmed = await waitForHostWindowClosed(NOVEL_RUNTIME_HOST_STOP_TIMEOUT_MS);
  if (!smokeResult) {
    throw new Error("Novel runtime smoke test did not complete.");
  }
  if (!shutdownConfirmed) {
    throw new Error(stopErrorMessage ?? "Novel runtime host did not shut down cleanly.");
  }
  if (!smokeResult.detailsConfirmed) {
    throw new Error("Novel runtime details smoke did not return a valid details payload.");
  }
  if (!smokeResult.chapterConfirmed) {
    throw new Error("Novel runtime chapter smoke did not return readable chapter content.");
  }

  return {
    ...smokeResult,
    shutdownConfirmed,
  };
}
