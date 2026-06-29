import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Manga } from "../../lib/types";

const {
  gqlMock,
  ensureServerAwakeForMock,
  waitForSuwayomiGraphqlReadyMock,
} = vi.hoisted(() => ({
  gqlMock: vi.fn(),
  ensureServerAwakeForMock: vi.fn(async () => true),
  waitForSuwayomiGraphqlReadyMock: vi.fn(async () => true),
}));

vi.mock("../../lib/client", () => ({
  gql: gqlMock,
}));

vi.mock("../../lib/queries", () => ({
  GET_SOURCES: "GET_SOURCES",
  FETCH_CHAPTERS: "FETCH_CHAPTERS",
  GET_CHAPTERS: "GET_CHAPTERS",
  GET_LIBRARY: "GET_LIBRARY",
}));

vi.mock("../../lib/serverLifecycle", () => ({
  ensureServerAwakeFor: ensureServerAwakeForMock,
}));

vi.mock("../../lib/suwayomiReadiness", () => ({
  waitForSuwayomiGraphqlReady: waitForSuwayomiGraphqlReadyMock,
}));

vi.mock("../../lib/manga/sourceSearch", () => ({
  fetchSourceMangaSearchWithFallback: vi.fn(async () => []),
}));

vi.mock("../../lib/assets/serviceIconResolver", () => ({
  applyServiceIconFallback: vi.fn(),
  resolveServiceIconUrl: vi.fn(() => ""),
}));

vi.mock("../../lib/manga/coverResolver", () => ({
  resolveMangaCoverUrl: vi.fn(() => ""),
}));

vi.mock("../../lib/migration/manga", () => ({
  applyMangaMigrationWithJournal: vi.fn(),
  applyMassMangaMigrationWithJournal: vi.fn(),
  previewMassMangaMigration: vi.fn(),
  undoMangaMigration: vi.fn(),
}));

vi.mock("../../store/state.svelte", async () => {
  const actual = await vi.importActual<typeof import("../../store/state.svelte")>("../../store/state.svelte");
  return {
    ...actual,
    addToast: vi.fn(),
    store: {
      ...actual.store,
      settings: {
        ...actual.store.settings,
        preferredExtensionLang: "en",
        serverUrl: "http://127.0.0.1:4567",
        serverBinary: null,
        libraryUpdateIntensity: "medium",
      },
      runtimeResolvedLocalProfileId: "main",
      runtimeResolvedLocalProfileMeta: { label: "MAIN" },
      runtimeServerLabel: "MAIN",
      runtimeServerUrl: "http://127.0.0.1:4567",
    },
  };
});

import MigrateModal from "./MigrateModal.svelte";

const manga: Manga = {
  id: 1,
  title: "Dangerous Dungeon Escape",
  thumbnailUrl: "",
  inLibrary: true,
  source: {
    id: "current-src",
    name: "current",
    lang: "en",
    displayName: "Current Source",
  },
};

describe("MigrateModal", () => {
  beforeEach(() => {
    gqlMock.mockReset();
    ensureServerAwakeForMock.mockClear();
    waitForSuwayomiGraphqlReadyMock.mockReset();
    waitForSuwayomiGraphqlReadyMock.mockResolvedValue(true);
  });

  afterEach(() => cleanup());

  test("shows retry on source load failure and lists installed alternatives after retry", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      gqlMock
        .mockRejectedValueOnce(new Error("Database may be already in use"))
        .mockResolvedValueOnce({
          sources: {
            nodes: [
              { id: "0", name: "local", displayName: "Local source", lang: "en", iconUrl: "", isNsfw: false },
              { id: "current-src", name: "current", displayName: "Current Source", lang: "en", iconUrl: "", isNsfw: false },
              { id: "asura-src", name: "asura", displayName: "Asura Scans", lang: "en", iconUrl: "", isNsfw: false },
            ],
          },
        });

      render(MigrateModal, {
        props: {
          manga,
          currentChapters: [],
          onClose: vi.fn(),
          onMigrated: vi.fn(),
        },
      });

      await waitFor(() => {
        expect(screen.getByText("Database may be already in use")).toBeTruthy();
      });
      expect(screen.queryByText("No other sources installed.")).toBeNull();

      await fireEvent.click(screen.getByRole("button", { name: /refresh/i }));

      await waitFor(() => {
        expect(screen.getByText("Asura Scans")).toBeTruthy();
      });
      expect(screen.queryByText("Current Source")).toBeNull();
      expect(screen.queryByText("Local source")).toBeNull();
    } finally {
      errorSpy.mockRestore();
    }
  });
});
