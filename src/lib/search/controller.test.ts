import { describe, expect, test, vi } from "vitest";
import { SearchController } from "./controller";
import type { SearchProvider } from "./types";

const provider = (remote: boolean, title: string, delay = 0): SearchProvider => ({
  id: `${remote ? "remote" : "local"}-${title}`,
  remote,
  contexts: ["home"],
  search: async ({ query, signal }) => {
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    if (signal.aborted) return [];
    return [{ id: `${title}:${query}`, type: "page", title: `${title} ${query}`, group: "actions", groupLabel: "Actions", action: { kind: "navigate", page: "home" } }];
  },
});

describe("SearchController", () => {
  test("does not run asynchronous providers in the local phase", () => {
    const remote = vi.fn(provider(true, "remote").search);
    const controller = new SearchController([{ ...provider(false, "local"), search: () => [{ id: "local", type: "page", title: "Local", group: "actions", groupLabel: "Actions", action: { kind: "navigate", page: "home" } }] }, { ...provider(true, "remote"), search: remote }]);
    expect(controller.searchLocal("home", "local").map((entry) => entry.id)).toEqual(["local"]);
    expect(remote).not.toHaveBeenCalled();
  });

  test("ignores an aborted remote response", async () => {
    const controller = new SearchController([provider(true, "remote", 10)]);
    const first = controller.searchRemote("home", "first");
    const second = controller.searchRemote("home", "second");
    await expect(first).resolves.toEqual([]);
    await expect(second).resolves.toHaveLength(1);
  });

  test("separates cached Browse results by content type", async () => {
    const search = vi.fn(async ({ query, browseContentType }) => [{
      id: `${browseContentType}:${query}`,
      type: "browse-item" as const,
      title: `${browseContentType} ${query}`,
      group: "browse",
      groupLabel: "Browse",
      action: { kind: "navigate" as const, page: "browse" as const },
    }]);
    const controller = new SearchController([{
      id: "browse",
      remote: true,
      contexts: ["browse"],
      search,
    }]);

    await expect(controller.searchRemote("browse", "index", undefined, "manga", "keyword"))
      .resolves.toMatchObject([{ id: "manga:index" }]);
    await expect(controller.searchRemote("browse", "index", undefined, "novels", "keyword"))
      .resolves.toMatchObject([{ id: "novels:index" }]);
    await controller.searchRemote("browse", "index", undefined, "manga", "keyword");
    expect(search).toHaveBeenCalledTimes(2);
  });
});
