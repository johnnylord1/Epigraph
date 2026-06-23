export type LibraryVisibilityCallback = (visible: boolean) => void;

type TargetCallbacks = Map<Element, Set<LibraryVisibilityCallback>>;

type RegistryEntry = {
  observer: IntersectionObserver;
  targets: TargetCallbacks;
};

const registries = new WeakMap<HTMLElement, RegistryEntry>();
let activeContainerCount = 0;
let observedElementCount = 0;

function createRegistryEntry(scrollContainer: HTMLElement): RegistryEntry {
  const targets: TargetCallbacks = new Map();
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const callbacks = targets.get(entry.target);
      if (!callbacks) continue;
      const visible = entry.isIntersecting && entry.intersectionRatio > 0;
      for (const callback of callbacks) callback(visible);
    }
  }, {
    root: scrollContainer,
    rootMargin: "0px",
    threshold: 0,
  });

  activeContainerCount += 1;
  return { observer, targets };
}

export function observeLibraryCardVisibility(
  node: Element,
  callback: LibraryVisibilityCallback,
  scrollContainer: HTMLElement,
): () => void {
  if (typeof IntersectionObserver === "undefined") {
    callback(true);
    return () => {};
  }

  let registry = registries.get(scrollContainer);
  if (!registry) {
    registry = createRegistryEntry(scrollContainer);
    registries.set(scrollContainer, registry);
  }

  let callbacks = registry.targets.get(node);
  if (!callbacks) {
    callbacks = new Set();
    registry.targets.set(node, callbacks);
    registry.observer.observe(node);
    observedElementCount += 1;
  }
  callbacks.add(callback);

  let subscribed = true;
  return () => {
    if (!subscribed) return;
    subscribed = false;

    const activeRegistry = registries.get(scrollContainer);
    const activeCallbacks = activeRegistry?.targets.get(node);
    if (!activeRegistry || !activeCallbacks) return;

    activeCallbacks.delete(callback);
    if (activeCallbacks.size > 0) return;

    activeRegistry.observer.unobserve(node);
    activeRegistry.targets.delete(node);
    observedElementCount = Math.max(0, observedElementCount - 1);

    if (activeRegistry.targets.size > 0) return;
    activeRegistry.observer.disconnect();
    registries.delete(scrollContainer);
    activeContainerCount = Math.max(0, activeContainerCount - 1);
  };
}

export function getLibraryVisibilityRegistryStats(): {
  activeContainerCount: number;
  observedElementCount: number;
} {
  return { activeContainerCount, observedElementCount };
}
