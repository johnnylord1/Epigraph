import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBackupWorkflow, type BackupInspection } from "../../lib/backup/backupWorkflow";
import { applyAppLanguage, translate } from "../../lib/i18n/runtime";
import FirstRunBackupStep from "./FirstRunBackupStep.svelte";

vi.mock("../../lib/backup/mangaRestoreDependencies", () => ({
  createProductionMangaDependencySession: async () => ({ inspect: async () => ({
    repositories: [], requiredRepositories: [], extensions: [], warnings: [],
    sources: [{ orphanSourceId: "old", sourceName: "Shared source", candidates: [{ sourceId: "new", displayName: "New source" }] }],
  }) }),
}));
vi.mock("../../lib/backup/restoreDependencies", () => ({
  createProductionNovelDependencySession: async () => ({ inspect: async () => ({ plugins: [] }) }),
}));

// The dependency panels inspect as soon as they open; restoring waits until they are done.
async function restoreAllWhenReady() {
  const restore = screen.getByRole("button", { name: "Restore all" });
  await waitFor(() => expect(restore.hasAttribute("disabled")).toBe(false));
  await fireEvent.click(restore);
}

afterEach(() => { cleanup(); applyAppLanguage("en"); });

const inspection: BackupInspection = {
  plan: null,
  workCount: 50,
  chapterCount: 900,
  repositoryCount: 1,
  extensionCount: 4,
  conflictCount: 2,
  libraryKinds: ["manga", "novels"],
  needsSourceKinds: ["manga", "novels"],
};

