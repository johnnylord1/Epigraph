import { SourceRuntimeError } from "./errors";
import {
  INTROSPECTION_OPERATION,
  canonicalSchemaSha256,
  evaluateRuntimeContract,
  runtimeCapabilitiesSha256,
  type CanonicalGraphQLSchema,
} from "./schema";
import type { CompatibilityProfile } from "./compatibility";
import type {
  ExtensionInstallInput,
  ExtensionStore,
  ExtensionStoreInput,
  ExtensionUpdateInput,
  RuntimeCapabilities,
  RuntimeContractReport,
  RuntimeInfo,
  RuntimeFingerprint,
  SourceChapter,
  SourceChapterRef,
  SourceFilter,
  SourceItemDetails,
  SourceItemRef,
  SourcePage,
  SourcePreference,
  SourcePreferenceUpdateInput,
  SourceRuntime,
  SourceSearchInput,
  SourceSearchResult,
} from "./types";
import type { GraphQLTransport } from "./transport";
import { canonicalizeExtensionStoreUrl } from "./storeUrl";

interface ContractInspection {
  report: RuntimeContractReport;
  schemaHash: string;
  capabilitiesHash: string;
}

export interface SuwayomiAdapterContext {
  endpointIdentity?: string;
  instanceNonce?: string | null;
  localRuntimeGeneration?: string | null;
}

export class SuwayomiAdapter implements SourceRuntime {
  private inspection: Promise<ContractInspection> | null = null;

  constructor(
    private readonly transport: GraphQLTransport,
    private readonly profile: CompatibilityProfile,
    schema?: CanonicalGraphQLSchema,
    private readonly context: SuwayomiAdapterContext = {},
  ) {
    if (schema) this.inspection = this.inspectSchema(schema);
  }

  async getRuntimeFingerprint(): Promise<RuntimeFingerprint> {
    const [payload, inspection] = await Promise.all([
      this.transport.execute(this.profile.operations.runtimeInfo, {}),
      this.inspectContract(),
    ]);
    return {
      serverVersion: payload.version,
      canonicalSchemaHash: inspection.schemaHash,
      capabilitiesHash: inspection.capabilitiesHash,
      endpointIdentity: this.context.endpointIdentity
        ?? this.transport.getEndpointIdentity?.()
        ?? "unknown-endpoint",
      instanceNonce: this.context.instanceNonce ?? null,
      localRuntimeGeneration: this.context.localRuntimeGeneration ?? null,
    };
  }

  async getRuntimeInfo(): Promise<RuntimeInfo> {
    const [payload, inspection] = await Promise.all([
      this.transport.execute(this.profile.operations.runtimeInfo, {}),
      this.inspectContract(),
    ]);
    return {
      ...payload,
      profileId: this.profile.id,
      schemaHash: inspection.schemaHash,
      compatible: inspection.report.compatible,
    };
  }

  async getCapabilities(): Promise<RuntimeCapabilities> {
    return (await this.inspectContract()).report.capabilities;
  }

  async listStores(signal?: AbortSignal) {
    await this.requireCompatible();
    return this.transport.execute(this.profile.operations.listStores, {}, { signal });
  }

  async addStore(input: ExtensionStoreInput): Promise<ExtensionStore> {
    await this.requireCompatible();
    const indexUrl = canonicalizeExtensionStoreUrl(input.indexUrl);
    const current = await this.listStores(input.signal);
    const existing = current.find((store) => canonicalizeExtensionStoreUrl(store.indexUrl) === indexUrl);
    if (existing) return existing;

    if (this.profile.id === "suwayomi-v23") {
      return this.transport.execute(
        this.profile.operations.addStore,
        { indexUrl },
        { signal: input.signal, timeoutMs: 60_000, assertTarget: input.assertTarget },
      );
    }

    return this.transport.execute(
      this.profile.operations.addStore,
      { repos: [...current.map((store) => store.indexUrl), indexUrl] },
      { signal: input.signal, timeoutMs: 60_000, assertTarget: input.assertTarget },
    );
  }

  async removeStore(indexUrl: string, signal?: AbortSignal): Promise<ExtensionStore | null> {
    await this.requireCompatible();
    const normalizedUrl = canonicalizeExtensionStoreUrl(indexUrl);
    const current = await this.listStores(signal);
    const existing = current.find((store) => canonicalizeExtensionStoreUrl(store.indexUrl) === normalizedUrl) ?? null;
    if (!existing) return null;

    if (this.profile.id === "suwayomi-v23") {
      await this.transport.execute(
        this.profile.operations.removeStore,
        { indexUrl: existing.indexUrl },
        { signal, timeoutMs: 60_000 },
      );
      return existing;
    }

    await this.transport.execute(
      this.profile.operations.removeStore,
      { repos: current
        .filter((store) => store.id !== existing.id)
        .map((store) => store.indexUrl) },
      { signal, timeoutMs: 60_000 },
    );
    return existing;
  }

  async listExtensions(signal?: AbortSignal) {
    await this.requireCompatible();
    return this.transport.execute(this.profile.operations.listExtensions, {}, { signal });
  }

