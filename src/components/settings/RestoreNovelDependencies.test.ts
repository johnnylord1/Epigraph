import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({ create: vi.fn(), inspect: vi.fn(), apply: vi.fn() }));
vi.mock("../../lib/backup/restoreDependencies", () => ({ createProductionNovelDependencySession: f.create }));
import { applyAppLanguage, translate } from "../../lib/i18n/runtime";
import RestoreNovelDependencies from "./RestoreNovelDependencies.svelte";
afterEach(() => { cleanup(); applyAppLanguage("en"); });
beforeEach(() => { vi.clearAllMocks(); });
describe("shared restore dependency approval", () => {
  it("unmount releases only presentation busy state while the active preparation finishes", async () => {
    let finish!: (result: unknown) => void;
    const onBusy = vi.fn(), onChanged = vi.fn();
    f.inspect.mockResolvedValue({ plugins: [{ pluginId: "one", status: "needs-selection", repositoryUrls: ["https://a.test"], selectedRepositoryUrl: "https://a.test", candidates: [{ repositoryUrl: "https://a.test" }] }] });
    f.apply.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    f.create.mockResolvedValue({ inspect: f.inspect, apply: f.apply });
    const view = render(RestoreNovelDependencies, { props: { file: new File(["x"], "x.zip"), format: "lnreader", onBusy, onChanged } });
    await fireEvent.click(screen.getByRole("button", { name: "Review Novel dependencies" }));
    await screen.findByRole("checkbox"); await fireEvent.click(screen.getByRole("checkbox"));
    await fireEvent.click(screen.getByRole("button", { name: "Prepare approved dependencies" }));
    await waitFor(() => expect(f.apply).toHaveBeenCalledOnce());
    view.unmount(); expect(onBusy).toHaveBeenLastCalledWith(false);
    finish({ plan: { plugins: [] }, warnings: [] });
    await Promise.resolve(); expect(onChanged).not.toHaveBeenCalled();
  });
  it("inspects without installing and requires explicit origin approval before preparation", async () => {
    const plugin = { pluginId: "plugin.one", status: "needs-selection", repositoryUrls: [], selectedRepositoryUrl: null,
      candidates: [{ repositoryUrl: "https://plugins.test/index.json", trusted: false, enabled: true, repositoryId: "one" }] };
    f.create.mockResolvedValue({ inspect: f.inspect, apply: f.apply });
    f.inspect.mockResolvedValue({ plugins: [plugin] });
    f.apply.mockResolvedValue({ plan: { plugins: [{ ...plugin, status: "ready" }] }, warnings: [{ code: "approval-required", message: "raw English dependency warning" }] });
    render(RestoreNovelDependencies, { props: { file: new File(["fixture"], "novels.zip"), format: "lnreader" } });
    expect(f.create).not.toHaveBeenCalled();
    await fireEvent.click(screen.getByRole("button", { name: "Review Novel dependencies" }));
    await screen.findByText("plugin.one");
    expect(f.apply).not.toHaveBeenCalled();
    await fireEvent.change(screen.getByRole("combobox"), { target: { value: "https://plugins.test/index.json" } });
    expect((screen.getByRole("button", { name: "Prepare approved dependencies" }) as HTMLButtonElement).disabled).toBe(true);
    await fireEvent.click(screen.getByRole("checkbox"));
    await fireEvent.click(screen.getByRole("button", { name: "Prepare approved dependencies" }));
    await waitFor(() => expect(f.apply).toHaveBeenCalledWith({ repositoryUrls: ["https://plugins.test/index.json"], plugins: { "plugin.one": "https://plugins.test/index.json" } }));
    await screen.findByText(translate("outcomes.approval"));
    expect(screen.queryByText("raw English dependency warning")).toBeNull();
    applyAppLanguage("ja");
    await waitFor(() => expect(screen.getByText(translate("outcomes.approval"))).toBeTruthy());
  });
});
