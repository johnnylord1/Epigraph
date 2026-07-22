const FOCUSABLE_SELECTOR = [
  "button:not([disabled])",
  "a[href]",
  "input:not([disabled]):not([type=\"hidden\"])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[contenteditable=\"true\"]",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

interface DialogFocusBoundaryOptions {
  dialog: HTMLElement;
  isolationRoot: HTMLElement;
  initialFocus?: HTMLElement | null;
}

function isFocusable(element: HTMLElement): boolean {
  return element.tabIndex >= 0
    && !element.hidden
    && element.getAttribute("aria-hidden") !== "true"
    && element.getAttribute("aria-disabled") !== "true"
    && !element.closest("[hidden], [inert], [aria-hidden=\"true\"]");
}

function focusableElements(dialog: HTMLElement): HTMLElement[] {
  return Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(isFocusable);
}

export function createDialogFocusBoundary({
  dialog,
  isolationRoot,
  initialFocus = null,
}: DialogFocusBoundaryOptions): () => void {
  const ownerDocument = dialog.ownerDocument;
  const ownerWindow = ownerDocument.defaultView ?? window;
  const previousFocus = ownerDocument.activeElement instanceof HTMLElement
    ? ownerDocument.activeElement
    : null;
  const inertedSiblings: HTMLElement[] = [];
  let branch = isolationRoot;

  while (branch.parentElement) {
    const parent = branch.parentElement;
    for (const sibling of Array.from(parent.children)) {
      if (sibling === branch || !(sibling instanceof HTMLElement) || sibling.inert) continue;
      sibling.inert = true;
      inertedSiblings.push(sibling);
    }
    branch = parent;
    if (parent === ownerDocument.body) break;
  }

  const initialFocusTimer = ownerWindow.setTimeout(() => {
    const target = initialFocus && isFocusable(initialFocus)
      ? initialFocus
      : focusableElements(dialog)[0] ?? dialog;
    target.focus({ preventScroll: true });
  });

  function handleKeydown(event: KeyboardEvent) {
    if (event.key !== "Tab") return;

    const focusable = focusableElements(dialog);
    if (focusable.length === 0) {
      event.preventDefault();
      dialog.focus({ preventScroll: true });
      return;
    }

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = ownerDocument.activeElement;
    if (event.shiftKey && (active === first || !dialog.contains(active))) {
      event.preventDefault();
      last.focus({ preventScroll: true });
    } else if (!event.shiftKey && (active === last || !dialog.contains(active))) {
      event.preventDefault();
      first.focus({ preventScroll: true });
    }
  }

  ownerDocument.addEventListener("keydown", handleKeydown, true);

  return () => {
    ownerWindow.clearTimeout(initialFocusTimer);
    ownerDocument.removeEventListener("keydown", handleKeydown, true);
    for (const sibling of inertedSiblings) sibling.inert = false;
    if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
  };
}
