import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

describe("syncd session revalidation at startup", () => {
  // Releasing the in-flight guard right after a failure re-ran the effect at once, so a Core that was not
  // running yet was retried in a tight loop that starved the UI thread.
  test("a failed revalidation waits before it is retried", () => {
    const app = readFileSync(resolve(process.cwd(), "src/App.svelte"), "utf8").replace(/\r\n/g, "\n");
    const start = app.indexOf('invoke("syncd_revalidate_persisted_sync_sessions"');
    const block = app.slice(start, app.indexOf("});\n  });", start));

    expect(start).toBeGreaterThanOrEqual(0);
    expect(app).toContain("const SYNCD_REVALIDATION_RETRY_MS = 30_000;");
    expect(block).toContain("failed = true;");
    expect(block).toContain("if (failed) window.setTimeout(release, SYNCD_REVALIDATION_RETRY_MS);");
  });
});
