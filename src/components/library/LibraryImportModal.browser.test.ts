import { cleanup, fireEvent, render, screen, within } from "@testing-library/svelte";
import { page } from "@vitest/browser/context";
import { afterEach, expect, test, vi } from "vitest";
import { analyzeShareImport, applyShareImport, searchWorkInInstalledSources } from "../../lib/library/shareImport";
import { buildShareManifest, encodeShareManifest } from "../../lib/library/shareLink";
import { store } from "../../store/state.svelte";
import LibraryImportModal from "./LibraryImportModal.svelte";

vi.mock("../../lib/library/shareImport", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../lib/library/shareImport")>();
  return {
    ...original,
    analyzeShareImport: vi.fn(original.analyzeShareImport),
    applyShareImport: vi.fn(),
    searchWorkInInstalledSources: vi.fn(),
  };
});

test.each([
  { defaultId: 3, selectedFolders: ["Reading", "Favorites"], expected: [3, 7, 12] },
  { defaultId: 3, selectedFolders: [], expected: [3] },
  { defaultId: null, selectedFolders: [], expected: [] },
])("imports with default $defaultId and optional folders $selectedFolders", async ({ defaultId, selectedFolders, expected }) => {
  await page.viewport(800, 600);
  const previousDefault = store.settings.defaultLibraryCategoryId;
  store.settings.defaultLibraryCategoryId = defaultId;
  try {
    const manifest = buildShareManifest([
      { title: "Shared Work", url: "/manga/shared", sourceId: "100", sourceName: "Source" },
    ]);
    const { analyzeShareImport: analyze } = await vi.importActual<typeof import("../../lib/library/shareImport")>(
      "../../lib/library/shareImport",
    );
    vi.mocked(analyzeShareImport).mockImplementation((input) => analyze(input, {
      loadInventory: async () => ({
        inventory: [{
          sourceId: "100", name: "Source", lang: "en", displayName: "Source", kind: "installed",
          extensionPkgName: null, extensionName: null, extensionInstalled: true,
        }],
        availableExtensions: [], warnings: [], repoUrls: [],
      }),
      loadLibraryEntries: async () => [],
      loadCategories: async () => ["Default", "Inbox", "Reading", "Favorites"].map((name, order) => ({
        id: [0, 3, 7, 12][order], name, order, default: order === 0, includeInUpdate: "INCLUDE", includeInDownload: "INCLUDE",
      })),
    }));
    vi.mocked(applyShareImport).mockResolvedValue({ added: 1 });

    render(LibraryImportModal, {
      props: { rawLink: `epigraph://import?p=${encodeShareManifest(manifest)}`, onClose: vi.fn() },
    });
    const picker = await screen.findByRole("button", { name: "Extra folders" });
    expect(picker.offsetWidth).toBeLessThanOrEqual(160);
    expect(picker.offsetHeight).toBeLessThanOrEqual(30);
    expect(parseFloat(getComputedStyle(picker).fontSize)).toBeLessThan(12);
    await fireEvent.click(picker);
    const options = screen.getByRole("group", { name: "Extra folders" });
    expect(options.offsetWidth).toBeLessThanOrEqual(160);
    const option = within(options).getByRole("checkbox", { name: "Reading" }).closest("label")!;
    expect(option.offsetHeight).toBeLessThanOrEqual(28);
    expect(parseFloat(getComputedStyle(option).fontSize)).toBeLessThan(12);
    expect(options.getBoundingClientRect().bottom).toBeLessThan(picker.getBoundingClientRect().top);
    expect(within(options).queryByRole("checkbox", { name: "Default" })).toBeNull();
    if (defaultId !== null) expect(within(options).queryByRole("checkbox", { name: "Inbox" })).toBeNull();
    for (const name of selectedFolders) {
      const checkbox = within(options).getByRole<HTMLInputElement>("checkbox", { name });
      expect(checkbox.checked).toBe(false);
      await fireEvent.click(checkbox);
      expect(checkbox.checked).toBe(true);
    }
    if (selectedFolders.length > 0) expect(picker.textContent).toContain(`Extra folders (${selectedFolders.length})`);
    await fireEvent.keyDown(within(options).getByRole("checkbox", { name: "Reading" }), { key: "Escape" });
    expect(screen.queryByRole("group", { name: "Extra folders" })).toBeNull();
    expect(document.activeElement).toBe(picker);

    await fireEvent.click(screen.getByRole("button", { name: "Add 1 work" }));
    expect(applyShareImport).toHaveBeenCalledWith([expect.objectContaining({ title: "Shared Work" })], expected);
  } finally {
    store.settings.defaultLibraryCategoryId = previousDefault;
  }
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

test("shows the library slot on the left and puts per-work actions in the migration menu", async () => {
  await page.viewport(800, 600);
  const mangakakalot = "2528986671771677900";
  const manganelo = "1024627298672457456";
  const title = "+99 Reinforced Wooden Stick";
  const titleUrl = "/manga/99-reinforced-wooden-stick";
  const manifest = buildShareManifest([
    { title, url: titleUrl, sourceId: mangakakalot, sourceName: "Mangakakalot" },
    { title: "Left Handed Mutation", url: "/manga/left-handed-mutation", sourceId: mangakakalot, sourceName: "Mangakakalot" },
    { title: "3CM Hunter", url: "/manga/3cm-hunter", sourceId: manganelo, sourceName: "Manganelo" },
  ]);
  const { analyzeShareImport: analyze } = await vi.importActual<typeof import("../../lib/library/shareImport")>(
    "../../lib/library/shareImport",
  );
  vi.mocked(analyzeShareImport).mockImplementation((input) => analyze(input, {
    loadInventory: async () => ({
      inventory: [[mangakakalot, "Mangakakalot"], [manganelo, "Manganelo"]].map(([sourceId, name]) => ({
        sourceId, name, lang: "en", displayName: name, kind: "installed",
        extensionPkgName: null, extensionName: null, extensionInstalled: true,
      })),
      availableExtensions: [], warnings: [], repoUrls: [],
    }),
    loadLibraryEntries: async () => [
      { title, url: titleUrl, sourceId: manganelo, sourceName: "Manganelo" },
      { title: "3CM Hunter", url: "/manga/3cm-hunter", sourceId: manganelo, sourceName: "Manganelo" },
    ],
    loadCategories: async () => [],
  }));
  vi.mocked(searchWorkInInstalledSources).mockResolvedValue([
    { mangaId: 62, sourceId: mangakakalot, sourceName: "Mangakakalot", url: "https://readmanganato.com/manga-nm991021", title, similarity: 1 },
  ]);

  render(LibraryImportModal, {
    props: { rawLink: `epigraph://import?p=${encodeShareManifest(manifest)}`, onClose: vi.fn() },
  });
  const newActions = await screen.findByRole("button", { name: "Actions for Left Handed Mutation" });
  const dialog = screen.getByRole("dialog", { name: "Add shared works" });
  expect(dialog.offsetWidth).toBeLessThanOrEqual(720);
  expect(dialog.offsetHeight).toBeLessThan(480);
  expect(document.querySelectorAll(".mg-check")).toHaveLength(0);

  const newRow = newActions.closest("article")!;
  const [emptyCover, importedCover] = newRow.querySelectorAll(".mg-cover");
  expect(getComputedStyle(emptyCover).width).toBe("48px");
  expect(emptyCover.childElementCount).toBe(0);
  expect(emptyCover.nextElementSibling?.textContent).toBe("Not in library");
  expect(importedCover.closest(".mg-side--target")?.textContent).toContain("Left Handed Mutation");
  expect(screen.getByRole("button", { name: "Add 1 work" }).hasAttribute("disabled")).toBe(false);

  const articles = [...document.querySelectorAll("article")];
  const existing = articles.find((row) => row.textContent?.includes("3CM Hunter"))!;
  expect(existing.querySelectorAll(".mg-cover")).toHaveLength(2);
  const actions = screen.getByRole("button", { name: `Actions for ${title}` });
  const pair = actions.closest("article")!;
  expect(pair.querySelectorAll(".mg-cover")).toHaveLength(2);
  expect(within(pair).getByText("Already in library")).toBeTruthy();
  expect(within(pair).getByText("Don't add")).toBeTruthy();
  expect(pair.querySelector(".mg-side")?.textContent).toContain("Manganelo");
  expect(pair.querySelector(".mg-side--target")?.textContent).toContain("Mangakakalot");
  expect(screen.queryByRole("button", { name: "Search installed" })).toBeNull();

  await fireEvent.click(actions);
  await fireEvent.click(within(pair).getByRole("menuitem", { name: "Search installed" }));
  expect(searchWorkInInstalledSources).toHaveBeenCalledWith(title, expect.any(Array), expect.any(Object));
  expect(screen.getByRole("button", { name: "Add 1 work" })).toBeTruthy();

  await fireEvent.click(actions);
  expect(await within(pair).findByRole("menuitem", { name: "Via Mangakakalot" })).toBeTruthy();
  expect(within(pair).getByRole("menuitem", { name: `Mangakakalot — ${title}` })).toBeTruthy();
  await fireEvent.keyDown(actions, { key: "Escape" });
  expect(await screen.findByRole("dialog", { name: "Add shared works" })).toBeTruthy();

  await fireEvent.click(newActions);
  await fireEvent.click(within(newRow).getByRole("menuitem", { name: "Don't add" }));
  expect(screen.getByRole("button", { name: "Add 0 works" }).hasAttribute("disabled")).toBe(true);
});