describe("FirstRunBackupStep", () => {
  it("localizes inspection failures and refreshes their presentation when the language changes", async () => {
    applyAppLanguage("pt-BR");
    const workflow = createBackupWorkflow({ inspect: async () => { throw new Error("raw English backend failure"); }, restore: async () => {} });
    render(FirstRunBackupStep, { props: { workflow, picker: async () => [new File(["bad"], "broken.zip")] } });
    await fireEvent.click(screen.getByRole("button", { name: translate("firstRun.backup.select") }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(translate("outcomes.invalidBackup"));
    expect(alert.textContent).not.toContain("raw English");
    applyAppLanguage("es");
    await waitFor(() => expect(alert.textContent).toContain(translate("outcomes.invalidBackup")));
    expect(screen.getByRole("button", { name: translate("firstRun.backup.reviewImport") }).hasAttribute("disabled")).toBe(true);
  });

  it("keeps each backup's source choices independent and attributes them to its content key", async () => {
    const setMangaChoices = vi.fn();
    const workflow = Object.assign(createBackupWorkflow({ inspect: async () => ({ ...inspection, libraryKinds: ["manga"] }), restore: async () => {} }), { setMangaChoices });
    const selected = [new File(["a"], "a.tachibk"), new File(["b"], "b.tachibk")];
    const entries = await workflow.inspectFiles(selected);
    render(FirstRunBackupStep, { props: { workflow, picker: async () => selected } });
    await fireEvent.click(screen.getByRole("button", { name: "Select" }));
    await screen.findByText("b.tachibk");
    await fireEvent.click(screen.getByRole("button", { name: "Review import" }));
    await waitFor(() => expect(screen.getAllByRole("combobox", { name: /Shared source/ })).toHaveLength(2));
    const selects = screen.getAllByRole("combobox", { name: /Shared source/ }) as HTMLSelectElement[];
    await fireEvent.change(selects[0], { target: { value: "skip" } });
    expect(setMangaChoices).toHaveBeenLastCalledWith({ old: { mode: "skip" } }, entries[0].key);
    expect(selects[0].value).toBe("skip");
    expect(selects[1].value).toBe("preserve");
  });
  it("presents domain warnings before advancing after a successful restore", async () => {
    const onRestored = vi.fn();
    const workflow = Object.assign(createBackupWorkflow({ inspect: async () => ({ ...inspection, libraryKinds: ["novels"] }), restore: async () => {} }),
      { warnings: () => ({ novels: ["CURRENT_STATE_PRESERVED"] }) });
    render(FirstRunBackupStep, { props: { workflow, onRestored, picker: async () => [new File(["warnings"], "warnings.zip")] } });
    await fireEvent.click(screen.getByRole("button", { name: "Select" }));
    await screen.findByText("warnings.zip");
    await fireEvent.click(screen.getByRole("button", { name: "Review import" }));
    await restoreAllWhenReady();
    await screen.findByText(translate("outcomes.statePreserved"));
    expect(onRestored).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Back" }).hasAttribute("disabled")).toBe(true);
    await fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(onRestored).toHaveBeenCalledOnce();
  });
  it("detaches presentation without cancelling accepted work or advancing an unmounted screen", async () => {
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const onRestored = vi.fn();
    const execute = vi.fn(async () => { await pending; });
    const workflow = createBackupWorkflow({ inspect: async () => ({ ...inspection, libraryKinds: ["books"] }), restore: execute });
    const view = render(FirstRunBackupStep, { props: { workflow, onRestored, picker: async () => [new File(["detach"], "detach.epigraphbk")] } });
    await fireEvent.click(screen.getByRole("button", { name: "Select" }));
    await screen.findByText("detach.epigraphbk");
    await fireEvent.click(screen.getByRole("button", { name: "Review import" }));
    await fireEvent.click(screen.getByRole("button", { name: "Restore all" }));
    await waitFor(() => expect(execute).toHaveBeenCalledOnce());
    view.unmount();
    expect(workflow.snapshot()).toMatchObject({ running: true, cancelled: false });
    release();
    await waitFor(() => expect(workflow.snapshot().running).toBe(false));
    expect(Object.values(workflow.snapshot().units)).toEqual(["succeeded"]);
    expect(onRestored).not.toHaveBeenCalled();
  });
  it("cancels future files without reporting a completed restore", async () => {
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const calls: string[] = [];
    const onRestored = vi.fn();
    const workflow = createBackupWorkflow({ inspect: async () => ({ ...inspection, libraryKinds: ["books"] }),
      restore: async entry => { calls.push(entry.name); await pending; } });
    render(FirstRunBackupStep, { props: { workflow, onRestored, picker: async () => [new File(["a"], "a.epigraphbk"), new File(["b"], "b.epigraphbk")] } });
    await fireEvent.click(screen.getByRole("button", { name: "Select" }));
    await screen.findByText("b.epigraphbk");
    await fireEvent.click(await screen.findByRole("button", { name: "Review import" }));
    await fireEvent.click(screen.getByRole("button", { name: "Restore all" }));
    await waitFor(() => expect(calls).toEqual(["a.epigraphbk"]));
    await fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    release();
    await waitFor(() => expect(Object.values(workflow.snapshot().units)).toEqual(["succeeded", "cancelled"]));
    expect(onRestored).not.toHaveBeenCalled();
    expect(calls).toEqual(["a.epigraphbk"]);
  });
  it("moves from focused selection to review and reports real restore progress", async () => {
    const onRestored = vi.fn();
    const workflow = createBackupWorkflow({
      inspect: vi.fn(async () => inspection),
      restore: vi.fn(async (_entry, onProgress) => {
        onProgress(0.4);
        onProgress(1);
      }),
    });
    const selected = new File(["backup"], "mihon.tachibk", { lastModified: 1 });
    render(FirstRunBackupStep, { props: { workflow, picker: async () => [selected], onRestored } });

    expect(screen.getByRole("heading", { name: "Select your backups." })).toBeTruthy();
    expect(screen.getByText("Epigraph, Mihon, Tachiyomi and LNReader")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Review import" }).hasAttribute("disabled")).toBe(true);

    await fireEvent.click(screen.getByRole("button", { name: "Select" }));
    expect(await screen.findByText("mihon.tachibk")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Review import" }).hasAttribute("disabled")).toBe(false);

    await fireEvent.click(screen.getByRole("button", { name: "Review import" }));
    expect(screen.getByRole("heading", { name: "Review the import." })).toBeTruthy();
    expect(screen.getByText("50")).toBeTruthy();
    expect(screen.getByText("4")).toBeTruthy();
    expect(screen.getByText("2")).toBeTruthy();
    expect(screen.getByText("Comics, novels")).toBeTruthy();
    expect(screen.getByRole("region", { name: "Review Novel dependencies" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Review Manga dependencies" })).toBeTruthy();

    await restoreAllWhenReady();
    await waitFor(() => expect(onRestored).toHaveBeenCalledWith({
      hasLibrary: true,
      needsSourceKinds: ["manga", "novels"],
      sourceTypes: ["manga", "novels"],
    }));
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("100");
  });

  it("keeps invalid files visible and excludes them from review readiness", async () => {
    const workflow = createBackupWorkflow({
      inspect: vi.fn(async () => { throw new Error("Unsupported archive"); }),
      restore: vi.fn(),
    });
    render(FirstRunBackupStep, {
      props: { workflow, picker: async () => [new File(["bad"], "broken.zip")] },
    });

    await fireEvent.click(screen.getByRole("button", { name: "Select" }));
    expect((await screen.findByRole("alert")).textContent).toContain(translate("outcomes.invalidBackup"));
    expect(screen.getByRole("button", { name: "Review import" }).hasAttribute("disabled")).toBe(true);
  });
});
