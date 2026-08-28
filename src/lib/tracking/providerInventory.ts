import type { Tracker } from "../types";
import { loadHardcoverState } from "../novels/hardcover";
import type { NovelRepositoryScopeInput } from "../novels/repositoryState";

export type TrackingProviderOrigin = "suwayomi" | "native" | "combined";

export interface TrackingProviderInventoryEntry {
  id: string;
  name: string;
  isLoggedIn: boolean;
  origin: TrackingProviderOrigin;
  serverTrackerId: number | null;
}

interface NativeTrackingProviderDefinition {
  id: string;
  name: string;
  stateEvents: readonly string[];
  resolveConnected(scope: NovelRepositoryScopeInput): boolean;
}

// Native integrations register here once. Suwayomi trackers remain fully dynamic.
const NATIVE_TRACKING_PROVIDER_REGISTRY: readonly NativeTrackingProviderDefinition[] = [
  {
    id: "hardcover",
    name: "Hardcover",
    stateEvents: ["epigraph-hardcover-state-changed"],
    resolveConnected: (scope) => loadHardcoverState(scope).auth.connected,
  },
];

export const TRACKING_PROVIDER_STATE_EVENTS = Object.freeze(
  [...new Set(NATIVE_TRACKING_PROVIDER_REGISTRY.flatMap((provider) => provider.stateEvents))],
);

function providerNameKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

export function buildTrackingProviderInventory(
  serverTrackers: readonly Tracker[],
  nativeProviders: readonly TrackingProviderInventoryEntry[],
): TrackingProviderInventoryEntry[] {
  const entries: TrackingProviderInventoryEntry[] = serverTrackers.map((tracker) => ({
    id: `suwayomi:${tracker.id}`,
    name: tracker.name,
    isLoggedIn: tracker.isLoggedIn,
    origin: "suwayomi" as const,
    serverTrackerId: tracker.id,
  }));
  const indexByName = new Map(entries.map((entry, index) => [providerNameKey(entry.name), index]));

  for (const nativeProvider of nativeProviders) {
    const nameKey = providerNameKey(nativeProvider.name);
    const existingIndex = indexByName.get(nameKey);
    if (existingIndex === undefined) {
      indexByName.set(nameKey, entries.length);
      entries.push(nativeProvider);
      continue;
    }

    const existing = entries[existingIndex];
    entries[existingIndex] = {
      ...existing,
      isLoggedIn: existing.isLoggedIn || nativeProvider.isLoggedIn,
      origin: "combined",
    };
  }

  return entries;
}

export function loadTrackingProviderInventory(
  serverTrackers: readonly Tracker[],
  scope: NovelRepositoryScopeInput = {},
): TrackingProviderInventoryEntry[] {
  const nativeProviders = NATIVE_TRACKING_PROVIDER_REGISTRY.map((provider) => {
    let isLoggedIn = false;
    try {
      isLoggedIn = provider.resolveConnected(scope);
    } catch {
      isLoggedIn = false;
    }
    return {
      id: `native:${provider.id}`,
      name: provider.name,
      isLoggedIn,
      origin: "native" as const,
      serverTrackerId: null,
    };
  });

  return buildTrackingProviderInventory(serverTrackers, nativeProviders);
}

export function loadNativeTrackedTitleKeys(
  scope: NovelRepositoryScopeInput = {},
): string[] {
  try {
    return [...new Set(loadHardcoverState(scope).records.map((record) =>
      record.sourceNovelId ? `novel:${record.sourceNovelId}` : `hardcover:${record.bookId}`
    ))];
  } catch {
    return [];
  }
}
