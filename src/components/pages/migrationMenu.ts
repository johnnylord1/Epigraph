// A migration row menu floats over the dialog instead of taking room in the list, so opening it
// never grows or scrolls the dialog. It opens under its button, or above it when the dialog ends
// first, and closes on a press outside it, or when the list scrolls or the window resizes rather
// than drifting from its button.
export function floatMenu(menu: HTMLElement, onClose: () => void) {
  let close = onClose;
  const trigger = menu.parentElement?.querySelector<HTMLElement>(".mg-icon-btn");
  const body = menu.closest<HTMLElement>(".mg-body");
  if (!trigger) return;
  const anchor = trigger.getBoundingClientRect();
  const bounds = menu.closest<HTMLElement>(".mg-modal")?.getBoundingClientRect();
  const floor = Math.min(bounds?.bottom ?? window.innerHeight, window.innerHeight) - 8;
  menu.style.left = "0px";
  menu.style.top = "0px";
  // Where (0, 0) lands, so the placement stays right even under a transformed ancestor.
  const origin = menu.getBoundingClientRect();
  const below = anchor.bottom + 6;
  const above = anchor.top - 6 - origin.height;
  const opensUp = below + origin.height > floor && above >= 8;
  menu.dataset.side = opensUp ? "top" : "bottom";
  menu.style.left = `${Math.max(8, anchor.right - origin.width) - origin.left}px`;
  menu.style.top = `${(opensUp ? above : below) - origin.top}px`;
  const onDismiss = () => close();
  const closeOutside = (event: PointerEvent) => {
    const target = event.target as Node | null;
    if (target && !menu.contains(target) && !trigger.contains(target)) close();
  };
  body?.addEventListener("scroll", onDismiss, { passive: true });
  window.addEventListener("resize", onDismiss);
  document.addEventListener("pointerdown", closeOutside, true);
  return {
    update(next: () => void) { close = next; },
    destroy() {
      body?.removeEventListener("scroll", onDismiss);
      window.removeEventListener("resize", onDismiss);
      document.removeEventListener("pointerdown", closeOutside, true);
    },
  };
}
