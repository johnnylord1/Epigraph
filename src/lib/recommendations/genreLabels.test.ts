import { describe, expect, it } from "vitest";
import { genreDisplayLabel, tasteTagLabel } from "./genreLabels";
import { recommendationTagTokens } from "./metadata";
import { buildTasteProfile } from "./tasteProfile";

describe("taste tags across languages", () => {
  it("folds Portuguese and Spanish genres into the same token", () => {
    expect(recommendationTagTokens("Ação")).toEqual(["action"]);
    expect(recommendationTagTokens("Acción")).toEqual(["action"]);
    expect(recommendationTagTokens("Ficção Científica")).toEqual(["sci fi"]);
  });

  it("does not list a genre twice when sources disagree on language", () => {
    const profile = buildTasteProfile([
      { id: "a", title: "A", contentType: "manga", status: "reading", tags: ["Action", "Adventure"] },
      { id: "b", title: "B", contentType: "manga", status: "reading", tags: ["Ação", "Aventura"] },
    ]);
    expect(profile.topTags).toEqual(["action", "adventure"]);
  });

  it("names tags in the app language", () => {
    expect(tasteTagLabel("action", "pt-BR")).toBe("Ação");
    expect(tasteTagLabel("sci fi", "ja")).toBe("SF");
    expect(tasteTagLabel("sci fi", "en")).toBe("Sci Fi");
    expect(tasteTagLabel("shounen", "pt-BR")).toBe("Shounen");
  });

  it("turns genre slugs from sources into words and leaves real names alone", () => {
    expect(genreDisplayLabel("slice_of_life", "pt-BR")).toBe("Cotidiano");
    expect(genreDisplayLabel("martial_arts", "en")).toBe("Martial Arts");
    expect(genreDisplayLabel("full_color", "pt-BR")).toBe("Full Color");
    expect(genreDisplayLabel("Non_human", "en")).toBe("Non Human");
    expect(genreDisplayLabel("time-travel", "en")).toBe("Time Travel");
    expect(genreDisplayLabel("Ação", "pt-BR")).toBe("Ação");
    expect(genreDisplayLabel("Sci-Fi", "pt-BR")).toBe("Sci-Fi");
    expect(genreDisplayLabel("action", "pt-BR")).toBe("action");
  });
});
