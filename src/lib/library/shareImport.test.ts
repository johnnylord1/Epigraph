import { describe, expect, test, vi } from "vitest";
import {
  analyzeShareImport,
  applyShareImport,
  installShareImportExtension,
  searchAllMissingWorksInInstalledSources,
  searchWorkInInstalledSources,
} from "./shareImport";
import { buildShareManifest } from "./shareLink";
import type { Manga } from "../types";

describe("shareImport analysis, extension auto-repo install, installed search, and import", () => {
  test("detects duplicates, installed sources, available extensions, needs_repo, and unavailable", async () => {
    const manifest = buildShareManifest([
      {
        title: "Already Owned",
        sourceId: "100",
        url: "/manga/owned",
        sourceName: "InstalledSource",
      },
      {
        title: "Owned Elsewhere",
        sourceId: "100",
        url: "/manga/elsewhere",
        sourceName: "InstalledSource",
      },
      {
        title: "New Ready",
        sourceId: "100",
        url: "/manga/new-ready",
        sourceName: "InstalledSource",
      },
      {
        title: "Needs Repo Work",
        sourceId: "200",
        url: "/manga/needs-repo",
        sourceName: "CustomScan",
        extensionPkgName: "eu.kanade.tachiyomi.extension.en.customscan",
        repoUrl: "https://raw.githubusercontent.com/keiyoushi/extensions/repo/index.min.json",
      },
      {
        title: "Local File",
        sourceId: "0",
        url: "/local/x",
      },
    ]);

    const plan = await analyzeShareImport(manifest, {
      loadInventory: async () => ({
        inventory: [
          {
            sourceId: "100",
            name: "InstalledSource",
            lang: "en",
            displayName: "InstalledSource",
            kind: "installed",
            extensionPkgName: "eu.kanade.ext.installed",
            extensionName: "InstalledSource",
            extensionInstalled: true,
          },
        ],
        availableExtensions: [],
        warnings: [],
        repoUrls: [],
      }),
      loadLibraryEntries: async () => [
        { sourceId: "100", sourceName: "InstalledSource", url: "/manga/owned", title: "Already Owned" },
        { sourceId: "555", sourceName: "MangaFire", url: "/manga/owned-elsewhere", title: "Owned Elsewhere" },
      ],
      loadCategories: async () => [],
    });

    expect(plan.works[0]).toMatchObject({ title: "Already Owned", alreadyInLibrary: true, selected: false });
    expect(plan.works[1]).toMatchObject({
      title: "Owned Elsewhere",
      alreadyInLibrary: false,
      ownedInOtherSource: { sourceName: "MangaFire", title: "Owned Elsewhere" },
      extensionStatus: "installed",
      selected: false,
    });
    expect(plan.works[2]).toMatchObject({ title: "New Ready", alreadyInLibrary: false, ownedInOtherSource: null, extensionStatus: "installed", selected: true });
    expect(plan.works[3]).toMatchObject({ title: "Needs Repo Work", alreadyInLibrary: false, extensionStatus: "needs_repo", selected: false });
    expect(plan.works[4]).toMatchObject({ title: "Local File", isLocal: true, selected: false });

    const needsRepoExt = plan.extensions.find((ext) => ext.sourceId === "200");
    expect(needsRepoExt).toMatchObject({
      status: "needs_repo",
      repoLabel: "keiyoushi",
      repoUrl: "https://raw.githubusercontent.com/keiyoushi/extensions/repo/index.min.json",
    });
  });

  test("automatically adds the missing repository before installing the extension", async () => {
    const addStore = vi.fn(async () => undefined);
    const installByPkg = vi.fn(async () => undefined);
    const result = await installShareImportExtension(
      {
        sourceId: "200",
        sourceName: "CustomScan",
        lang: "en",
        pkgName: "eu.kanade.tachiyomi.extension.en.customscan",
        extensionName: "CustomScan",
        repoUrl: "https://raw.githubusercontent.com/keiyoushi/extensions/repo/index.min.json",
        repoLabel: "keiyoushi",
        status: "needs_repo",
        workCount: 2,
      },
      {
        addStore,
        loadInventory: async () => ({
          inventory: [],
          availableExtensions: [
            {
              apkName: "customscan.apk",
              pkgName: "eu.kanade.tachiyomi.extension.en.customscan",
              name: "CustomScan",
              lang: "en",
              versionName: "1.0",
              isInstalled: false,
              isObsolete: false,
              hasUpdate: false,
              iconUrl: "",
              repoSources: [{ sourceId: "200", sourceName: "CustomScan", lang: "en", extensionPkgName: "eu.kanade.tachiyomi.extension.en.customscan", extensionName: "CustomScan" }],
            },
          ],
          warnings: [],
          repoUrls: ["https://raw.githubusercontent.com/keiyoushi/extensions/repo/index.min.json"],
        }),
        installByPkg,
      },
    );

    expect(addStore).toHaveBeenCalledWith("https://raw.githubusercontent.com/keiyoushi/extensions/repo/index.min.json");
    expect(installByPkg).toHaveBeenCalledWith("eu.kanade.tachiyomi.extension.en.customscan");
    expect(result).toEqual({ installed: true, pkgName: "eu.kanade.tachiyomi.extension.en.customscan" });
  });

  test("searches installed extensions individually and in batch using TitleMatcher ranking", async () => {
    const installedSources = [
      { id: "10", name: "MangaDex", displayName: "MangaDex (EN)", lang: "en" },
      { id: "20", name: "Comick", displayName: "Comick (EN)", lang: "en" },
    ];
    const search = vi.fn(async ({ sourceId }: { sourceId: string; query: string }): Promise<Manga[]> => {
      if (sourceId === "10") {
        return [
          { id: 101, title: "Solo Leveling", thumbnailUrl: "", inLibrary: false },
          { id: 103, title: "Solo Leveling", thumbnailUrl: "", inLibrary: true },
          { id: 102, title: "Unrelated Romance", thumbnailUrl: "", inLibrary: false },
        ];
      }
      return [{ id: 201, title: "Solo Leveling: Side Story", thumbnailUrl: "", inLibrary: false }];
    });

    const matches = await searchWorkInInstalledSources("Solo Leveling", installedSources, { search });
    expect(matches.map((m) => m.mangaId)).toEqual([101, 201]);
    expect(matches[0]!.similarity).toBe(1);

    const updates: Record<string, number> = {};
    await searchAllMissingWorksInInstalledSources(
      [
        {
          key: "w1",
          title: "Solo Leveling",
          sourceId: "999",
          sourceName: "Missing",
          url: "/manga/solo",
          isLocal: false,
          alreadyInLibrary: false,
          ownedInOtherSource: null,
          extensionStatus: "unavailable",
          selected: false,
          searching: false,
          searchDone: false,
          candidates: [],
          chosenAlternative: null,
        },
      ],
      installedSources,
      (key, state) => {
        if (!state.searching && state.candidates) updates[key] = state.candidates.length;
      },
      { search },
    );
    expect(updates.w1).toBe(2);
  });

  test.each([
    { label: "without folders", selected: [], expected: [] },
    { label: "with multiple folders", selected: [3, 5, 3, 0], expected: [3, 5] },
  ])("imports original and alternative works $label", async ({ selected, expected }) => {
    const updateManga = vi.fn(async () => undefined);
    const restoreBackup = vi.fn(async () => undefined);
    const request = vi.fn(async (query: string, _variables?: Record<string, unknown>) => {
      if (query.includes("EpigraphRestoreParityCategoryOrder")) return { categories: { nodes: [] } };
      if (query.includes("EpigraphRestoreParityTitles")) return { mangas: { pageInfo: { hasNextPage: false }, nodes: [] } };
      if (query.includes("ShareImportFindMangas")) {
        return { mangas: { pageInfo: { hasNextPage: false }, nodes: [{ id: 55, sourceId: "100", url: "/manga/orig" }] } };
      }
      return {};
    });

    const result = await applyShareImport(
      [
        {
          key: "orig",
          title: "Original Source Work",
          sourceId: "100",
          sourceName: "Src",
          url: "/manga/orig",
          isLocal: false,
          alreadyInLibrary: false,
          ownedInOtherSource: null,
          extensionStatus: "installed",
          selected: true,
          searching: false,
          searchDone: false,
          candidates: [],
          chosenAlternative: null,
        },
        {
          key: "alt",
          title: "Found Elsewhere",
          sourceId: "999",
          sourceName: "Missing",
          url: "/manga/alt",
          isLocal: false,
          alreadyInLibrary: false,
          ownedInOtherSource: null,
          extensionStatus: "unavailable",
          selected: true,
          searching: false,
          searchDone: true,
          candidates: [],
          chosenAlternative: {
            mangaId: 77,
            sourceId: "10",
            sourceName: "MangaDex",
            url: "/m/77",
            title: "Found Elsewhere",
            similarity: 1,
          },
        },
      ],
      selected,
      { updateManga, restoreBackup, request },
    );

    expect(result).toEqual({ added: 2 });
    expect(updateManga).toHaveBeenCalledWith(77, true);
    expect(restoreBackup).toHaveBeenCalledTimes(1);
    const categoryUpdates = request.mock.calls
      .filter(([query]) => query.includes("mutation UpdateMangaCategories"))
      .map(([, variables]) => variables);
    expect(categoryUpdates).toEqual(expected.length === 0 ? [] : [
      { mangaId: 77, addTo: expected, removeFrom: [] },
      { mangaId: 55, addTo: expected, removeFrom: [] },
    ]);
  });
});
