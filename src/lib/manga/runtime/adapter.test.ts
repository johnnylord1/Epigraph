import { describe, expect, test, vi } from "vitest";

import { SuwayomiAdapter } from "./adapter";
import { CompatibilityProfileV21 } from "./compatibility";
import type { GraphQLExecuteOptions, GraphQLOperation, GraphQLTransport } from "./transport";

function namedType(name: string) {
  return { kind: "OBJECT", name, ofType: null };
}

function schemaField(name: string) {
  return {
    name,
    isDeprecated: false,
    args: [],
    type: namedType("String"),
  };
}

function compatibleSchema() {
  const queryFields = ["aboutServer", "settings", "extensions", "sources"];
  const mutationFields = [
    "fetchExtensions",
    "updateExtension",
    "fetchSourceManga",
    "fetchManga",
    "fetchChapters",
    "fetchChapterPages",
    "setSettings",
  ];
  const extensionFields = [
    "pkgName",
    "name",
    "lang",
    "versionName",
    "versionCode",
    "isInstalled",
    "isObsolete",
    "hasUpdate",
    "iconUrl",
    "repo",
    "apkName",
  ];
  const sourceFields = [
    "id",
    "name",
    "lang",
    "displayName",
    "iconUrl",
    "isNsfw",
    "supportsLatest",
    "isConfigurable",
    "extension",
    "preferences",
  ];
  return {
    __schema: {
      queryType: { name: "Query" },
      mutationType: { name: "Mutation" },
      types: [
        {
          kind: "OBJECT",
          name: "Query",
          fields: queryFields.map(schemaField),
          inputFields: null,
          enumValues: null,
        },
        {
          kind: "OBJECT",
          name: "Mutation",
          fields: mutationFields.map(schemaField),
          inputFields: null,
          enumValues: null,
        },
        {
          kind: "OBJECT",
          name: "ExtensionType",
          fields: extensionFields.map(schemaField),
          inputFields: null,
          enumValues: null,
        },
        {
          kind: "OBJECT",
          name: "SourceType",
          fields: sourceFields.map(schemaField),
          inputFields: null,
          enumValues: null,
        },
      ],
    },
  };
}

class FixtureTransport implements GraphQLTransport {
  readonly calls: string[] = [];

  constructor(private readonly fixtures: Readonly<Record<string, unknown>>) {}

  getEndpointIdentity(): string {
    return "http://127.0.0.1:4567/api/graphql";
  }

  async execute<TVariables, TResult>(
    operation: GraphQLOperation<TVariables, TResult>,
    _variables: TVariables,
    _options?: GraphQLExecuteOptions,
  ): Promise<TResult> {
    this.calls.push(operation.name);
    return operation.decode(this.fixtures[operation.name]);
  }
}

