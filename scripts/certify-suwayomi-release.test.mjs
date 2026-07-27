import assert from "node:assert/strict";
import { test } from "node:test";
import JSZip from "jszip";
import {
  buildAllowlistCandidate,
  canonicalizeSchema,
  checksumForAsset,
  DEFAULT_CERTIFICATION_VERSION,
  evaluateRuntimeSchema,
  normalizeVersion,
  readJarVersion,
  redactDiagnosticText,
  sampleProcessMetrics,
  sha256,
  validateHealthPayload,
} from "./certify-suwayomi-release.mjs";

test("normalizes only complete Suwayomi versions", () => {
  assert.equal(DEFAULT_CERTIFICATION_VERSION, "v2.3.2243");
  assert.equal(normalizeVersion("v2.1.1867"), "v2.1.1867");
  assert.throws(() => normalizeVersion("2.1.1867"));
  assert.throws(() => normalizeVersion("v2.1"));
});

function schemaFixture({ reverse = false, descriptions = false } = {}) {
  const fields = [
    { name: "sources", type: { kind: "OBJECT", name: "SourceConnection" }, args: [] },
    { name: "extensions", type: { kind: "OBJECT", name: "ExtensionConnection" }, args: [] },
    { name: "mangas", type: { kind: "OBJECT", name: "MangaConnection" }, args: [] },
    { name: "extensionStores", type: { kind: "LIST", name: null, ofType: { kind: "OBJECT", name: "ExtensionStore" } }, args: [] },
  ];
  const mutationFields = [
    { name: "installExternalExtension", type: { kind: "OBJECT", name: "Extension" }, args: [] },
    { name: "updateExtension", type: { kind: "OBJECT", name: "Extension" }, args: [] },
    { name: "uninstallExtension", type: { kind: "SCALAR", name: "Boolean" }, args: [] },
  ];
  const types = [
    { kind: "OBJECT", name: "Query", fields, description: descriptions ? "Changed docs" : undefined },
    { kind: "OBJECT", name: "Mutation", fields: mutationFields },
    { kind: "OBJECT", name: "ExtensionStore", fields: [{ name: "id", type: { kind: "SCALAR", name: "String" }, args: [] }] },
  ];
  return {
    data: {
      __schema: {
        queryType: { name: "Query" },
        mutationType: { name: "Mutation" },
        subscriptionType: null,
        types: reverse
          ? types.toReversed().map((type) => ({ ...type, fields: type.fields?.toReversed() }))
          : types,
      },
    },
  };
}

test("canonicalizes schemas without descriptions or source ordering", () => {
  const normal = canonicalizeSchema(schemaFixture());
  const reordered = canonicalizeSchema(schemaFixture({ reverse: true, descriptions: true }));
  assert.equal(normal, reordered);
  assert.equal(sha256(normal), sha256(reordered));
  assert.doesNotMatch(normal, /Changed docs/);
});

test("evaluates semantic contract and observed capabilities", () => {
  const result = evaluateRuntimeSchema(schemaFixture());
  assert.equal(result.contract.passed, true);
  assert.equal(result.capabilities.extensionStores.observed, true);
  assert.equal(result.capabilities.legacyExtensionRepositories.observed, false);
  assert.equal(result.capabilities.extensionInstallMutation.observed, true);
  assert.equal(result.capabilities.extensionUpdateMutation.observed, true);
  assert.equal(result.capabilities.extensionUninstallMutation.observed, true);
  assert.deepEqual(result.operations.queries, ["extensionStores", "extensions", "mangas", "sources"]);

  const incompatible = schemaFixture();
  incompatible.data.__schema.types[0].fields = incompatible.data.__schema.types[0].fields.filter(
    (field) => field.name !== "sources",
  );
  assert.equal(evaluateRuntimeSchema(incompatible).contract.passed, false);
});

test("samples the certification process without exposing command output", async () => {
  const metrics = await sampleProcessMetrics(process.pid);
  assert.equal(metrics.available, true);
  assert.ok(metrics.workingSetBytes > 0);
  assert.ok(metrics.virtualMemoryBytes > 0);
});

test("redacts disposable roots, user paths, URL credentials, and secrets", () => {
  const runtimeRoot = `${process.platform === "win32" ? "C:\\Temp" : "/tmp"}/candidate-secret`;
  const text = [
    `root=${runtimeRoot}`,
    `lowercase-root=${runtimeRoot.toLowerCase()}`,
    "endpoint=https://alice:password@example.invalid/graphql",
    "Authorization: Bearer bearer-value",
    "cookie=session-value",
    '"token": "json-token-value"',
  ].join("\n");
  const redacted = redactDiagnosticText(text, [runtimeRoot]);
  assert.doesNotMatch(redacted, /candidate-secret|alice:password|bearer-value|session-value|json-token-value/);
  assert.match(redacted, /<runtime-root>|<temp-dir>/);
  assert.match(redacted, /Authorization=<redacted>/);
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
