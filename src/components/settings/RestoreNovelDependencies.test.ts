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
    const { promise, resolve: finish } = Promise.withResolvers<unknown>();
    const onBusy = vi.fn(), onChanged = vi.fn();
    f.inspect.mockResolvedValue({ plugins: [{ pluginId: "one", status: "needs-selection", repositoryUrls: ["https://a.test"], selectedRepositoryUrl: "https://a.test", candidates: [{ repositoryUrl: "https://a.test" }] }] });
    f.apply.mockImplementationOnce(() => promise);
    f.create.mockResolvedValue({ inspect: f.inspect, apply: f.apply });
    const view = render(RestoreNovelDependencies, { props: { file: new File(["x"], "x.zip"), format: "lnreader", onBusy, onChanged } });
    await screen.findByRole("button", { name: "Install all" });
    await fireEvent.click(screen.getByRole("button", { name: "Install all" }));
    await waitFor(() => expect(f.apply).toHaveBeenCalledOnce());
    view.unmount();
    expect(onBusy).toHaveBeenLastCalledWith(false);
    finish({ plan: { plugins: [] }, warnings: [] });
    await Promise.resolve();
    expect(onChanged).not.toHaveBeenCalled();
  });
  it("inspects on mount and installs every preselected plugin with one click", async () => {
    const url1 = "https://raw.githubusercontent.com/lnreader/lnreader-plugins/plugins/v3.0.0/.dist/plugins.min.json";
    const url2 = "https://x.test/index.json";
    f.create.mockResolvedValue({ inspect: f.inspect, apply: f.apply });
    f.inspect.mockResolvedValue({ plugins: [
      { pluginId: "plugin.one", status: "needs-selection", repositoryUrls: [url1], selectedRepositoryUrl: url1, candidates: [{ repositoryUrl: url1 }] },
      { pluginId: "plugin.two", status: "needs-selection", repositoryUrls: [url2], selectedRepositoryUrl: null, candidates: [{ repositoryUrl: url2 }] },
      { pluginId: "plugin.ready", status: "ready", repositoryUrls: [], selectedRepositoryUrl: null, candidates: [] },
    ]});
    f.apply.mockResolvedValue({ plan: { plugins: [] }, warnings: [{ code: "approval-required", message: "raw English dependency warning" }, { code: "approval-required", message: "raw English dependency warning" }] });
    render(RestoreNovelDependencies, { props: { file: new File(["fixture"], "novels.zip"), format: "lnreader" } });
    await screen.findByText("2 plugins to install");
    expect(screen.getByText("lnreader/lnreader-plugins, x.test")).toBeTruthy();
    expect(f.apply).not.toHaveBeenCalled();
    await fireEvent.click(screen.getByRole("button", { name: "Install all" }));
    await waitFor(() => expect(f.apply).toHaveBeenCalledWith({ repositoryUrls: [url1, url2], plugins: { "plugin.one": url1, "plugin.two": url2 } }));
    await screen.findByText("Warnings (2)");
    const notes = screen.getAllByText(translate("outcomes.approval"));
    expect(notes).toHaveLength(1);
    expect(screen.queryByText("raw English dependency warning")).toBeNull();
    applyAppLanguage("ja");
    await waitFor(() => expect(screen.getByText(translate("outcomes.approval"))).toBeTruthy());
  });
  it("asks for a repository only when a plugin has several candidates", async () => {
    f.create.mockResolvedValue({ inspect: f.inspect, apply: f.apply });
    f.inspect.mockResolvedValue({ plugins: [{ pluginId: "multi", status: "needs-selection", repositoryUrls: ["https://a.test", "https://b.test"], selectedRepositoryUrl: null, candidates: [{ repositoryUrl: "https://a.test" }, { repositoryUrl: "https://b.test" }] }] });
    render(RestoreNovelDependencies, { props: { file: new File(["fixture"], "novels.zip"), format: "lnreader" } });
    await screen.findByRole("combobox");
    expect(screen.queryByRole("button", { name: "Install all" })).toBeNull();
    await fireEvent.change(screen.getByRole("combobox"), { target: { value: "https://a.test" } });
    await screen.findByText("1 plugins to install");
  });
  it("collapses conflicts and missing plugins", async () => {
    f.create.mockResolvedValue({ inspect: f.inspect, apply: f.apply });
    f.inspect.mockResolvedValue({ plugins: [
      { pluginId: "conflict.one", status: "conflict", repositoryUrls: [], selectedRepositoryUrl: null, candidates: [] },
      { pluginId: "missing.one", status: "missing", repositoryUrls: [], selectedRepositoryUrl: null, candidates: [] },
    ]});
    render(RestoreNovelDependencies, { props: { file: new File(["fixture"], "novels.zip"), format: "lnreader" } });
    await screen.findByText("2 plugins need attention");
  });
});
