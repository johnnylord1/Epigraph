import { describe, expect, it } from "vitest";
import { canRunLibraryMotion, type LibraryMotionGateInput } from "./motionGate";

const openGate: LibraryMotionGateInput = {
  libraryVisible: true,
  panelActive: true,
  windowFocused: true,
  shellIdle: false,
  cardActuallyVisible: true,
  motionEnabled: true,
};

describe("library motion gate", () => {
  it("runs only when every gate is open", () => {
    expect(canRunLibraryMotion(openGate)).toBe(true);
  });

  it.each([
    ["libraryVisible", false],
    ["panelActive", false],
    ["windowFocused", false],
    ["shellIdle", true],
    ["cardActuallyVisible", false],
    ["motionEnabled", false],
  ] as const)("stops motion when %s closes", (key, value) => {
    expect(canRunLibraryMotion({ ...openGate, [key]: value })).toBe(false);
  });
});
