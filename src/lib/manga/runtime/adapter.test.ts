import { describe, expect, test, vi } from "vitest";

import { SuwayomiAdapter } from "./adapter";
import { CompatibilityProfileV21 } from "./compatibility";
import type { GraphQLExecuteOptions, GraphQLOperation, GraphQLTransport } from "./transport";
import { SuwayomiTransport } from "./transport";

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

function schemaInputField(name: string) {
  return {
    name,
    defaultValue: null,
    type: namedType("String"),
  };
}

interface SchemaFixtureType {
  kind: string;
  name: string;
  fields: ReturnType<typeof schemaField>[];
  inputFields: ReturnType<typeof schemaInputField>[] | null;
  enumValues: null;
}

function compatibleSchema(): {
  __schema: {
    queryType: { name: string };
    mutationType: { name: string };
    types: SchemaFixtureType[];
  };
} {
  const queryFields = ["aboutServer", "settings", "extensions", "sources", "source"];
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
  const commonPreferenceFields = [
    "key",
    "title",
    "summary",
    "enabled",
    "visible",
    "default",
    "currentValue",
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
        {
          kind: "OBJECT",
          name: "CheckBoxPreference",
          fields: commonPreferenceFields.map(schemaField),
          inputFields: null,
          enumValues: null,
        },
        {
          kind: "OBJECT",
          name: "SwitchPreference",
          fields: commonPreferenceFields.map(schemaField),
          inputFields: null,
          enumValues: null,
        },
        {
          kind: "OBJECT",
          name: "ListPreference",
          fields: [...commonPreferenceFields, "entries", "entryValues"].map(schemaField),
          inputFields: null,
          enumValues: null,
        },
        {
          kind: "OBJECT",
          name: "EditTextPreference",
          fields: [
            ...commonPreferenceFields,
            "text",
            "dialogTitle",
            "dialogMessage",
          ].map(schemaField),
          inputFields: null,
          enumValues: null,
        },
        {
          kind: "OBJECT",
          name: "MultiSelectListPreference",
          fields: [
            ...commonPreferenceFields,
            "entries",
            "entryValues",
            "dialogTitle",
            "dialogMessage",
          ].map(schemaField),
          inputFields: null,
          enumValues: null,
        },
      ],
    },
  };
}

function writablePreferencesSchema() {
  const schema = compatibleSchema();
  schema.__schema.types[1]!.fields.push(schemaField("updateSourcePreference"));
  schema.__schema.types.push({
    kind: "OBJECT",
    name: "UpdateSourcePreferencePayload",
    fields: [schemaField("preferences"), schemaField("source")],
    inputFields: null,
    enumValues: null,
  });
  schema.__schema.types.push({
    kind: "INPUT_OBJECT",
    name: "UpdateSourcePreferenceInput",
    fields: [],
    inputFields: [schemaInputField("source"), schemaInputField("change")],
    enumValues: null,
  });
  schema.__schema.types.push({
    kind: "INPUT_OBJECT",
    name: "SourcePreferenceChangeInput",
    fields: [],
    inputFields: [
      "position",
      "checkBoxState",
      "switchState",
      "listState",
      "editTextState",
      "multiSelectState",
    ].map(schemaInputField),
    enumValues: null,
  });
  return schema;
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
    const fixture = this.fixtures[operation.name];
    const value = typeof fixture === "function"
      ? (fixture as () => unknown)()
      : fixture;
    return operation.decode(value);
  }
}

