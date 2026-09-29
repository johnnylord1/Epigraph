import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({ create: vi.fn(), inspect: vi.fn(), install: vi.fn(), addRepository: vi.fn() }));
vi.mock("../../lib/backup/mangaRestoreDependencies", () => ({ createProductionMangaDependencySession: f.create }));
import RestoreMangaDependencies from "./RestoreMangaDependencies.svelte";
afterEach(cleanup);
describe("Manga dependency review", () => {
  it("preserves source identity until an explicit mapping and requires an install click", async () => {
    const plan = { repositories: [{ id: "repo", indexUrl: "https://repo.test" }], requiredRepositories: [], warnings: [],
      extensions: [{ packageName: "pkg", storeId: "repo", isInstalled: false, name: "Example" }],
      sources: [{ orphanSourceId: "old", sourceName: "Original", status: "needs_review", candidates: [{ sourceId: "new", displayName: "Replacement", sourceName: "Replacement", sourceLang: "en" }] }] };
    f.inspect.mockResolvedValue(plan); f.install.mockResolvedValue(plan);
    f.create.mockResolvedValue({ inspect: f.inspect, install: f.install, addRepository: f.addRepository });
    const onChoices = vi.fn();
    render(RestoreMangaDependencies, { props: { file: new File(["x"], "x.tachibk"), format: "native", onChoices } });
    expect(f.create).not.toHaveBeenCalled();
    await fireEvent.click(screen.getByRole("button", { name: "Review Manga dependencies" }));
    await screen.findByRole("combobox");
    expect(onChoices).not.toHaveBeenCalled(); expect(f.install).not.toHaveBeenCalled();
    expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe("preserve");
    await fireEvent.change(screen.getByRole("combobox"), { target: { value: "map:new" } });
    expect(onChoices).toHaveBeenCalledWith({ old: { mode: "map", sourceId: "new", name: "Replacement", lang: "en" } });
    await fireEvent.click(screen.getByRole("button", { name: "Install Example" }));
    await waitFor(() => expect(f.install).toHaveBeenCalledWith({ packageName: "pkg", storeId: "repo" }));
  });
});
