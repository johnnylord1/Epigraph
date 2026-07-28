import { describe, expect, it } from "vitest";
import { resolveServiceIconUrl, serviceIconFallbackUrl, serviceIconPath } from "./serviceIconResolver";

describe("service icon resolver", () => {
  it("normalizes source, extension, and tracker icon paths", () => {
    expect(serviceIconPath(" /api/v1/source/1/icon ")).toBe("/api/v1/source/1/icon");
    expect(serviceIconPath({ iconUrl: " /icons/source.png " })).toBe("/icons/source.png");
    expect(serviceIconPath({ icon: " /icons/tracker.png " })).toBe("/icons/tracker.png");
    expect(serviceIconPath(null)).toBe("");
  });

  it("returns a stable fallback for empty icons", () => {
    const first = resolveServiceIconUrl("", { kind: "source" });
    const second = serviceIconFallbackUrl("source");

    expect(first).toBe(second);
    expect(first).toContain("data:image/svg+xml");
  });

  it("resolves real remote paths through the server url helper", () => {
    expect(resolveServiceIconUrl("/api/v1/extension/icon", { kind: "extension" })).toContain("/api/v1/extension/icon");
  });

  it("does not rewrite bundled app assets as Suwayomi server files", () => {
    expect(resolveServiceIconUrl("/assets/hardcover.abc123.png", { kind: "tracker" }))
      .toBe("/assets/hardcover.abc123.png");
    expect(resolveServiceIconUrl("/src/assets/service-icons/hardcover.png", { kind: "tracker" }))
      .toBe("/src/assets/service-icons/hardcover.png");
  });

  it("can opt out of fallback for callers that intentionally hide missing icons", () => {
    expect(resolveServiceIconUrl(null, { fallback: false })).toBe("");
  });
});
