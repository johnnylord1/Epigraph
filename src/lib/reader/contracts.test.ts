import { describe, expect, it } from "vitest";
import {
  DEFAULT_READER_PREFERENCES,
  canUseTextReflowControls,
  getReaderCapabilities,
} from "./contracts";

describe("reader contracts", () => {
  it("keeps text-reflow controls enabled for novel-html and epub", () => {
    expect(canUseTextReflowControls(getReaderCapabilities("novel-html"))).toBe(true);
    expect(canUseTextReflowControls(getReaderCapabilities("epub"))).toBe(true);
  });

  it("keeps pdf-specific capabilities separate from text-reflow controls", () => {
    const pdf = getReaderCapabilities("pdf");
    expect(canUseTextReflowControls(pdf)).toBe(false);
    expect(pdf.supportsZoom).toBe(true);
    expect(pdf.supportsPageFit).toBe(true);
    expect(pdf.supportsBookmarksPanel).toBe(true);
  });

  it("ships a stable default reader preference contract", () => {
    expect(DEFAULT_READER_PREFERENCES.universal.theme).toBe("dark");
    expect(DEFAULT_READER_PREFERENCES.textReflow.fontSizePx).toBeGreaterThan(0);
    expect(DEFAULT_READER_PREFERENCES.pdf.fitMode).toBe("page-width");
  });
});
