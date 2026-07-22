import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  emitToMock,
  eventRegistry,
  tauriFetchMock,
  MockWebviewWindow,
  getCurrentWebviewWindowMock,
  invokeMock,
} = vi.hoisted(() => {
  const eventRegistry = new Map<string, Set<(event: { payload: unknown }) => void>>();

  const dispatch = (event: string, payload: unknown) => {
    for (const handler of eventRegistry.get(event) ?? []) {
      handler({ payload });
    }
  };

  const emitToMock = vi.fn(async (_target: string, event: string, payload: any) => {
    if (event === "novel-runtime-host:shutdown-request") {
      dispatch("novel-runtime-host:shutdown-complete", {
        label: "novel-runtime-host",
        closedAtMs: 456,
      });
      MockWebviewWindow.instances.delete("novel-runtime-host");
      return;
    }

    if (event !== "novel-runtime-host:invoke") {
      return;
    }

    if (payload.action === "source.settings.read") {
      if (String(payload.payload?.pluginSource ?? "").trim() === "module.exports =") {
        dispatch("novel-runtime-host:response", {
          requestId: payload.requestId,
          ok: false,
          error: {
            code: "runtime_error",
            message: "controlled parse failure",
          },
        });
        return;
      }

      dispatch("novel-runtime-host:response", {
        requestId: payload.requestId,
        ok: true,
        payload: {
          name: "Sample Plugin",
          pluginSettings: { hideLocked: { type: "Switch" } },
          pluginSettingKeys: ["hideLocked"],
        },
      });
      return;
    }

    if (payload.action === "source.filters.read") {
      dispatch("novel-runtime-host:response", {
        requestId: payload.requestId,
        ok: true,
        payload: {
          filterKeys: ["genre"],
        },
      });
      return;
    }

    if (payload.action === "source.details") {
      dispatch("novel-runtime-host:response", {
        requestId: payload.requestId,
        ok: true,
        payload: {
          name: "Shadow Slave",
          chapterCount: 2,
          novelPath: payload.payload?.novelPath ?? "/book/6644",
          firstChapterPath: "/book/6644/1.html",
          hasSummary: true,
        },
      });
      return;
    }

    if (payload.action === "source.chapter") {
      dispatch("novel-runtime-host:response", {
        requestId: payload.requestId,
        ok: true,
        payload: {
          chapterPath: payload.payload?.chapterPath ?? "/book/6644/1.html",
          contentLength: 128,
          hasContent: true,
          preview: "Chapter 1 content",
        },
      });
    }
  });

  const tauriFetchMock = vi.fn(async () => ({
    ok: true,
    status: 200,
    text: async () => "exports.default = { name: 'Sample Plugin', filters: { genre: {} }, pluginSettings: { hideLocked: {} } };",
  }));

  const invokeMock = vi.fn(async (command: string) => {
    if (command === "novel_runtime_host_is_open") {
      return MockWebviewWindow.instances.has("novel-runtime-host");
    }
    if (command === "close_novel_runtime_host") {
      MockWebviewWindow.instances.delete("novel-runtime-host");
      return null;
    }
    throw new Error(`Unknown invoke command in test: ${command}`);
  });

  class MockWebviewWindow {
    static instances = new Map<string, MockWebviewWindow>();
    static createdCount = 0;
    label: string;
    options?: Record<string, unknown>;

    constructor(label: string, options?: Record<string, unknown>) {
      this.label = label;
      this.options = options;
      MockWebviewWindow.createdCount += 1;
      MockWebviewWindow.instances.set(label, this);
      setTimeout(() => {
        dispatch("novel-runtime-host:ready", {
          label,
          hostKind: "tauri-webview-window",
          startedAtMs: 123,
          capabilityProfile: {
            hostKind: "tauri-webview-window",
            invokeWhitelist: [
              "source.popular",
              "source.search",
              "source.details",
              "source.chapter",
              "source.filters.read",
              "source.settings.read",
              "source.resolve-url",
            ],
            supportsCancel: true,
            supportsHealth: true,
          },
        });
      }, 0);
    }

    static async getByLabel(label: string) {
      return MockWebviewWindow.instances.get(label) ?? null;
    }

    async destroy() {
      MockWebviewWindow.instances.delete(this.label);
    }

    async close() {
      MockWebviewWindow.instances.delete(this.label);
    }

    async once() {
      return () => {};
    }
  }

  const getCurrentWebviewWindowMock = vi.fn(() => ({
    label: "app-shell",
  }));

  return {
    emitToMock,
    eventRegistry,
    tauriFetchMock,
    MockWebviewWindow,
    getCurrentWebviewWindowMock,
    invokeMock,
  };
});

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (event: string, handler: (event: { payload: unknown }) => void) => {
    const bucket = eventRegistry.get(event) ?? new Set<(event: { payload: unknown }) => void>();
    bucket.add(handler);
    eventRegistry.set(event, bucket);
    return () => {
      bucket.delete(handler);
    };
  }),
  emitTo: emitToMock,
}));

vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: tauriFetchMock,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

vi.mock("@tauri-apps/api/webviewWindow", () => ({
  WebviewWindow: MockWebviewWindow,
  getCurrentWebviewWindow: getCurrentWebviewWindowMock,
}));

import { TauriNovelRuntimeHostAdapter, runNovelRuntimeSmokeTest } from "./runtimeHost";

describe("novel runtime host", () => {
  beforeEach(() => {
    emitToMock.mockClear();
    tauriFetchMock.mockClear();
    getCurrentWebviewWindowMock.mockClear();
    invokeMock.mockClear();
    eventRegistry.clear();
    MockWebviewWindow.instances.clear();
    MockWebviewWindow.createdCount = 0;
  });

  it("boots the hidden host and sends whitelisted invoke requests across the boundary", async () => {
    const host = new TauriNovelRuntimeHostAdapter();
    await host.start();

    const result = await host.invoke("source.settings.read", {
      pluginId: "sample.plugin",
      artifactUrl: "https://example.com/plugin.js",
      pluginSource: "exports.default = {};",
    });

    expect(result).toMatchObject({
      name: "Sample Plugin",
      pluginSettingKeys: ["hideLocked"],
    });
    expect(getCurrentWebviewWindowMock).toHaveBeenCalled();
    expect(emitToMock).toHaveBeenCalledWith(
      "novel-runtime-host",
      "novel-runtime-host:invoke",
      expect.objectContaining({
        replyToLabel: "app-shell",
      }),
    );

    await host.stop();
    expect(await MockWebviewWindow.getByLabel("novel-runtime-host")).toBeNull();
  });

  it("rejects the retired settings write action before starting the hidden host", async () => {
    const host = new TauriNovelRuntimeHostAdapter();

    await expect(
      host.invoke("source.settings.write" as never, {
        pluginId: "sample.plugin",
        values: { hideLocked: true },
      }),
    ).rejects.toThrow("Novel runtime action source.settings.write is not whitelisted.");

    expect(MockWebviewWindow.createdCount).toBe(0);
    expect(emitToMock).not.toHaveBeenCalled();
  });

  it("serializes concurrent startup requests for the hidden host", async () => {
    const host = new TauriNovelRuntimeHostAdapter();

    await Promise.all([
      host.start(),
      host.start(),
      host.health(),
    ]);

    expect(MockWebviewWindow.createdCount).toBe(1);
    expect(await MockWebviewWindow.getByLabel("novel-runtime-host")).not.toBeNull();

    await host.stop();
  });

  it("runs a smoke summary across startup, invoke, controlled error, and shutdown", async () => {
    const result = await runNovelRuntimeSmokeTest({
      repository: {
        id: "repo-1",
        profileId: "test",
        url: "https://example.com/plugins.min.json",
        normalizedUrl: "https://example.com/plugins.min.json",
        recommendedSeed: false,
        trustState: "trusted",
        enabled: true,
        lastFetchedAtMs: null,
        lastSuccessAtMs: null,
        etag: null,
        lastModified: null,
        lastError: null,
      },
      catalogEntry: {
        repositoryId: "repo-1",
        pluginId: "69shu",
        name: "69shu",
        site: "Example",
        lang: "en",
        version: "1.0.0",
        artifactUrl: "https://example.com/plugin.js",
        iconUrl: null,
        customJsUrl: null,
        customCssUrl: null,
        manifestHash: null,
        fetchedAtMs: 1,
      },
    });

    expect(result.ok).toBe(true);
    expect(result.startupConfirmed).toBe(true);
    expect(result.shutdownConfirmed).toBe(true);
    expect(result.detailsConfirmed).toBe(true);
    expect(result.chapterConfirmed).toBe(true);
    expect(result.detailsName).toBe("Shadow Slave");
    expect(result.detailsChapterCount).toBe(2);
    expect(result.detailsProbePath).toBe("/book/6644");
    expect(result.chapterProbePath).toBe("/book/6644/1.html");
    expect(result.chapterContentLength).toBe(128);
    expect(result.chapterPreview).toBe("Chapter 1 content");
    expect(result.controlledErrorMessage).toContain("controlled parse failure");
    expect(result.pluginSettingsKeys).toEqual(["hideLocked"]);
    expect(result.filterKeys).toEqual(["genre"]);
  });
});
