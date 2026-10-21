import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "./tauri/invoke";
import { FIRST_RUN_STORAGE_KEY } from "./firstRun";
import { mirrorFirstRunMarker, restoreDurableFirstRunCompletion } from "./firstRunDurable";

vi.mock("./tauri/invoke", () => ({ invoke: vi.fn() }));

const scope = { profileId: "main", serverUrl: "http://127.0.0.1:4567" };
const complete = JSON.stringify({ version: 1, status: "complete", step: "complete", path: "backup" });
const pending = JSON.stringify({ version: 1, status: "pending", step: "discover", path: "backup" });

function memoryStorage(initial: string | null) {
  const values = new Map<string, string>();
  if (initial !== null) values.set(FIRST_RUN_STORAGE_KEY, initial);
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  };
}

beforeEach(() => {
  vi.mocked(invoke).mockReset();
});

describe("mirrorFirstRunMarker", () => {
  it("writes the current marker to the profile's file", async () => {
    vi.mocked(invoke).mockResolvedValue(undefined);
    await mirrorFirstRunMarker(scope, memoryStorage(complete));
    expect(invoke).toHaveBeenCalledWith("write_first_run_state", { contents: complete, ...scope });
  });

  it("waits for a resolved profile and ignores a failed write", async () => {
    await mirrorFirstRunMarker({ profileId: null, serverUrl: scope.serverUrl }, memoryStorage(complete));
    expect(invoke).not.toHaveBeenCalled();
    vi.mocked(invoke).mockRejectedValue(new Error("disk full"));
    await expect(mirrorFirstRunMarker(scope, memoryStorage(complete))).resolves.toBeUndefined();
  });
});

describe("restoreDurableFirstRunCompletion", () => {
  it("brings back a finished setup the WebView lost", async () => {
    vi.mocked(invoke).mockResolvedValue(complete);
    const storage = memoryStorage(pending);
    await expect(restoreDurableFirstRunCompletion(scope, storage)).resolves.toBe(true);
    expect(JSON.parse(storage.getItem(FIRST_RUN_STORAGE_KEY)!).status).toBe("complete");
    expect(invoke).toHaveBeenCalledWith("read_first_run_state", scope);
  });

  it("keeps setup open when the file has not seen it finish", async () => {
    vi.mocked(invoke).mockResolvedValue(pending);
    await expect(restoreDurableFirstRunCompletion(scope, memoryStorage(null))).resolves.toBe(false);
    vi.mocked(invoke).mockResolvedValue(null);
    await expect(restoreDurableFirstRunCompletion(scope, memoryStorage(null))).resolves.toBe(false);
  });

  it("leaves a setup the user started over from Settings open", async () => {
    vi.mocked(invoke).mockResolvedValue(complete);
    const reopened = JSON.stringify({ version: 1, status: "pending", step: "theme", path: null, cancellable: true });
    await expect(restoreDurableFirstRunCompletion(scope, memoryStorage(reopened))).resolves.toBe(false);
    expect(invoke).not.toHaveBeenCalled();
  });
});
