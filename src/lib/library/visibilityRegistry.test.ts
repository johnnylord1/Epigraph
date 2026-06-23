import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getLibraryVisibilityRegistryStats,
  observeLibraryCardVisibility,
} from "./visibilityRegistry";

class MockIntersectionObserver {
  static instances: MockIntersectionObserver[] = [];

  readonly observed = new Set<Element>();
  disconnected = false;

  constructor(
    private readonly callback: IntersectionObserverCallback,
    readonly options?: IntersectionObserverInit,
  ) {
    MockIntersectionObserver.instances.push(this);
  }

  observe(node: Element) {
    this.observed.add(node);
  }

  unobserve(node: Element) {
    this.observed.delete(node);
  }

  disconnect() {
    this.disconnected = true;
    this.observed.clear();
  }

  trigger(node: Element, visible: boolean) {
    this.callback([{
      target: node,
      isIntersecting: visible,
      intersectionRatio: visible ? 1 : 0,
    } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
  }
}

describe("library visibility registry", () => {
  beforeEach(() => {
    MockIntersectionObserver.instances = [];
    vi.stubGlobal("IntersectionObserver", MockIntersectionObserver);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    expect(getLibraryVisibilityRegistryStats()).toEqual({
      activeContainerCount: 0,
      observedElementCount: 0,
    });
  });

  it("shares one observer per scroll container", () => {
    const container = {} as HTMLElement;
    const firstNode = {} as Element;
    const secondNode = {} as Element;

    const unsubscribeFirst = observeLibraryCardVisibility(firstNode, () => {}, container);
    const unsubscribeSecond = observeLibraryCardVisibility(secondNode, () => {}, container);

    expect(MockIntersectionObserver.instances).toHaveLength(1);
    expect(getLibraryVisibilityRegistryStats()).toEqual({
      activeContainerCount: 1,
      observedElementCount: 2,
    });

    unsubscribeFirst();
    unsubscribeSecond();
    expect(MockIntersectionObserver.instances[0]?.disconnected).toBe(true);
  });

  it("unregisters callbacks and never calls them again", () => {
    const container = {} as HTMLElement;
    const node = {} as Element;
    const callback = vi.fn();
    const unsubscribe = observeLibraryCardVisibility(node, callback, container);
    const observer = MockIntersectionObserver.instances[0]!;

    observer.trigger(node, true);
    expect(callback).toHaveBeenLastCalledWith(true);

    unsubscribe();
    unsubscribe();
    observer.trigger(node, false);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("keeps other cards alive when one card is destroyed", () => {
    const container = {} as HTMLElement;
    const firstNode = {} as Element;
    const secondNode = {} as Element;
    const secondCallback = vi.fn();

    const unsubscribeFirst = observeLibraryCardVisibility(firstNode, () => {}, container);
    const unsubscribeSecond = observeLibraryCardVisibility(secondNode, secondCallback, container);
    const observer = MockIntersectionObserver.instances[0]!;

    unsubscribeFirst();
    expect(observer.disconnected).toBe(false);
    observer.trigger(secondNode, true);
    expect(secondCallback).toHaveBeenCalledWith(true);

    unsubscribeSecond();
  });
});
