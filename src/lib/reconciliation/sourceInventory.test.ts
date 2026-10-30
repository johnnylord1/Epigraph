import { afterEach, describe, expect, test, vi } from "vitest";

const gql = vi.fn();
vi.mock("../client", () => ({ gql: (...args: unknown[]) => gql(...args) }));
vi.mock("../manga/runtime", () => ({ getManagedSourceRuntime: async () => ({ listStores: async () => [] }) }));

const { loadSourceInventory } = await import("./sourceInventory");
const extension = { pkgName: "eu.kanade.tachiyomi.extension.en.example", name: "Example", lang: "en", isInstalled: false };

function respond(fetchExtensions: () => unknown, stored: () => unknown = () => ({ extensions: { nodes: [extension] } })) {
  gql.mockImplementation(async (query: string) => {
    if (query.includes("fetchExtensions")) return fetchExtensions();
    if (query.includes("GetExtensions")) return stored();
    return { sources: { nodes: [] } };
  });
}

afterEach(() => gql.mockReset());

describe("loadSourceInventory", () => {
  test("keeps the stored extension list when Suwayomi cannot refresh it in time", async () => {
    respond(() => { throw new DOMException("Aborted", "AbortError"); });
    const result = await loadSourceInventory();
    expect(result.availableExtensions.map(entry => entry.pkgName)).toEqual([extension.pkgName]);
    expect(result.warnings).toEqual([expect.objectContaining({ kind: "repo_lookup_failed" })]);
  });

  test("uses the refreshed list without a warning when the refresh answers", async () => {
    respond(() => ({ fetchExtensions: { extensions: [extension] } }));
    const result = await loadSourceInventory();
    expect(result.availableExtensions.map(entry => entry.pkgName)).toEqual([extension.pkgName]);
    expect(result.warnings).toEqual([]);
    expect(gql.mock.calls.some(([query]) => String(query).includes("GetExtensions"))).toBe(false);
  });

  test("reports the refresh failure when the stored list is unreachable too", async () => {
    const refresh = new Error("NETWORK_FAILURE");
    respond(() => { throw refresh; }, () => { throw new Error("offline"); });
    await expect(loadSourceInventory()).rejects.toBe(refresh);
  });
});