  async refreshExtensions(signal?: AbortSignal, assertTarget?: () => void) {
    await this.requireCompatible();
    return this.transport.execute(
      this.profile.operations.refreshExtensions,
      {},
      { signal, timeoutMs: 60_000, assertTarget },
    );
  }

  async listSources(signal?: AbortSignal) {
    await this.requireCompatible();
    return this.transport.execute(this.profile.operations.listSources, {}, { signal });
  }

  async getSourcePreferences(
    sourceId: string,
    signal?: AbortSignal,
  ): Promise<readonly SourcePreference[]> {
    await this.requireCompatible();
    const capabilities = await this.getCapabilities();
    if (capabilities.sourcePreferenceAccess === "unsupported") {
      throw new SourceRuntimeError(
        "PREFERENCE_UNSUPPORTED",
        "This Suwayomi runtime does not expose source preferences.",
      );
    }
    if (!sourceId.trim()) {
      throw new SourceRuntimeError(
        "PREFERENCE_VALIDATION_FAILED",
        "A source ID is required to load preferences.",
      );
    }
    return this.transport.execute(
      this.profile.operations.sourcePreferences,
      { id: sourceId },
      { signal },
    );
  }

  async updateSourcePreference(
    input: SourcePreferenceUpdateInput,
  ): Promise<readonly SourcePreference[]> {
    await this.requireCompatible();
    const capabilities = await this.getCapabilities();
    if (capabilities.sourcePreferenceAccess !== "read-write") {
      throw new SourceRuntimeError(
        "PREFERENCE_UNSUPPORTED",
        "This Suwayomi runtime exposes source preferences as read-only.",
      );
    }
    if (!input.sourceId.trim() || !Number.isSafeInteger(input.position) || input.position < 0) {
      throw new SourceRuntimeError(
        "PREFERENCE_VALIDATION_FAILED",
        "The source preference target is invalid.",
      );
    }

    const before = await this.getSourcePreferences(input.sourceId, input.signal);
    const preference = before[input.position];
    if (!preference) {
      throw new SourceRuntimeError(
        "PREFERENCE_VALIDATION_FAILED",
        "The source preference position no longer exists.",
        { details: { position: input.position } },
      );
    }
    if (preference.key !== input.expectedKey || preference.type !== input.expectedType) {
      throw new SourceRuntimeError(
        "PREFERENCE_VALIDATION_FAILED",
        "The source preference changed before the update could be applied.",
        {
          details: {
            position: input.position,
            expectedKey: input.expectedKey,
            actualKey: preference.key,
            expectedType: input.expectedType,
            actualType: preference.type,
          },
        },
      );
    }
    if (!preference.enabled) {
      throw new SourceRuntimeError(
        "PREFERENCE_VALIDATION_FAILED",
        "The source preference is disabled.",
        { details: { position: input.position, key: preference.key } },
      );
    }

    const change = this.preferenceChange(preference, input);
    let mutationError: unknown = null;
    try {
      await this.transport.execute(
        this.profile.operations.updateSourcePreference,
        { input: { source: input.sourceId, change } },
        { signal: input.signal, timeoutMs: 60_000 },
      );
    } catch (error) {
      mutationError = error;
    }

    if (input.signal?.aborted) {
      throw mutationError ?? new DOMException("The source preference update was cancelled.", "AbortError");
    }

    let refreshed: readonly SourcePreference[];
    try {
      refreshed = await this.getSourcePreferences(input.sourceId, input.signal);
    } catch (confirmationError) {
      if (mutationError) throw mutationError;
      throw new SourceRuntimeError(
        "PREFERENCE_CONFIRMATION_FAILED",
        "Suwayomi could not confirm the source preference update.",
        {
          cause: confirmationError,
          details: { position: input.position, key: preference.key },
        },
      );
    }
    const confirmed = refreshed[input.position];
    if (
      !confirmed
      || confirmed.key !== input.expectedKey
      || confirmed.type !== input.expectedType
      || !this.preferenceValueMatches(confirmed, input.value)
    ) {
      if (mutationError) throw mutationError;
      throw new SourceRuntimeError(
        "PREFERENCE_CONFIRMATION_FAILED",
        "Suwayomi did not confirm the source preference update.",
        { details: { position: input.position, key: preference.key } },
      );
    }
    return refreshed;
  }

  async installExtension(input: ExtensionInstallInput): Promise<void> {
    await this.requireCompatible();
    await this.transport.execute(
      this.profile.operations.installExtension,
      { id: input.packageName },
      { signal: input.signal, timeoutMs: 60_000, assertTarget: input.assertTarget },
    );
  }

