import { describe, expect, it, vi } from "vitest";

import { buildSearchAttemptTerms, resolveSearchResultsWithFallback } from "./queryFallback";

describe("search query fallback", () => {
  it("builds normalized search attempts with accent, spacing, and token fallbacks", () => {
    expect(buildSearchAttemptTerms("  \u00caxodo:   O homem mais confi\u00e1vel da lua  ")).toEqual([
      "\u00caxodo: O homem mais confi\u00e1vel da lua",
      "\u00caxodo O homem mais confi\u00e1vel da lua",
      "Exodo O homem mais confiavel da lua",
      "confiavel",
      "Exodo",
      "\u00caxodoOhomemmaisconfi\u00e1veldalua",
      "ExodoOhomemmaisconfiaveldalua",
    ]);
  });

  it("retries with normalized variants until a source returns results", async () => {
    const searchMock = vi.fn<(_: string) => Promise<string[]>>(async (term) => (
      term === "confiavel" ? ["\u00caxodo"] : []
    ));

    const results = await resolveSearchResultsWithFallback(
      "O homem mais confi\u00e1vel da lua",
      searchMock,
    );

    expect(results).toEqual(["\u00caxodo"]);
    expect(searchMock.mock.calls.map(([term]) => term)).toEqual([
      "O homem mais confi\u00e1vel da lua",
      "O homem mais confiavel da lua",
      "confiavel",
    ]);
  });

  it("preserves a real runtime error only when every attempt fails", async () => {
    const searchMock = vi.fn(async () => {
      throw new Error("Source search blew up");
    });

    await expect(resolveSearchResultsWithFallback("\u00caxodo", searchMock)).rejects.toThrow(
      "Source search blew up",
    );
  });
});
