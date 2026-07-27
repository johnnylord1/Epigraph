import { SourceRuntimeError } from "./errors";
import {
  INTROSPECTION_OPERATION,
  canonicalSchemaSha256,
  evaluateRuntimeContract,
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
  SourceChapter,
  SourceChapterRef,
  SourceItemDetails,
  SourceItemRef,
  SourcePage,
  SourceRuntime,
  SourceSearchInput,
  SourceSearchResult,
} from "./types";
import type { GraphQLTransport } from "./transport";

interface ContractInspection {
  report: RuntimeContractReport;
  schemaHash: string;
}

export class SuwayomiAdapter implements SourceRuntime {
  private inspection: Promise<ContractInspection> | null = null;

  constructor(
    private readonly transport: GraphQLTransport,
    private readonly profile: CompatibilityProfile,
    schema?: CanonicalGraphQLSchema,
  ) {
    if (schema) this.inspection = this.inspectSchema(schema);
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
    const indexUrl = normalizeStoreUrl(input.indexUrl);
    const current = await this.listStores(input.signal);
    const existing = current.find((store) => normalizeStoreUrl(store.indexUrl) === indexUrl);
    if (existing) return existing;

    if (this.profile.id === "suwayomi-v23") {
      return this.transport.execute(
        this.profile.operations.addStore,
        { indexUrl },
        { signal: input.signal, timeoutMs: 60_000 },
      );
    }

    return this.transport.execute(
      this.profile.operations.addStore,
      { repos: [...current.map((store) => store.indexUrl), indexUrl] },
      { signal: input.signal, timeoutMs: 60_000 },
    );
  }

  async removeStore(indexUrl: string, signal?: AbortSignal): Promise<ExtensionStore | null> {
    await this.requireCompatible();
    const normalizedUrl = normalizeStoreUrl(indexUrl);
    const current = await this.listStores(signal);
    const existing = current.find((store) => normalizeStoreUrl(store.indexUrl) === normalizedUrl) ?? null;
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

  async refreshExtensions(signal?: AbortSignal) {
    await this.requireCompatible();
    return this.transport.execute(
      this.profile.operations.refreshExtensions,
      {},
      { signal, timeoutMs: 60_000 },
    );
  }

  async listSources(signal?: AbortSignal) {
    await this.requireCompatible();
    return this.transport.execute(this.profile.operations.listSources, {}, { signal });
  }

  async installExtension(input: ExtensionInstallInput): Promise<void> {
    await this.requireCompatible();
    await this.transport.execute(
      this.profile.operations.installExtension,
      { id: input.packageName },
      { signal: input.signal, timeoutMs: 60_000 },
    );
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
    return this.transport.execute(
      this.profile.operations.search,
      {
        source: input.sourceId,
        type: input.mode,
        page: input.page,
        ...(input.query === undefined ? {} : { query: input.query }),
      },
      { signal: input.signal },
    );
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
    const [report, schemaHash] = await Promise.all([
      Promise.resolve(evaluateRuntimeContract(schema, this.profile.contract)),
      canonicalSchemaSha256(schema),
    ]);
    return { report, schemaHash };
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

function normalizeStoreUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("unsupported protocol");
    return url.toString().replace(/\/+$/, "");
  } catch (cause) {
    throw new SourceRuntimeError(
      "CONFIGURATION_REQUIRED",
      "Extension store URL must use http:// or https://.",
      { cause },
    );
  }
}
