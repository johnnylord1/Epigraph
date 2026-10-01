import { describe, expect, test } from "vitest";
import { nextChaptersInReadingOrder } from "./nextChapters";

describe("nextChaptersInReadingOrder", () => {
  const order = ["c1", "c1-alt", "c2", "c3", "c4", "c5", "c6"];

  test("takes the start chapter and the ones after it", () => {
    expect(nextChaptersInReadingOrder(order, "c1", 5)).toEqual(["c1", "c1-alt", "c2", "c3", "c4"]);
    expect(nextChaptersInReadingOrder(order, "c5", 5)).toEqual(["c5", "c6"]);
  });

  test("takes nothing without a start chapter in the list", () => {
    expect(nextChaptersInReadingOrder(order, null, 5)).toEqual([]);
    expect(nextChaptersInReadingOrder(order, "missing", 5)).toEqual([]);
  });
});
