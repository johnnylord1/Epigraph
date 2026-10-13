// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { railScroll } from "./railScroll";

function rail({ scrollWidth = 1000, clientWidth = 300 } = {}) {
  const node = document.createElement("div");
  Object.defineProperty(node, "scrollWidth", { configurable: true, value: scrollWidth });
  Object.defineProperty(node, "clientWidth", { configurable: true, value: clientWidth });
  let left = 0;
  Object.defineProperty(node, "scrollLeft", { configurable: true, get: () => left, set: (value: number) => { left = value; } });
  node.setPointerCapture = vi.fn();
  node.releasePointerCapture = vi.fn();
  const card = document.createElement("button");
  node.append(card);
  document.body.append(node);
  return { node, card, action: railScroll(node) };
}

function pointer(type: string, clientX: number) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX, button: 0 });
  Object.assign(event, { pointerId: 1, pointerType: "mouse" });
  return event;
}

describe("railScroll", () => {
  afterEach(() => {
    vi.useRealTimers();
    document.body.replaceChildren();
  });

  it("scrolls the rail while a card is dragged and keeps that card from opening", () => {
    vi.useFakeTimers();
    const { node, card } = rail();
    const open = vi.fn();
    card.addEventListener("click", open);
    node.scrollLeft = 100;

    card.dispatchEvent(pointer("pointerdown", 200));
    card.dispatchEvent(pointer("pointermove", 120));
    expect(node.scrollLeft).toBe(180);
    expect(node.hasAttribute("data-rail-dragging")).toBe(true);
    card.dispatchEvent(pointer("pointerup", 120));
    card.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(open).not.toHaveBeenCalled();
    expect(node.hasAttribute("data-rail-dragging")).toBe(false);

    vi.runAllTimers();
    card.dispatchEvent(pointer("pointerdown", 200));
    card.dispatchEvent(pointer("pointermove", 202));
    card.dispatchEvent(pointer("pointerup", 202));
    card.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("turns the vertical wheel into rail scrolling until an end, then leaves it to the page", () => {
    const { node } = rail();
    node.scrollLeft = 0;

    const down = new WheelEvent("wheel", { deltaY: 100, cancelable: true });
    node.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    expect(node.scrollLeft).toBe(100);

    const upAtStart = new WheelEvent("wheel", { deltaY: -100, cancelable: true });
    node.scrollLeft = 0;
    node.dispatchEvent(upAtStart);
    expect(upAtStart.defaultPrevented).toBe(false);

    node.scrollLeft = 700;
    const downAtEnd = new WheelEvent("wheel", { deltaY: 100, cancelable: true });
    node.dispatchEvent(downAtEnd);
    expect(downAtEnd.defaultPrevented).toBe(false);

    const zoom = new WheelEvent("wheel", { deltaY: 100, ctrlKey: true, cancelable: true });
    node.scrollLeft = 0;
    node.dispatchEvent(zoom);
    expect(zoom.defaultPrevented).toBe(false);
  });

  it("stops listening when the rail is removed", () => {
    const { node, action } = rail();
    action.destroy();
    node.scrollLeft = 0;
    const wheel = new WheelEvent("wheel", { deltaY: 100, cancelable: true });
    node.dispatchEvent(wheel);
    expect(wheel.defaultPrevented).toBe(false);
  });
});
