import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({ create: vi.fn(), inspect: vi.fn(), install: vi.fn(), installMany: vi.fn(), addRepository: vi.fn(), addRepositories: vi.fn() }));
vi.mock("../../lib/backup/mangaRestoreDependencies", () => ({ createProductionMangaDependencySession: f.create }));
import RestoreMangaDependencies from "./RestoreMangaDependencies.svelte";
afterEach(cleanup);
describe("Manga dependency review", () => {
  it("preserves source identity until an explicit mapping and requires an install click", async () => {
    const plan = { repositories: [{ id: "repo", indexUrl: "https://repo.test" }], requiredRepositories: [], warnings: [],
      extensions: [{ packageName: "pkg", storeId: "repo", isInstalled: false, name: "Example" }],
      sources: [{ orphanSourceId: "old", sourceName: "Original", status: "needs_review", candidates: [{ sourceId: "new", displayName: "Replacement", sourceName: "Replacement", sourceLang: "en" }] }] };
    f.inspect.mockResolvedValue(plan); f.installMany.mockResolvedValue(plan);
    f.create.mockResolvedValue({ inspect: f.inspect, install: f.install, installMany: f.installMany, addRepository: f.addRepository, addRepositories: f.addRepositories });
    const onChoices = vi.fn();
    render(RestoreMangaDependencies, { props: { file: new File(["x"], "x.tachibk"), format: "native", onChoices } });
    await waitFor(() => expect(f.create).toHaveBeenCalled());
    await screen.findByRole("combobox");
    expect(onChoices).not.toHaveBeenCalled(); expect(f.install).not.toHaveBeenCalled();
    expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe("preserve");
    await fireEvent.change(screen.getByRole("combobox"), { target: { value: "map:new" } });
    expect(onChoices).toHaveBeenCalledWith({ old: { mode: "map", sourceId: "new", name: "Replacement", lang: "en" } });
    await fireEvent.click(screen.getByRole("button", { name: "Install all" }));
    await waitFor(() => expect(f.installMany).toHaveBeenCalledWith([{ packageName: "pkg", storeId: "repo" }]));
  });
  it("adds missing repositories in bulk", async () => {
    const plan = { repositories: [], requiredRepositories: ["https://raw.githubusercontent.com/a/b/repo"], warnings: [],
      extensions: [], sources: [] };
    const planWithRepo = { ...plan, repositories: [{ id: "a/b", indexUrl: "https://raw.githubusercontent.com/a/b/repo" }] };
    f.inspect.mockResolvedValue(plan);
    f.addRepositories.mockResolvedValue({ plan: planWithRepo, failed: [] });
    f.create.mockResolvedValue({ inspect: f.inspect, install: f.install, installMany: f.installMany, addRepository: f.addRepository, addRepositories: f.addRepositories });
    render(RestoreMangaDependencies, { props: { file: new File(["x"], "x.tachibk"), format: "native" } });
    await waitFor(() => expect(f.create).toHaveBeenCalled());
    await screen.findByRole("button", { name: "Add" });
    await fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(f.addRepositories).toHaveBeenCalledWith(["https://raw.githubusercontent.com/a/b/repo"]));
  });
});
