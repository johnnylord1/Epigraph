export type ReaderCommandScope = "manga" | "book" | "novel";

export type ReaderCommandHandler = (event: KeyboardEvent) => void;

export function isReaderControlKeyboardTarget(target: EventTarget | null): boolean {
  if (!target || typeof target !== "object") return false;
  const element = target as {
    tagName?: unknown;
    isContentEditable?: unknown;
    closest?: (selector: string) => Element | null;
  };
  if (element.isContentEditable === true) return true;
  const tagName = typeof element.tagName === "string" ? element.tagName.toLowerCase() : "";
  if (["input", "textarea", "select", "button", "a", "summary"].includes(tagName)) return true;
  if (typeof element.closest !== "function") return false;
  return Boolean(element.closest("[contenteditable='true'], [role='button'], [role='option'], [role='slider']"));
}

interface KeyboardEventHost {
  addEventListener(type: "keydown", listener: (event: KeyboardEvent) => void): void;
  removeEventListener(type: "keydown", listener: (event: KeyboardEvent) => void): void;
}

interface ActiveReaderCommandHandler {
  token: symbol;
  scope: ReaderCommandScope;
  handler: ReaderCommandHandler;
}

export function createReaderCommandDispatcher(host: KeyboardEventHost) {
  let active: ActiveReaderCommandHandler | null = null;
  let listening = false;

  const dispatch = (event: KeyboardEvent) => {
    active?.handler(event);
  };

  const syncListener = () => {
    if (active && !listening) {
      host.addEventListener("keydown", dispatch);
      listening = true;
    } else if (!active && listening) {
      host.removeEventListener("keydown", dispatch);
      listening = false;
    }
  };

  return {
    register(scope: ReaderCommandScope, handler: ReaderCommandHandler) {
      const token = Symbol(scope);
      active = { token, scope, handler };
      syncListener();

      return () => {
        if (active?.token !== token) return;
        active = null;
        syncListener();
      };
    },
    hasActiveScope() {
      return active !== null;
    },
    activeScope() {
      return active?.scope ?? null;
    },
    dispose() {
      active = null;
      syncListener();
    },
  };
}

type ReaderCommandDispatcher = ReturnType<typeof createReaderCommandDispatcher>;

let browserDispatcher: ReaderCommandDispatcher | null = null;

function getBrowserDispatcher(): ReaderCommandDispatcher | null {
  if (browserDispatcher) return browserDispatcher;
  if (typeof window === "undefined") return null;
  browserDispatcher = createReaderCommandDispatcher(window);
  return browserDispatcher;
}

export function registerReaderCommandHandler(
  scope: ReaderCommandScope,
  handler: ReaderCommandHandler,
): () => void {
  return getBrowserDispatcher()?.register(scope, handler) ?? (() => {});
}

export function hasActiveReaderCommandScope(): boolean {
  return getBrowserDispatcher()?.hasActiveScope() ?? false;
}
