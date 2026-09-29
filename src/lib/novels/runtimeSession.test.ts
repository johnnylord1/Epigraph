import { expect, it } from "vitest";
import { NovelRuntimeSession } from "./runtimeSession";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

it("does not shut down another mounted consumer's runtime", async () => {
  let stops = 0;
  const session = new NovelRuntimeSession({ invoke: async <T, R>(_action: unknown, payload: T) => payload as unknown as R, stop: async () => { stops += 1; } });
  const releaseOld = session.acquire();
  const releaseNew = session.acquire();
  await releaseOld();
  await releaseOld();
  expect(stops).toBe(0);
  expect(await session.invoke("source.search", "result")).toBe("result");
  await releaseNew();
  expect(stops).toBe(1);
});

it("waits for an in-flight source request before shutting down", async () => {
  const gate = deferred();
  const events: string[] = [];
  const session = new NovelRuntimeSession({
    invoke: async <T, R>(_action: unknown, payload: T) => { events.push("request"); await gate.promise; events.push("result"); return payload as unknown as R; },
    stop: async () => { events.push("stop"); },
  });
  const release = session.acquire();
  const result = session.invoke("source.search", "result");
  const stopping = release();
  await Promise.resolve();
  expect(events).toEqual(["request"]);
  gate.resolve();
  expect(await result).toBe("result");
  await stopping;
  expect(events).toEqual(["request", "result", "stop"]);
});

it("does not start a new request inside an unfinished shutdown", async () => {
  const gate = deferred();
  const events: string[] = [];
  const session = new NovelRuntimeSession({
    invoke: async <T, R>(_action: unknown, payload: T) => { events.push("request"); return payload as unknown as R; },
    stop: async () => { events.push("stopping"); await gate.promise; events.push("stopped"); },
  });
  const stopping = session.stop();
  await Promise.resolve();
  const result = session.invoke("source.search", "result");
  await Promise.resolve();
  expect(events).toEqual(["stopping"]);
  gate.resolve();
  await stopping;
  expect(await result).toBe("result");
  expect(events).toEqual(["stopping", "stopped", "request"]);
});
