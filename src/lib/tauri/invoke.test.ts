import { afterEach, describe, expect, it, vi } from "vitest";

const tauriInvoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauriInvoke }));

import { invoke, setInvokeRelay } from "./invoke";

afterEach(() => {
  setInvokeRelay(null);
  tauriInvoke.mockReset();
});

describe("invoke relay", () => {
  it("goes straight to Tauri without a relay", async () => {
    tauriInvoke.mockResolvedValue("direct");
    await expect(invoke("read_book_library_state", { a: 1 })).resolves.toBe("direct");
    expect(tauriInvoke).toHaveBeenCalledWith("read_book_library_state", { a: 1 });
  });

  it("uses the relay for commands it handles and Tauri for the rest", async () => {
    const relay = vi.fn((cmd: string) => (cmd === "relayed" ? Promise.resolve("via main") : null));
    setInvokeRelay(relay);
    tauriInvoke.mockResolvedValue("direct");
    await expect(invoke("relayed", { b: 2 })).resolves.toBe("via main");
    expect(relay).toHaveBeenCalledWith("relayed", { b: 2 });
    expect(tauriInvoke).not.toHaveBeenCalled();
    await expect(invoke("plugin:http|fetch")).resolves.toBe("direct");
    expect(tauriInvoke).toHaveBeenCalledTimes(1);
  });
});
