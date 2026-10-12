import { describe, expect, it } from "vitest";
import { creditKeys, creditRelation, splitCredits } from "./credits";

describe("work credits", () => {
  it("lists the names in an author field, leaving placeholders out", () => {
    expect(splitCredits("Chugong, DUBU (Redice Studio)")).toEqual(["Chugong", "DUBU", "Redice Studio"]);
    expect(splitCredits(["Unknown", "Desconhecido", null, "SIU"])).toEqual(["SIU"]);
  });

  it("compares names however each site writes them", () => {
    expect(creditKeys("Chu-Gong")).toEqual(creditKeys("Chugong"));
    expect(creditKeys("Unknown")).toEqual([]);
    expect(creditRelation(["Jung Yoon-Kang"], ["Yoon-Kang Jung"])).toBe("match");
    expect(creditRelation(["Kim, Carnby"], ["Carnby Kim"])).toBe("match");
    expect(creditRelation(["Redice Studio"], ["REDICE"])).toBe("match");
    expect(creditRelation(["RinoZ"], ["Someone Else"])).toBe("conflict");
    expect(creditRelation([], ["Someone Else"])).toBe("unknown");
  });
});
