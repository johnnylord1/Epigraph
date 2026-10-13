/** Movement, in pixels, before a press on a rail becomes a drag instead of a click. */
const DRAG_THRESHOLD = 6;
const LINE_HEIGHT = 16;

/**
 * Lets a horizontal rail be dragged with the mouse from any of its cards and scrolled with the
 * vertical wheel. At either end the wheel goes back to scrolling the page, and a press that turned
 * into a drag does not open the card it started on.
 */
export function railScroll(node: HTMLElement) {
  let pointerId: number | null = null;
  let startX = 0;
  let startLeft = 0;
  let dragged = false;
  let resetTimer: ReturnType<typeof setTimeout> | null = null;

  function onPointerDown(event: PointerEvent) {
    if (event.pointerType !== "mouse" || event.button !== 0) return;
    if (resetTimer) clearTimeout(resetTimer);
    pointerId = event.pointerId;
    startX = event.clientX;
    startLeft = node.scrollLeft;
    dragged = false;
  }

  function onPointerMove(event: PointerEvent) {
    if (event.pointerId !== pointerId) return;
    const dx = event.clientX - startX;
    if (!dragged) {
      if (Math.abs(dx) < DRAG_THRESHOLD) return;
      dragged = true;
      node.dataset.railDragging = "";
      try { node.setPointerCapture(event.pointerId); } catch { /* the pointer is already gone */ }
    }
    node.scrollLeft = startLeft - dx;
  }

  function onPointerEnd(event: PointerEvent) {
    if (event.pointerId !== pointerId) return;
    pointerId = null;
    if (!dragged) return;
    delete node.dataset.railDragging;
    try { node.releasePointerCapture(event.pointerId); } catch { /* not captured */ }
    // The click that ends a drag arrives right after pointerup; later clicks are the user's again.
    resetTimer = setTimeout(() => { dragged = false; resetTimer = null; }, 0);
  }

  function onClick(event: MouseEvent) {
    if (!dragged) return;
    event.preventDefault();
    event.stopPropagation();
  }

  function onDragStart(event: DragEvent) {
    // Covers are images; the browser's own image drag would cancel the rail drag.
    event.preventDefault();
  }

  function onWheel(event: WheelEvent) {
    if (event.ctrlKey || event.shiftKey || event.altKey || event.metaKey) return;
    if (Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return;
    const max = node.scrollWidth - node.clientWidth;
    if (max <= 0) return;
    const delta = event.deltaMode === 1 ? event.deltaY * LINE_HEIGHT
      : event.deltaMode === 2 ? event.deltaY * node.clientWidth
      : event.deltaY;
    if ((delta < 0 && node.scrollLeft <= 0) || (delta > 0 && node.scrollLeft >= max - 1)) return;
    event.preventDefault();
    node.scrollLeft = Math.max(0, Math.min(max, node.scrollLeft + delta));
  }

  node.addEventListener("pointerdown", onPointerDown);
  node.addEventListener("pointermove", onPointerMove);
  node.addEventListener("pointerup", onPointerEnd);
  node.addEventListener("pointercancel", onPointerEnd);
  node.addEventListener("click", onClick, true);
  node.addEventListener("dragstart", onDragStart);
  node.addEventListener("wheel", onWheel, { passive: false });

  return {
    destroy() {
      if (resetTimer) clearTimeout(resetTimer);
      node.removeEventListener("pointerdown", onPointerDown);
      node.removeEventListener("pointermove", onPointerMove);
      node.removeEventListener("pointerup", onPointerEnd);
      node.removeEventListener("pointercancel", onPointerEnd);
      node.removeEventListener("click", onClick, true);
      node.removeEventListener("dragstart", onDragStart);
      node.removeEventListener("wheel", onWheel);
    },
  };
}
