import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(resolve(process.cwd(), "src/App.svelte"), "utf8");

describe("App syncd replication listener", () => {
  it("listens on Home, which shows book progress", () => {
    const condition = source.slice(source.indexOf("const shouldListenToSyncdReplication ="));
    expect(condition.slice(0, condition.indexOf(";"))).toContain('store.navPage === "home"');
  });

  it("catches up on changes applied while no view was listening", () => {
    const attach = source.slice(source.indexOf("syncdListenersPromise = (async () => {"));
    const body = attach.slice(0, attach.indexOf("})().finally("));

    expect(body).toContain("syncdGetReplicationState(profileId)");
    expect(body).toContain("handleReplicationState(snapshot)");
    expect(body.indexOf("listenSyncdReplicationState((payload)")).toBeLessThan(
      body.indexOf("syncdGetReplicationState(profileId)"),
    );
  });
});