describe("SuwayomiAdapter", () => {
  test("shares contract inspection across runtime info and capabilities", async () => {
    const transport = new FixtureTransport({
      AethonRuntimeContract: compatibleSchema(),
      AethonRuntimeInfo: {
        aboutServer: {
          name: "Suwayomi",
          version: "v2.1.1867",
          revision: "1867",
          buildType: "Stable",
          buildTime: 1,
        },
      },
    });
    const adapter = new SuwayomiAdapter(transport, new CompatibilityProfileV21());

    const [info, capabilities] = await Promise.all([
      adapter.getRuntimeInfo(),
      adapter.getCapabilities(),
    ]);

    expect(info).toMatchObject({
      version: "v2.1.1867",
      profileId: "suwayomi-v21",
      compatible: true,
    });
    expect(info.schemaHash).toMatch(/^[a-f0-9]{64}$/);
    expect(capabilities.sourcePreferences).toBe(true);
    expect(transport.calls.filter((name) => name === "AethonRuntimeContract")).toHaveLength(1);
  });

  test("builds a stable runtime fingerprint without using process identity", async () => {
    const transport = new FixtureTransport({
      AethonRuntimeContract: compatibleSchema(),
      AethonRuntimeInfo: {
        aboutServer: {
          name: "Suwayomi",
          version: "v2.1.1867",
          revision: "1867",
          buildType: "Stable",
          buildTime: 1,
        },
      },
    });
    const adapter = new SuwayomiAdapter(
      transport,
      new CompatibilityProfileV21(),
      undefined,
      { localRuntimeGeneration: "4" },
    );

    await expect(adapter.getRuntimeFingerprint()).resolves.toMatchObject({
      serverVersion: "v2.1.1867",
      canonicalSchemaHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      capabilitiesHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      endpointIdentity: "http://127.0.0.1:4567/api/graphql",
      instanceNonce: null,
      localRuntimeGeneration: "4",
    });
    expect(transport.calls).not.toContain(expect.stringContaining("pid"));
  });

  test("blocks domain operations when the semantic contract is incomplete", async () => {
    const incomplete = compatibleSchema();
    incomplete.__schema.types[0]!.fields = incomplete.__schema.types[0]!.fields.filter(
      (item) => item.name !== "sources",
    );
    const transport = new FixtureTransport({
      AethonRuntimeContract: incomplete,
      AethonLegacyExtensionStores: {
        settings: { extensionRepos: [] },
      },
    });
    const adapter = new SuwayomiAdapter(transport, new CompatibilityProfileV21());

    await expect(adapter.listStores()).rejects.toMatchObject({
      code: "RUNTIME_INCOMPATIBLE",
      details: { missingQueries: "sources" },
    });
    expect(transport.calls).not.toContain("AethonLegacyExtensionStores");
  });

  test("delegates typed extension actions without exposing GraphQL to callers", async () => {
    const transport = new FixtureTransport({
      AethonRuntimeContract: compatibleSchema(),
      AethonInstallExtension: {
        updateExtension: {
          extension: {
            pkgName: "eu.kanade.tachiyomi.extension.en.demo",
            name: "Demo",
            lang: "en",
            versionName: "1.0.0",
            versionCode: 1,
            isInstalled: true,
            isObsolete: false,
            hasUpdate: false,
            iconUrl: null,
            repo: "https://example.test/repo.json",
            apkName: "demo.apk",
          },
        },
      },
    });
    const executeSpy = vi.spyOn(transport, "execute");
    const adapter = new SuwayomiAdapter(transport, new CompatibilityProfileV21());

    await adapter.installExtension({
      packageName: "eu.kanade.tachiyomi.extension.en.demo",
    });

    expect(executeSpy).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ name: "AethonInstallExtension", kind: "mutation" }),
      { id: "eu.kanade.tachiyomi.extension.en.demo" },
      { signal: undefined, timeoutMs: 60_000 },
    );
  });

  test("manages legacy repositories through the runtime boundary", async () => {
    const transport = new FixtureTransport({
      AethonRuntimeContract: compatibleSchema(),
      AethonLegacyExtensionStores: {
        settings: { extensionRepos: ["https://old.example/repo.json"] },
      },
      AethonLegacyAddExtensionStore: {
        setSettings: {
          settings: { extensionRepos: ["https://old.example/repo.json", "https://new.example/repo.json"] },
        },
      },
      AethonLegacyRemoveExtensionStore: {
        setSettings: {
          settings: { extensionRepos: ["https://new.example/repo.json"] },
        },
      },
    });
    const runtime = new SuwayomiAdapter(transport, new CompatibilityProfileV21());

    const added = await runtime.addStore({ indexUrl: "https://new.example/repo.json" });
    expect(added.indexUrl).toBe("https://new.example/repo.json");
    const removed = await runtime.removeStore("https://old.example/repo.json");
    expect(removed?.indexUrl).toBe("https://old.example/repo.json");
    expect(transport.calls).toEqual([
      "AethonRuntimeContract",
      "AethonLegacyExtensionStores",
      "AethonLegacyAddExtensionStore",
      "AethonLegacyExtensionStores",
      "AethonLegacyRemoveExtensionStore",
    ]);
  });
});
