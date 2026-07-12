import assert from "node:assert/strict";
import { test } from "node:test";
import JSZip from "jszip";
import {
  buildAllowlistCandidate,
  checksumForAsset,
  normalizeVersion,
  readJarVersion,
  sha256,
  validateHealthPayload,
} from "./certify-suwayomi-release.mjs";

test("normalizes only complete Suwayomi versions", () => {
  assert.equal(normalizeVersion("v2.1.1867"), "v2.1.1867");
  assert.throws(() => normalizeVersion("2.1.1867"));
  assert.throws(() => normalizeVersion("v2.1"));
});

test("selects an exact checksum asset", () => {
  const hash = "a".repeat(64);
  const text = `${"b".repeat(64)}  other.jar\n${hash} *Suwayomi-Server-v2.1.1867.jar\n`;
  assert.equal(checksumForAsset(text, "Suwayomi-Server-v2.1.1867.jar"), hash);
  assert.throws(() => checksumForAsset(text, "missing.jar"));
});

test("reads the version declared by the JAR manifest", async () => {
  const archive = new JSZip();
  archive.file("META-INF/MANIFEST.MF", "Manifest-Version: 1.0\nSpecification-Version: v2.1.1867\n");
  const bytes = await archive.generateAsync({ type: "nodebuffer" });
  assert.equal(await readJarVersion(bytes), "v2.1.1867");
  assert.equal(sha256(bytes).length, 64);
});

test("builds a pinned allowlist candidate", () => {
  const candidate = buildAllowlistCandidate({
    version: "v2.1.1867",
    asset: "Suwayomi-Server-v2.1.1867.jar",
    sha256: "c".repeat(64),
    platforms: ["win32-x64", "darwin-arm64"],
  });
  assert.equal(candidate.sha256, "c".repeat(64));
  assert.match(candidate.notes, /win32-x64 and darwin-arm64/);
});

test("validates the same GraphQL shapes as the runtime updater", () => {
  assert.doesNotThrow(() => validateHealthPayload({ data: { __typename: "Query" } }, "typename"));
  assert.doesNotThrow(() => validateHealthPayload({ data: { sources: { nodes: [] } } }, "sources"));
  assert.throws(() => validateHealthPayload({ data: { typename: "Query" } }, "typename"));
  assert.throws(() => validateHealthPayload({ data: { sources: {} } }, "sources"));
  assert.throws(() => validateHealthPayload({ errors: [{ message: "failed" }] }, "sources"));
});
