// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const appWindow = vi.hoisted(() => ({
  startDragging: vi.fn(async () => {}),
  toggleMaximize: vi.fn(async () => {}),
}));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => appWindow }));

import { handleWindowDragMouseDown } from "./windowDrag";

const INTERACTIVE = "button, [data-no-window-drag]";

function press(target: Element, init: MouseEventInit) {
  const event = new MouseEvent("mousedown", { bubbles: true, cancelable: true, ...init });
  let taken = false;
  target.addEventListener("mousedown", (e) => { taken = handleWindowDragMouseDown(e as MouseEvent, INTERACTIVE); }, { once: true });
  target.dispatchEvent(event);
  return { taken, event };
}

describe("handleWindowDragMouseDown", () => {
  let bar: HTMLElement;
  let button: HTMLButtonElement;

  beforeEach(() => {
    appWindow.startDragging.mockClear();
    appWindow.toggleMaximize.mockClear();
    document.body.innerHTML = `<header><span class="title">Library</span><button type="button"><span>Tab</span></button></header>`;
    bar = document.querySelector(".title")!;
    button = document.querySelector("button")!;
  });

  it("drags the window from an empty part of the bar", () => {
    const { taken, event } = press(bar, { button: 0, detail: 1 });
    expect(taken).toBe(true);
    expect(event.defaultPrevented).toBe(true);
    expect(appWindow.startDragging).toHaveBeenCalledTimes(1);
    expect(appWindow.toggleMaximize).not.toHaveBeenCalled();
  });

  it("toggles maximize on a double click", () => {
    press(bar, { button: 0, detail: 2 });
    expect(appWindow.toggleMaximize).toHaveBeenCalledTimes(1);
    expect(appWindow.startDragging).not.toHaveBeenCalled();
  });

  it("leaves presses on controls, other buttons and triple clicks to the page", () => {
    const onControl = press(button.querySelector("span")!, { button: 0, detail: 1 });
    const rightClick = press(bar, { button: 2, detail: 1 });
    const triple = press(bar, { button: 0, detail: 3 });
    for (const { taken, event } of [onControl, rightClick, triple]) {
      expect(taken).toBe(false);
      expect(event.defaultPrevented).toBe(false);
    }
    expect(appWindow.startDragging).not.toHaveBeenCalled();
    expect(appWindow.toggleMaximize).not.toHaveBeenCalled();
  });
});
