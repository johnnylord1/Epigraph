import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Manga, Source } from "../../lib/types";
import type { MassMangaMigrationPreview, MassMangaMigrationPreviewItem } from "../../lib/migration/manga";
import type { ManagedExtension } from "../../lib/managedExtensions";

const { gqlMock, previewMock } = vi.hoisted(() => ({
  gqlMock: vi.fn(),
  previewMock: vi.fn(),
}));

vi.mock("../../lib/client", () => ({ gql: gqlMock }));

vi.mock("../../lib/queries", () => ({
  GET_CHAPTERS: "GET_CHAPTERS",
  GET_LIBRARY: "GET_LIBRARY",
  GET_SOURCES_WITH_EXTENSIONS: "GET_SOURCES_WITH_EXTENSIONS",
}));

vi.mock("../../lib/serverLifecycle", () => ({ ensureServerAwakeFor: vi.fn(async () => true) }));
vi.mock("../../lib/suwayomiReadiness", () => ({ waitForSuwayomiGraphqlReady: vi.fn(async () => true) }));
vi.mock("../../lib/discord", () => ({ setMigrationPresence: vi.fn() }));

vi.mock("../../lib/manga/sourceSearch", () => ({
  fetchSourceMangaSearchWithFallback: vi.fn(async () => []),
  isSourceMangaSearchUnavailableError: vi.fn(() => false),
  probeSourceMangaSearchCapability: vi.fn(async () => ({ status: "ok" })),
}));

vi.mock("../../lib/assets/serviceIconResolver", () => ({
  applyServiceIconFallback: vi.fn(),
  resolveServiceIconUrl: vi.fn(() => ""),
}));

vi.mock("../../lib/manga/coverResolver", () => ({ resolveMangaCoverUrl: vi.fn(() => "") }));

vi.mock("../../lib/migration/manga", () => ({
  applyMassMangaMigrationWithJournal: vi.fn(),
  buildMangaMigrationMatch: vi.fn(),
  previewMassMangaMigration: previewMock,
  undoMangaMigration: vi.fn(),
  updateMassMangaMigrationPreviewItem: vi.fn(),
}));

import MassMigrateModal from "./MassMigrateModal.svelte";

const extension = { pkgName: "pkg.origin", name: "Origin Scans", lang: "en" } as ManagedExtension;

function source(id: string, pkgName: string, displayName: string): Source {
  return { id, name: displayName, lang: "en", displayName, extension: { pkgName, name: displayName, lang: "en" } } as Source;
}

function manga(id: number, title: string): Manga {
  return { id, title, thumbnailUrl: "", inLibrary: true, sourceId: "origin", chapters: { totalCount: 3 } } as Manga;
}

function matched(current: Manga, title: string): MassMangaMigrationPreviewItem {
  return {
    currentManga: current,
    currentChapters: [],
    status: "matched",
    reasonCode: "matched",
    match: { manga: { ...current, id: current.id + 100, title }, chapters: [], similarity: 1 },
    matchedReadCount: 0,
    chapterDiff: null,
  } as unknown as MassMangaMigrationPreviewItem;
}

const works = [manga(1, "Solo Leveling"), manga(2, "Omniscient Reader")];

beforeEach(() => {
  gqlMock.mockImplementation(async (query: string) => {
    if (query === "GET_SOURCES_WITH_EXTENSIONS") {
      return { sources: { nodes: [source("origin", "pkg.origin", "Origin Scans"), source("target", "pkg.target", "Target Scans")] } };
    }
    if (query === "GET_LIBRARY") return { mangas: { nodes: works } };
    if (query === "GET_CHAPTERS") return { chapters: { nodes: [] } };
    throw new Error(`unexpected query ${query}`);
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("MassMigrateModal", () => {
  test("lists every work as a candidate and fills in each match as its search ends", async () => {
    let finishSecond!: () => void;
    previewMock.mockImplementation(async ({ onItemDone }: { onItemDone: (done: number, total: number, item: MassMangaMigrationPreviewItem) => void }) => {
      const first = matched(works[0]!, "Solo Leveling (Target)");
      onItemDone(1, 2, first);
      await new Promise<void>((resolve) => { finishSecond = resolve; });
      const second = matched(works[1]!, "Omniscient Reader (Target)");
      onItemDone(2, 2, second);
      return { items: [first, second] } as unknown as MassMangaMigrationPreview;
    });

    render(MassMigrateModal, { extension, onClose: vi.fn() });
    await fireEvent.click(await screen.findByRole("button", { name: /Target Scans/ }));

    const firstCard = await waitFor(() => {
      const card = document.querySelector<HTMLElement>('[data-migration-candidate="1"]');
      expect(card).not.toBeNull();
      expect(within(card!).getByText("Solo Leveling (Target)")).toBeTruthy();
      return card!;
    });
    expect(firstCard.classList.contains("is-pending")).toBe(false);

    const secondCard = document.querySelector<HTMLElement>('[data-migration-candidate="2"]')!;
    expect(secondCard.classList.contains("is-pending")).toBe(true);
    expect(within(secondCard).getByText("Omniscient Reader")).toBeTruthy();
    expect(screen.getByText("1/2")).toBeTruthy();
    // Nothing can be chosen or migrated until every search ends.
    expect(within(firstCard).getByRole("button", { name: /Solo Leveling/ }).hasAttribute("disabled")).toBe(true);

    finishSecond();
    await waitFor(() => {
      expect(within(secondCard).getByText("Omniscient Reader (Target)")).toBeTruthy();
      expect(secondCard.classList.contains("is-pending")).toBe(false);
    });
    // Once the whole preview is in, the live status gives way to the selection controls.
    await waitFor(() => expect(document.querySelector(".mg-live-status")).toBeNull());
    expect(document.querySelectorAll("[data-migration-candidate]")).toHaveLength(2);
  });
});
