/**
 * Idle motion pauses every animation, including one-shot entrances that start at opacity 0.
 * Content mounted while motion is idle (the next first-run step, data that finished loading)
 * would stay frozen invisible until the pointer moved. This wakes motion when elements are
 * inserted under `root` and `shouldWake` allows it; the caller's idle timer pauses motion again
 * once the UI settles. Returns a function that stops observing.
 */
export function observeMotionWake(root: Node, shouldWake: () => boolean, wake: () => void): () => void {
  const observer = new MutationObserver((records) => {
    if (!shouldWake()) return;
    if (records.some((record) => Array.from(record.addedNodes).some((node) => node.nodeType === Node.ELEMENT_NODE))) {
      wake();
    }
  });
  observer.observe(root, { childList: true, subtree: true });
  return () => observer.disconnect();
}