  private preferenceChange(
    preference: SourcePreference,
    input: SourcePreferenceUpdateInput,
  ) {
    const position = input.position;
    switch (preference.type) {
      case "CheckBoxPreference":
        if (typeof input.value === "boolean") return { position, checkBoxState: input.value };
        break;
      case "SwitchPreference":
        if (typeof input.value === "boolean") return { position, switchState: input.value };
        break;
      case "ListPreference":
        if (typeof input.value === "string" && preference.entryValues.includes(input.value)) {
          return { position, listState: input.value };
        }
        break;
      case "EditTextPreference":
        if (typeof input.value === "string") return { position, editTextState: input.value };
        break;
      case "MultiSelectListPreference":
        if (Array.isArray(input.value)
          && input.value.every((entry) => (
            typeof entry === "string" && preference.entryValues.includes(entry)
          ))) {
          return { position, multiSelectState: [...new Set(input.value)] };
        }
        break;
      case "UnsupportedPreference":
        throw new SourceRuntimeError(
          "PREFERENCE_UNSUPPORTED",
          `Preference type ${preference.upstreamType} is not supported by this Epigraph version.`,
          { details: { position, key: preference.key } },
        );
    }
    throw new SourceRuntimeError(
      "PREFERENCE_VALIDATION_FAILED",
      "The source preference value is invalid.",
      { details: { position, key: preference.key, type: preference.type } },
    );
  }

  private preferenceValueMatches(
    preference: SourcePreference,
    expected: SourcePreferenceUpdateInput["value"],
  ): boolean {
    if (preference.type === "UnsupportedPreference") return false;
    const actual = preference.currentValue ?? preference.defaultValue;
    if (Array.isArray(expected)) {
      return Array.isArray(actual)
        && [...actual].sort().join("\u0000") === [...expected].sort().join("\u0000");
    }
    return actual === expected;
  }

  async updateExtension(input: ExtensionUpdateInput): Promise<void> {
    await this.requireCompatible();
    await this.transport.execute(
      this.profile.operations.updateExtension,
      { id: input.packageName },
      { signal: input.signal, timeoutMs: 60_000 },
    );
  }

  async uninstallExtension(packageName: string, signal?: AbortSignal): Promise<void> {
    await this.requireCompatible();
    await this.transport.execute(
      this.profile.operations.uninstallExtension,
      { id: packageName },
      { signal, timeoutMs: 60_000 },
    );
  }

  async search(input: SourceSearchInput): Promise<SourceSearchResult> {
    await this.requireCompatible();
    const variables = {
      source: input.sourceId,
      type: input.mode,
      page: input.page,
      ...(input.query === undefined ? {} : { query: input.query }),
    };
    if (input.filters?.length) {
      await this.requireSourceFilters();
      return this.transport.execute(
        this.profile.operations.filteredSearch,
        { ...variables, filters: input.filters },
        { signal: input.signal },
      );
    }
    return this.transport.execute(this.profile.operations.search, variables, { signal: input.signal });
  }

  async getSourceFilters(sourceId: string, signal?: AbortSignal): Promise<readonly SourceFilter[]> {
    await this.requireCompatible();
    await this.requireSourceFilters();
    return this.transport.execute(this.profile.operations.sourceFilters, { id: sourceId }, { signal });
  }

  private async requireSourceFilters(): Promise<void> {
    const capabilities = await this.getCapabilities();
    if (!capabilities.sourceFilters) {
      throw new SourceRuntimeError(
        "RUNTIME_INCOMPATIBLE",
        "This Suwayomi runtime does not expose source filters.",
      );
    }
  }

  async getDetails(input: SourceItemRef, signal?: AbortSignal): Promise<SourceItemDetails> {
    await this.requireCompatible();
    const details = await this.transport.execute(
      this.profile.operations.details,
      { id: input.id },
      { signal },
    );
    return details.sourceId ? details : { ...details, sourceId: input.sourceId };
  }

  async getChapters(input: SourceItemRef, signal?: AbortSignal): Promise<readonly SourceChapter[]> {
    await this.requireCompatible();
    return this.transport.execute(
      this.profile.operations.chapters,
      { mangaId: input.id },
      { signal },
    );
  }

  async getPages(input: SourceChapterRef, signal?: AbortSignal): Promise<readonly SourcePage[]> {
    await this.requireCompatible();
    return this.transport.execute(
      this.profile.operations.pages,
      { chapterId: input.id },
      { signal },
    );
  }

  private inspectContract(): Promise<ContractInspection> {
    this.inspection ??= this.loadContractInspection();
    return this.inspection;
  }

  private async loadContractInspection(): Promise<ContractInspection> {
    const schema = await this.transport.execute(INTROSPECTION_OPERATION, {});
    return this.inspectSchema(schema);
  }

  private async inspectSchema(schema: CanonicalGraphQLSchema): Promise<ContractInspection> {
    const report = evaluateRuntimeContract(schema, this.profile.contract);
    const [schemaHash, capabilitiesHash] = await Promise.all([
      canonicalSchemaSha256(schema),
      runtimeCapabilitiesSha256(report.capabilities),
    ]);
    return { report, schemaHash, capabilitiesHash };
  }

  private async requireCompatible(): Promise<void> {
    const { report } = await this.inspectContract();
    if (report.compatible) return;
    throw new SourceRuntimeError(
      "RUNTIME_INCOMPATIBLE",
      `Suwayomi does not satisfy the ${this.profile.id} runtime contract.`,
      {
        details: {
          missingQueries: report.missingQueries.join(","),
          missingMutations: report.missingMutations.join(","),
          missingTypes: Object.keys(report.missingFields).join(","),
        },
      },
    );
  }
}
