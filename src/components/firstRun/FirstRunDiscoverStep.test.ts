import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { translate } from "../../lib/i18n/runtime";
import { afterEach, expect, it, vi } from "vitest";

import { createFirstRunDiscoveryWorkflow } from "../../lib/setup/firstRunDiscoveryWorkflow";
import FirstRunDiscoverStep from "./FirstRunDiscoverStep.svelte";
import { store } from "../../store/state.svelte";

afterEach(cleanup);

it("blocks search and navigation while a novel is being saved", async () => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const workflow = createFirstRunDiscoveryWorkflow({
    loadMangaSources: async () => [], loadNovelSources: async () => [{ id: "novel", name: "Source" }],
    findManga: async () => [],
    findNovels: async () => [{ id: "novel", path: "/novel", title: "Pending novel", coverUrl: null, inLibrary: false }],
    addManga: async () => {}, addNovel: () => pending,
  });
  render(FirstRunDiscoverStep, { props: { workflow } });
  await fireEvent.click(await screen.findByRole("button", { name: "Add Pending novel" }));
  for (const name of ["Back", "Finish setup", "Search"]) expect(screen.getByRole("button", { name }).hasAttribute("disabled")).toBe(true);
  release();
  await waitFor(() => expect(screen.getByRole("button", { name: "Finish setup" }).hasAttribute("disabled")).toBe(false));
});

it("resolves manga covers through the current server and refreshes a failed image", async () => {
  store.runtimeServerUrl = "http://127.0.0.1:34567";
  const workflow = createFirstRunDiscoveryWorkflow({
    loadMangaSources: async () => [{ id: "source", name: "Source" }], loadNovelSources: async () => [],
    findManga: async () => [{ id: 1, title: "Cover", coverUrl: "/api/v1/manga/1/thumbnail", inLibrary: false }],
    findNovels: async () => [], addManga: async () => {}, addNovel: async () => {},
  });
  const { container } = render(FirstRunDiscoverStep, { props: { workflow } });
  await screen.findByText("Cover");
  const image = container.querySelector<HTMLImageElement>(".cover img")!;
  expect(image.src).toContain("http://127.0.0.1:34567/api/v1/manga/1/thumbnail");
  await fireEvent.error(image);
  expect(image.hidden).toBe(true);
  store.libraryCoverCacheGeneration += 1;
  await waitFor(() => expect(container.querySelector<HTMLImageElement>(".cover img")!.hidden).toBe(false));
});

it("uses the compact discovery surface and lets setup finish with or without a Library write", async () => {
  const addManga = vi.fn(async () => {});
  const workflow = createFirstRunDiscoveryWorkflow({
    loadMangaSources: async () => [{ id: "source", name: "MangaDex" }],
    loadNovelSources: async () => [],
    findManga: async (_source, query) => [{ id: 7, title: query ? "Search result" : "Popular title", coverUrl: null, inLibrary: false }],
    findNovels: async () => [],
    addManga,
    addNovel: vi.fn(),
  });
  const onLibraryChange = vi.fn();
  const onContinue = vi.fn();
  const { container } = render(FirstRunDiscoverStep, {
    props: { workflow, onLibraryChange, onContinue },
  });

  expect(screen.getByRole("heading", { name: "Add titles to your library" })).toBeTruthy();
  expect(container.querySelector(".browse-topbar, .root--embedded, .rail, .n-topbar")).toBeNull();
  expect(await screen.findByText("Popular title")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Finish setup" }).hasAttribute("disabled")).toBe(false);

  await fireEvent.input(screen.getByRole("searchbox", { name: "Search titles" }), { target: { value: "Search" } });
  await fireEvent.click(screen.getByRole("button", { name: "Search" }));
  expect(await screen.findByText("Search result")).toBeTruthy();
  await fireEvent.click(screen.getByRole("button", { name: "Add Search result" }));

  await waitFor(() => expect(addManga).toHaveBeenCalledOnce());
  expect(onLibraryChange).toHaveBeenCalledWith(true);
  expect(screen.getByRole("button", { name: "Finish setup" }).hasAttribute("disabled")).toBe(false);
  await fireEvent.click(screen.getByRole("button", { name: "Finish setup" }));
  expect(onContinue).toHaveBeenCalledOnce();
});

it("shows a retryable empty/error state without blocking setup", async () => {
  const workflow = createFirstRunDiscoveryWorkflow({
    loadMangaSources: async () => [{ id: "source", name: "Broken" }],
    loadNovelSources: async () => [],
    findManga: async () => { throw new Error("Source unavailable"); },
    findNovels: async () => [],
    addManga: vi.fn(),
    addNovel: vi.fn(),
  });
  render(FirstRunDiscoverStep, { props: { workflow } });

  expect((await screen.findByRole("alert")).textContent).toContain(translate("firstRun.discover.loadError"));
  expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Finish setup" }).hasAttribute("disabled")).toBe(false);
});