describe("SuwayomiAdapter", () => {
  test.each(["install", "add", "refresh"])("carries the restore target through %s to the final transport boundary", async action => {
    let target = "original";
    const sendMutation = vi.fn();
    const transport = new SuwayomiTransport({
      endpoint: "http://127.0.0.1:4567/api/graphql",
      beginMutationLease: async () => { target = "different"; return () => {}; },
      fetch: async (_url, init) => {
        const { operationName } = JSON.parse(String(init?.body));
        if (operationName === "EpigraphRuntimeContract") return new Response(JSON.stringify({ data: compatibleSchema() }));
        if (operationName === "EpigraphLegacyExtensionStores") return new Response(JSON.stringify({ data: { settings: { extensionRepos: [] } } }));
        sendMutation(); throw Error("UNEXPECTED_DEPENDENCY_MUTATION");
      },
    });
    const adapter = new SuwayomiAdapter(transport, new CompatibilityProfileV21());
    const assertTarget = () => { if (target !== "original") throw Error("RESTORE_TARGET_CHANGED"); };
    const result = action === "install" ? adapter.installExtension({ packageName: "pkg", assertTarget })
      : action === "add" ? adapter.addStore({ indexUrl: "https://example.test/repo.json", assertTarget })
      : adapter.refreshExtensions(undefined, assertTarget);
    await expect(result).rejects.toMatchObject({ cause: new Error("RESTORE_TARGET_CHANGED"), retryable: false });
    expect(sendMutation).not.toHaveBeenCalled();
  });
  test("shares contract inspection across runtime info and capabilities", async () => {
    const transport = new FixtureTransport({
      EpigraphRuntimeContract: compatibleSchema(),
      EpigraphRuntimeInfo: {
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
    expect(transport.calls.filter((name) => name === "EpigraphRuntimeContract")).toHaveLength(1);
  });

  test("builds a stable runtime fingerprint without using process identity", async () => {
    const transport = new FixtureTransport({
      EpigraphRuntimeContract: compatibleSchema(),
      EpigraphRuntimeInfo: {
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
      EpigraphRuntimeContract: incomplete,
      EpigraphLegacyExtensionStores: {
        settings: { extensionRepos: [] },
      },
    });
    const adapter = new SuwayomiAdapter(transport, new CompatibilityProfileV21());

    await expect(adapter.listStores()).rejects.toMatchObject({
      code: "RUNTIME_INCOMPATIBLE",
      details: { missingQueries: "sources" },
    });
    expect(transport.calls).not.toContain("EpigraphLegacyExtensionStores");
  });

  test("delegates typed extension actions without exposing GraphQL to callers", async () => {
    const transport = new FixtureTransport({
      EpigraphRuntimeContract: compatibleSchema(),
      EpigraphInstallExtension: {
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
      expect.objectContaining({ name: "EpigraphInstallExtension", kind: "mutation" }),
      { id: "eu.kanade.tachiyomi.extension.en.demo" },
      { signal: undefined, timeoutMs: 60_000 },
    );
  });

  test("updates an official source preference and confirms it with a fresh query", async () => {
    const preference = {
      __typename: "SwitchPreference",
      key: "showUploaded",
      title: "Show uploaded",
      summary: "Include uploaded titles",
      enabled: true,
      visible: false,
      switchDefault: false,
      switchCurrent: true,
    };
    const transport = new FixtureTransport({
      EpigraphRuntimeContract: writablePreferencesSchema(),
      EpigraphSourcePreferences: {
        source: { preferences: [preference] },
      },
      EpigraphUpdateSourcePreference: {
        updateSourcePreference: { preferences: [preference] },
      },
    });
    const executeSpy = vi.spyOn(transport, "execute");
    const adapter = new SuwayomiAdapter(transport, new CompatibilityProfileV21());

    const refreshed = await adapter.updateSourcePreference({
      sourceId: "7",
      position: 0,
      expectedKey: "showUploaded",
      expectedType: "SwitchPreference",
      value: true,
    });

    expect(refreshed[0]).toMatchObject({
      type: "SwitchPreference",
      currentValue: true,
    });
    expect(executeSpy).toHaveBeenCalledWith(
      expect.objectContaining({ name: "EpigraphUpdateSourcePreference" }),
      {
        input: {
          source: "7",
          change: { position: 0, switchState: true },
        },
      },
      expect.objectContaining({ timeoutMs: 60_000 }),
    );
    expect(transport.calls.filter((name) => name === "EpigraphSourcePreferences")).toHaveLength(2);
  });

  test("keeps source preferences read-only when the official mutation is unavailable", async () => {
    const transport = new FixtureTransport({
      EpigraphRuntimeContract: compatibleSchema(),
    });
    const adapter = new SuwayomiAdapter(transport, new CompatibilityProfileV21());

    await expect(adapter.updateSourcePreference({
      sourceId: "7",
      position: 0,
      expectedKey: "showUploaded",
      expectedType: "SwitchPreference",
      value: true,
    })).rejects.toMatchObject({ code: "PREFERENCE_UNSUPPORTED" });
    expect(transport.calls).not.toContain("EpigraphUpdateSourcePreference");
  });

  test("rejects a stale preference position before sending the mutation", async () => {
    const transport = new FixtureTransport({
      EpigraphRuntimeContract: writablePreferencesSchema(),
      EpigraphSourcePreferences: {
        source: {
          preferences: [{
            __typename: "SwitchPreference",
            key: "newKey",
            title: "Reordered preference",
            summary: null,
            enabled: true,
            visible: true,
            switchDefault: false,
            switchCurrent: false,
          }],
        },
      },
    });
    const adapter = new SuwayomiAdapter(transport, new CompatibilityProfileV21());

    await expect(adapter.updateSourcePreference({
      sourceId: "7",
      position: 0,
      expectedKey: "oldKey",
      expectedType: "SwitchPreference",
      value: true,
    })).rejects.toMatchObject({ code: "PREFERENCE_VALIDATION_FAILED" });
    expect(transport.calls).not.toContain("EpigraphUpdateSourcePreference");
  });

  test("accepts an ambiguous mutation response only after a fresh query confirms the value", async () => {
    let queryCount = 0;
    const preference = (currentValue: boolean) => ({
      source: {
        preferences: [{
          __typename: "SwitchPreference",
          key: "showUploaded",
          title: "Show uploaded",
          summary: null,
          enabled: true,
          visible: true,
          switchDefault: false,
          switchCurrent: currentValue,
        }],
      },
    });
    const transport = new FixtureTransport({
      EpigraphRuntimeContract: writablePreferencesSchema(),
      EpigraphSourcePreferences: () => preference(queryCount++ > 0),
      EpigraphUpdateSourcePreference: () => {
        throw new Error("The response was lost after Suwayomi accepted the mutation.");
      },
    });
    const adapter = new SuwayomiAdapter(transport, new CompatibilityProfileV21());

    await expect(adapter.updateSourcePreference({
      sourceId: "7",
      position: 0,
      expectedKey: "showUploaded",
      expectedType: "SwitchPreference",
      value: true,
    })).resolves.toMatchObject([{
      type: "SwitchPreference",
      currentValue: true,
    }]);
    expect(transport.calls.filter((name) => name === "EpigraphSourcePreferences")).toHaveLength(2);
  });

  test("manages legacy repositories through the runtime boundary", async () => {
    const transport = new FixtureTransport({
      EpigraphRuntimeContract: compatibleSchema(),
      EpigraphLegacyExtensionStores: {
        settings: { extensionRepos: ["https://old.example/repo.json"] },
      },
      EpigraphLegacyAddExtensionStore: {
        setSettings: {
          settings: { extensionRepos: ["https://old.example/repo.json", "https://new.example/repo.json"] },
        },
      },
      EpigraphLegacyRemoveExtensionStore: {
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
      "EpigraphRuntimeContract",
      "EpigraphLegacyExtensionStores",
      "EpigraphLegacyAddExtensionStore",
      "EpigraphLegacyExtensionStores",
      "EpigraphLegacyRemoveExtensionStore",
    ]);
  });
});
