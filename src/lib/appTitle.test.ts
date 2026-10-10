import { describe, expect, it } from "vitest";
import { mainWindowTitle } from "./appTitle";

describe("mainWindowTitle", () => {
  it("marks development builds and keeps the port the startup client reads", () => {
    expect(mainWindowTitle("MAIN :4577", true)).toBe("Epigraph DEV [MAIN :4577]");
    expect(mainWindowTitle("MAIN :4567", false)).toBe("Epigraph [MAIN :4567]");
    expect(mainWindowTitle("MAIN :4577", true).match(/\[[^\]]*:(\d{2,5})\]/)?.[1]).toBe("4577");
  });
});
