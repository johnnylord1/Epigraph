import { describe, expect, it, vi } from "vitest";
import { createMangaRestoreDependencySession } from "./mangaRestoreDependencies";

function fixture() {
  let target = "profile-a";
  const plan = { repositories: [{ id: "repo", indexUrl: "https://repo.test" }], requiredRepositories: [] as string[],
    extensions: [{ packageName: "one", storeId: "repo", isInstalled: false }], sources: [], warnings: [] };
  const inspect = vi.fn(async () => structuredClone(plan));
  const install = vi.fn(async () => {}), add = vi.fn(async () => {}), release = vi.fn(async () => {});
  const session = createMangaRestoreDependencySession({ target: () => target, inspect, install, add,
    admit: async () => release });
  return { plan, inspect, install, add, release, session, changeTarget: () => { target = "b"; } };
}
describe("Manga dependency approval", () => {
  it("inspection is read-only; a package is installed only after exact origin approval and a fresh inventory", async () => {
    const f = fixture();
    await f.session.inspect(); expect(f.install).not.toHaveBeenCalled(); expect(f.add).not.toHaveBeenCalled();
    const result = await f.session.install({ packageName: "one", storeId: "repo" });
    expect(f.install).toHaveBeenCalledOnce(); expect(f.install).toHaveBeenCalledWith("one");
    expect(f.inspect).toHaveBeenCalledTimes(3);
    // Install acknowledgement does not invent source availability.
    expect(result.sources).toEqual([]); expect(f.release).toHaveBeenCalledOnce();
  });
  it.each(["changed-origin", "ambiguous", "changed-target"])("refuses %s without installation", async reason => {
    const f = fixture(); await f.session.inspect();
    if (reason === "changed-origin") f.plan.extensions[0].storeId = "other";
    if (reason === "ambiguous") f.plan.extensions.push({ ...f.plan.extensions[0], storeId: "other" });
    if (reason === "changed-target") f.changeTarget();
    await expect(f.session.install({ packageName: "one", storeId: "repo" })).rejects.toThrow();
    expect(f.install).not.toHaveBeenCalled();
  });
  it("keeps exclusion during an unfinished install and refuses a second request", async () => {
    const f = fixture(); let finish!: () => void;
    f.install.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = f.session.install({ packageName: "one", storeId: "repo" });
    await vi.waitFor(() => expect(f.install).toHaveBeenCalledOnce());
    await expect(f.session.install({ packageName: "one", storeId: "repo" })).rejects.toThrow("RESTORE_CONFLICT");
    expect(f.release).not.toHaveBeenCalled(); finish(); await pending;
    expect(f.release).toHaveBeenCalledOnce();
  });
  it("a repository already present under another index file name is not added again", async () => {
    const f = fixture();
    f.plan.repositories = [{ id: "repo", indexUrl: "https://repo.test/r/index.pb" }];
    f.plan.requiredRepositories = ["https://repo.test/r"];
    await f.session.addRepository("https://repo.test/r");
    expect(f.add).not.toHaveBeenCalled();
  });
  it("a missing required repository is added once", async () => {
    const f = fixture();
    f.plan.requiredRepositories = ["https://other.test/r"];
    await f.session.addRepository("https://other.test/r");
    expect(f.add).toHaveBeenCalledOnce();
    expect(f.add).toHaveBeenCalledWith("https://other.test/r");
  });
});
