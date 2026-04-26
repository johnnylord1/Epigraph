<script lang="ts">
  import { onMount } from "svelte";
  import { emitTo, listen } from "@tauri-apps/api/event";
  import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

  import {
    createDefaultNovelRuntimeCapabilityProfile,
    isNovelRuntimeActionWhitelisted,
    type NovelRuntimeInvokeAction,
  } from "../../lib/novels/contracts";
  import {
    NOVEL_RUNTIME_HOST_CANCEL_EVENT,
    NOVEL_RUNTIME_HOST_INVOKE_EVENT,
    NOVEL_RUNTIME_HOST_LABEL,
    NOVEL_RUNTIME_HOST_READY_EVENT,
    NOVEL_RUNTIME_HOST_RESPONSE_EVENT,
    NOVEL_RUNTIME_HOST_SHUTDOWN_COMPLETE_EVENT,
    NOVEL_RUNTIME_HOST_SHUTDOWN_REQUEST_EVENT,
    type NovelRuntimeHostInvokeRequest,
    type NovelRuntimeHostResponse,
    type NovelRuntimeHostShutdownRequest,
  } from "../../lib/novels/runtimeHost";
  import {
    readNovelPluginChapter,
    readNovelPluginDetails,
    readNovelPluginFilters,
    readNovelPluginPopular,
    readNovelPluginSearch,
    readNovelPluginSettings,
    resolveNovelPluginRuntimeUrl,
  } from "../../lib/novels/pluginRuntime";

  type PluginBoundaryPayload = {
    pluginId: string;
    artifactUrl: string;
    pluginSource: string;
    settingsSeed?: Record<string, unknown> | null;
    webStorageSeed?: {
      localStorage?: unknown;
      sessionStorage?: unknown;
    } | null;
    url?: string;
    isNovel?: boolean;
    novelPath?: string;
    chapterPath?: string;
    searchTerm?: string;
    pageNo?: number;
    options?: Record<string, unknown>;
  };

  let hostStatus = $state<"booting" | "ready" | "stopping" | "error">("booting");
  let hostError = $state<string | null>(null);

  const capabilityProfile = createDefaultNovelRuntimeCapabilityProfile();
  const cancelledRequests = new Set<string>();
  const readyTargetLabel = new URLSearchParams(window.location.search).get("replyToLabel")?.trim() || "main";

  function createResponse(
    requestId: string,
    payload: unknown,
  ): NovelRuntimeHostResponse {
    return {
      requestId,
      ok: true,
      payload,
    };
  }

  function createErrorResponse(
    requestId: string,
    code: string,
    message: string,
  ): NovelRuntimeHostResponse {
    return {
      requestId,
      ok: false,
      error: { code, message },
    };
  }

  function normalizeRuntimeHostErrorMessage(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }
    if (typeof error === "string") {
      return error;
    }
    try {
      const serialized = JSON.stringify(error);
      if (serialized && serialized !== "{}") {
        return serialized;
      }
    } catch {}
    return String(error);
  }

  function assertNotCancelled(requestId: string) {
    if (cancelledRequests.has(requestId)) {
      throw new Error("Request cancelled.");
    }
  }

  async function disposeHost(
    currentWindow: ReturnType<typeof getCurrentWebviewWindow>,
    unlisteners: Array<() => void>,
    replyToLabel: string,
  ) {
    if (hostStatus === "stopping") {
      return;
    }

    hostStatus = "stopping";

    for (const stop of unlisteners.splice(0, unlisteners.length)) {
      stop();
    }

    cancelledRequests.clear();

    await emitTo(replyToLabel, NOVEL_RUNTIME_HOST_SHUTDOWN_COMPLETE_EVENT, {
      label: currentWindow.label || NOVEL_RUNTIME_HOST_LABEL,
      closedAtMs: Date.now(),
    });

    await currentWindow.destroy();
  }

  async function handleInvoke(
    request: NovelRuntimeHostInvokeRequest<PluginBoundaryPayload>,
  ): Promise<NovelRuntimeHostResponse> {
    if (!isNovelRuntimeActionWhitelisted(request.action)) {
      return createErrorResponse(request.requestId, "action_not_allowed", `Action ${request.action} is not whitelisted.`);
    }

    try {
      assertNotCancelled(request.requestId);

      switch (request.action as NovelRuntimeInvokeAction) {
        case "source.settings.read":
          return createResponse(request.requestId, readNovelPluginSettings(request.payload));
        case "source.filters.read":
          return createResponse(request.requestId, readNovelPluginFilters(request.payload));
        case "source.popular":
          return createResponse(request.requestId, await readNovelPluginPopular(request.payload));
        case "source.search":
          return createResponse(request.requestId, await readNovelPluginSearch({
            ...request.payload,
            searchTerm: typeof request.payload.searchTerm === "string" ? request.payload.searchTerm : "",
            pageNo: typeof request.payload.pageNo === "number" ? request.payload.pageNo : 1,
          }));
        case "source.details":
          return createResponse(request.requestId, await readNovelPluginDetails({
            ...request.payload,
            novelPath: request.payload.novelPath ?? "",
          }));
        case "source.chapter":
          return createResponse(request.requestId, await readNovelPluginChapter({
            ...request.payload,
            chapterPath: request.payload.chapterPath ?? "",
          }));
        case "source.resolve-url":
          return createResponse(request.requestId, await resolveNovelPluginRuntimeUrl({
            ...request.payload,
            url: request.payload.url ?? "/",
          }));
        default:
          return createErrorResponse(
            request.requestId,
            "not_implemented",
            `Action ${request.action} is not implemented in this runtime slice.`,
          );
      }
    } catch (error) {
      const message = normalizeRuntimeHostErrorMessage(error);
      return createErrorResponse(request.requestId, "runtime_error", message);
    } finally {
      cancelledRequests.delete(request.requestId);
    }
  }

  onMount(() => {
    const currentWindow = getCurrentWebviewWindow();
    const unlisteners: Array<() => void> = [];
    let disposed = false;

    const install = async () => {
      const stopInvoke = await listen<NovelRuntimeHostInvokeRequest<PluginBoundaryPayload>>(NOVEL_RUNTIME_HOST_INVOKE_EVENT, async (event) => {
        const request = event.payload;
        const replyToLabel = request.replyToLabel || "main";
        const response = await handleInvoke(request);
        await emitTo(replyToLabel, NOVEL_RUNTIME_HOST_RESPONSE_EVENT, response);
      });

      const stopCancel = await listen<{ requestId?: string | null }>(NOVEL_RUNTIME_HOST_CANCEL_EVENT, (event) => {
        const requestId = event.payload?.requestId?.trim();
        if (requestId) {
          cancelledRequests.add(requestId);
        }
      });

      const stopShutdown = await listen<NovelRuntimeHostShutdownRequest>(NOVEL_RUNTIME_HOST_SHUTDOWN_REQUEST_EVENT, async (event) => {
        if (disposed) {
          return;
        }
        disposed = true;
        const replyToLabel = event.payload?.replyToLabel?.trim() || readyTargetLabel;
        await disposeHost(currentWindow, unlisteners, replyToLabel);
      });

      unlisteners.push(stopInvoke, stopCancel, stopShutdown);

      hostStatus = "ready";
      await emitTo(readyTargetLabel, NOVEL_RUNTIME_HOST_READY_EVENT, {
        label: currentWindow.label || NOVEL_RUNTIME_HOST_LABEL,
        hostKind: "tauri-webview-window",
        startedAtMs: Date.now(),
        capabilityProfile,
      });
    };

    void install().catch((error) => {
      hostStatus = "error";
      hostError = error instanceof Error ? error.message : String(error);
      void emitTo(readyTargetLabel, NOVEL_RUNTIME_HOST_RESPONSE_EVENT, createErrorResponse(
        "startup",
        "host_startup_failed",
        hostError ?? "Novel runtime host startup failed.",
      ));
    });

    return () => {
      for (const stop of unlisteners.splice(0, unlisteners.length)) {
        stop();
      }
    };
  });
</script>

<div
  data-novel-runtime-host={NOVEL_RUNTIME_HOST_LABEL}
  data-status={hostStatus}
  data-capability-mode="minimal-whitelist"
  hidden
>
  {#if hostError}{hostError}{/if}
</div>
