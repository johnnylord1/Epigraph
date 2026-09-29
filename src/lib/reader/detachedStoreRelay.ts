// A detached reader window applies its own store changes at once and hands them to the main window, which
// persists them. The window follows what the main window saves through storage events; a save the main window
// made before it applied this window's change would briefly undo it, so unconfirmed changes are applied again.
import type { DetachedReaderClient } from "./detachedReaderClient";

type StoreMethod = (...args: any[]) => unknown;
type RelayedStore = object & { adoptPersistedReaderState(): void };
type Link = Pick<DetachedReaderClient, "notify" | "request">;

/** Changes the persisted state the window adopts would overwrite. */
const CONFIRMED_METHODS = ["updateSettings", "addBookmark", "removeBookmark"];
const NOTIFIED_METHODS = ["addHistory", "setBookProgress", "addBookBookmark", "removeBookBookmark"];

export function relayDetachedStoreMethods(store: RelayedStore, link: Link) {
  const target = store as unknown as Record<string, StoreMethod>;
  const local: Record<string, StoreMethod> = {};
  const unconfirmed: Array<{ method: string; args: unknown[] }> = [];

  for (const method of [...CONFIRMED_METHODS, ...NOTIFIED_METHODS]) {
    local[method] = target[method].bind(store);
    target[method] = (...args: unknown[]) => {
      const result = local[method](...args);
      if (!CONFIRMED_METHODS.includes(method)) {
        link.notify(method, args);
        return result;
      }
      const change = { method, args };
      unconfirmed.push(change);
      const confirmed = () => {
        const index = unconfirmed.indexOf(change);
        if (index >= 0) unconfirmed.splice(index, 1);
      };
      void link.request(method, args).then(confirmed, (error) => {
        confirmed();
        console.warn("Detached reader update was not saved:", error);
      });
      return result;
    };
  }
  // Only the main window knows the library categories and owns the book library file.
  target.checkAndMarkCompleted = (mangaId: unknown, chapters: unknown) => link.request("checkAndMarkCompleted", [mangaId, chapters]);
  target.flushBookLibraryPersistence = () => link.request("flushBookLibraryPersistence", []);
  target.setSettingsOpen = (next: unknown) => {
    link.notify("setSettingsOpen", [next === true]);
  };

  return {
    /** Takes the state the main window saved, keeping this window's changes it has not confirmed yet. */
    adoptPersistedState() {
      store.adoptPersistedReaderState();
      for (const change of unconfirmed) local[change.method](...change.args);
    },
  };
}
