export type LocalProfileId = string;
export type RuntimeProfileResolutionSource =
  | "launch-override"
  | "settings-default"
  | "legacy-fallback"
  | "invalid-default-fallback";

export interface CustomLocalProfile {
  id: LocalProfileId;
  label: string;
  port: number;
}

export interface LocalProfileMeta {
  id: LocalProfileId;
  label: string;
  title: string;
  serverUrl: string;
  port: number;
  local: true;
  builtIn: boolean;
}

export interface LaunchTargetProfileOverrides {
  serverUrlOverride?: string | null;
  profileLabelOverride?: string | null;
  attachOnlyOverride?: boolean | null;
  auditOpenOverride?: string | null;
  auditMangaIdOverride?: number | null;
  auditChapterIdOverride?: number | null;
  auditBookIdOverride?: string | null;
}

export interface ResolvedSessionProfile {
  profileId: LocalProfileId | null;
  profileMeta: LocalProfileMeta | null;
  effectiveServerUrl: string;
  displayLabel: string;
  resolutionSource: RuntimeProfileResolutionSource;
  launchProfileOverride: LocalProfileId | null;
  isOverrideSession: boolean;
  attachOnly: boolean;
}

export const DEFAULT_LOCAL_PROFILE_ID: LocalProfileId = "main";
export const RESERVED_LOCAL_PROFILE_IDS = new Set(["main", "test"]);

const MIN_CUSTOM_PROFILE_PORT = 1024;
const MAX_CUSTOM_PROFILE_PORT = 65535;

const MAIN_PROFILE: LocalProfileMeta = {
  id: "main",
  label: "MAIN",
  title: "MAIN :4567",
  serverUrl: "http://127.0.0.1:4567",
  port: 4567,
  local: true,
  builtIn: true,
};

const TEST_PROFILE: LocalProfileMeta = {
  id: "test",
  label: "TEST",
  title: "TEST :4667",
  serverUrl: "http://127.0.0.1:4667",
  port: 4667,
  local: true,
  builtIn: true,
};

const RESERVED_LOCAL_PROFILES: readonly LocalProfileMeta[] = [
  MAIN_PROFILE,
  TEST_PROFILE,
] as const;

export const BUILTIN_LOCAL_PROFILES: readonly LocalProfileMeta[] = [
  MAIN_PROFILE,
] as const;

export function normalizeServerUrl(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed ? trimmed.replace(/\/$/, "") : null;
}

export function slugifyLocalProfileId(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
}

export function normalizeLocalProfileId(raw: unknown): LocalProfileId | null {
  if (typeof raw !== "string") return null;
  const normalized = raw.trim().toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/.test(normalized)) return null;
  return normalized;
}

function normalizeProfileLabel(value: unknown, fallback: string): string {
  const raw = typeof value === "string" ? value.trim() : "";
  const clipped = raw.replace(/\s+/g, " ").slice(0, 28);
  return clipped || fallback;
}

function normalizeProfilePort(value: unknown): number | null {
  const numeric = typeof value === "number" ? value : typeof value === "string" ? Number(value.trim()) : NaN;
  if (!Number.isInteger(numeric)) return null;
  if (numeric < MIN_CUSTOM_PROFILE_PORT || numeric > MAX_CUSTOM_PROFILE_PORT) return null;
  return numeric;
}

/** Moves the built-in profiles to the ports this build's Core manages; a debug build keeps off the installed release's. */
export function configureBuiltInLocalServerPorts(ports: { main?: unknown; test?: unknown } | null | undefined): void {
  for (const [profile, value] of [[MAIN_PROFILE, ports?.main], [TEST_PROFILE, ports?.test]] as const) {
    const port = normalizeProfilePort(value);
    if (!port) continue;
    profile.port = port;
    profile.serverUrl = `http://127.0.0.1:${port}`;
    profile.title = `${profile.label} :${port}`;
  }
}

/** The MAIN and TEST ports a debug build's Core gives Suwayomi (`DEV_LOCAL_SERVER_PORTS` in `lib.rs`). */
export const DEV_BUILTIN_SERVER_PORTS = { main: 4577, test: 4677 } as const;

/**
 * Ports to use when the Core can't be asked (no Tauri, e.g. the Vite page opened in a plain browser). The
 * Vite dev server keeps to the debug ports so it never shows or changes the installed release's library.
 */
export function fallbackBuiltInServerPorts(mode: string | undefined): { main: number; test: number } | null {
  return mode === "development" ? { ...DEV_BUILTIN_SERVER_PORTS } : null;
}

export function isBuiltInLocalProfileId(profileId: LocalProfileId | null | undefined): boolean {
  return profileId === "main" || profileId === "test";
}

export function normalizeCustomLocalProfiles(value: unknown): CustomLocalProfile[] {
  if (!Array.isArray(value)) return [];
  const usedIds = new Set(RESERVED_LOCAL_PROFILES.map((profile) => profile.id));
  const usedPorts = new Set(RESERVED_LOCAL_PROFILES.map((profile) => profile.port));
  const profiles: CustomLocalProfile[] = [];

  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Partial<CustomLocalProfile>;
    const id = normalizeLocalProfileId(record.id);
    const port = normalizeProfilePort(record.port);
    if (!id || RESERVED_LOCAL_PROFILE_IDS.has(id) || usedIds.has(id) || !port || usedPorts.has(port)) continue;
    const label = normalizeProfileLabel(record.label, id.toUpperCase());
    usedIds.add(id);
    usedPorts.add(port);
    profiles.push({ id, label, port });
  }

  return profiles;
}

/** Rejected profile input; `code` lets the UI show the message in the app language. */
export class LocalProfileInputError extends Error {
  constructor(readonly code: "port-out-of-range" | "port-in-use", message: string) {
    super(message);
    this.name = "LocalProfileInputError";
  }
}

export function createCustomLocalProfile(
  input: { label: string; port: number; fallbackLabel?: string },
  existing: readonly CustomLocalProfile[] = [],
): CustomLocalProfile {
  const normalizedExisting = normalizeCustomLocalProfiles(existing);
  const usedIds = new Set([
    ...RESERVED_LOCAL_PROFILES.map((profile) => profile.id),
    ...normalizedExisting.map((profile) => profile.id),
  ]);
  const usedPorts = new Set([
    ...RESERVED_LOCAL_PROFILES.map((profile) => profile.port),
    ...normalizedExisting.map((profile) => profile.port),
  ]);
  const port = normalizeProfilePort(input.port);
  if (!port) throw new LocalProfileInputError("port-out-of-range", "Use a local port between 1024 and 65535.");
  if (usedPorts.has(port)) throw new LocalProfileInputError("port-in-use", "This port is already used by another profile.");

  const label = normalizeProfileLabel(input.label, input.fallbackLabel ?? `Profile ${port}`);
  const baseId = slugifyLocalProfileId(label) || `profile-${port}`;
  let id = RESERVED_LOCAL_PROFILE_IDS.has(baseId) ? `${baseId}-${port}` : baseId;
  let suffix = 2;
  while (usedIds.has(id)) {
    id = `${baseId}-${suffix++}`.slice(0, 32).replace(/-+$/g, "");
  }

  return { id, label, port };
}

function customProfileToMeta(profile: CustomLocalProfile): LocalProfileMeta {
  const label = profile.label.trim() || profile.id.toUpperCase();
  return {
    id: profile.id,
    label,
    title: `${label} :${profile.port}`,
    serverUrl: `http://127.0.0.1:${profile.port}`,
    port: profile.port,
    local: true,
    builtIn: false,
  };
}

export function getAllLocalProfiles(customProfiles: unknown = []): LocalProfileMeta[] {
  return [
    ...normalizeCustomLocalProfiles(customProfiles).map(customProfileToMeta),
    ...BUILTIN_LOCAL_PROFILES,
  ];
}

/**
 * The built-in profiles keep their MAIN and TEST labels, which launch targets and saved settings
 * match on. People see a translated name instead.
 */
export function localProfileDisplayName(
  label: string | null | undefined,
  translate: (key: string) => string,
): string {
  const trimmed = label?.trim() ?? "";
  switch (trimmed.toUpperCase()) {
    case "MAIN":
      return translate("settings.general.profiles.builtinMain");
    case "TEST":
      return translate("settings.general.profiles.builtinTest");
    case "":
    case "CUSTOM":
      return translate("settings.general.profiles.unnamed");
    default:
      return trimmed;
  }
}

export function getLocalProfileMeta(
  profileId: LocalProfileId | null | undefined,
  customProfiles: unknown = [],
): LocalProfileMeta | null {
  if (profileId === "main") return MAIN_PROFILE;
  if (profileId === "test") return TEST_PROFILE;
  return getAllLocalProfiles(customProfiles).find((profile) => profile.id === profileId) ?? null;
}

function inferProfileId(
  profileLabel: string | null | undefined,
  serverUrl: string | null | undefined,
  customProfiles: unknown = [],
): LocalProfileId | null {
  const normalizedLabel = typeof profileLabel === "string" ? profileLabel.trim().toUpperCase() : "";
  if (normalizedLabel === "MAIN") return "main";
  if (normalizedLabel === "TEST") return "test";

  const normalizedUrl = normalizeServerUrl(serverUrl);
  const profiles = getAllLocalProfiles(customProfiles);
  if (normalizedLabel) {
    const byLabel = profiles.find(
      (profile) => profile.label.toUpperCase() === normalizedLabel || profile.id.toUpperCase() === normalizedLabel,
    );
    if (byLabel) return byLabel.id;
  }
  if (!normalizedUrl) return null;

  try {
    const parsed = new URL(normalizedUrl);
    const port = Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80));
    return profiles.find((profile) => profile.port === port)?.id ?? null;
  } catch {}

  return null;
}

function deriveDisplayLabel(
  profileId: LocalProfileId | null,
  serverUrl: string,
  explicitLabel?: string | null,
  customProfiles: unknown = [],
): string {
  const meta = getLocalProfileMeta(profileId, customProfiles);
  if (meta) return meta.label;

  const normalizedExplicit = typeof explicitLabel === "string" ? explicitLabel.trim().toUpperCase() : "";
  if (normalizedExplicit) return normalizedExplicit;

  try {
    const parsed = new URL(serverUrl);
    const port = parsed.port || (parsed.protocol === "https:" ? "443" : "80");
    return `CUSTOM :${port}`;
  } catch {
    return "CUSTOM";
  }
}

function hasLaunchOverride(target: LaunchTargetProfileOverrides | null | undefined): boolean {
  if (!target) return false;
  return Boolean(
    normalizeServerUrl(target.serverUrlOverride)
      || (typeof target.profileLabelOverride === "string" && target.profileLabelOverride.trim())
      || target.attachOnlyOverride
      || target.auditOpenOverride
      || target.auditMangaIdOverride != null
      || target.auditChapterIdOverride != null
      || (typeof target.auditBookIdOverride === "string" && target.auditBookIdOverride.trim()),
  );
}

export function resolveSessionProfile(
  launchTarget: LaunchTargetProfileOverrides | null | undefined,
  persistedDefaultProfileId: unknown,
  fallbackServerUrl?: string | null,
  customProfiles: unknown = [],
): ResolvedSessionProfile {
  const normalizedCustomProfiles = normalizeCustomLocalProfiles(customProfiles);
  const normalizedDefault = normalizeLocalProfileId(persistedDefaultProfileId);
  const defaultProfileId = getLocalProfileMeta(normalizedDefault, normalizedCustomProfiles)?.id ?? DEFAULT_LOCAL_PROFILE_ID;
  const defaultProfile = getLocalProfileMeta(defaultProfileId, normalizedCustomProfiles) ?? MAIN_PROFILE;
  const overrideSession = hasLaunchOverride(launchTarget);
  const overrideProfileId = inferProfileId(
    launchTarget?.profileLabelOverride,
    launchTarget?.serverUrlOverride,
    normalizedCustomProfiles,
  );

  if (overrideSession) {
    const hasExplicitOverrideUrl = Boolean(normalizeServerUrl(launchTarget?.serverUrlOverride));
    const overrideProfile = getLocalProfileMeta(overrideProfileId, normalizedCustomProfiles)
      ?? (!hasExplicitOverrideUrl ? defaultProfile : null);
    const effectiveServerUrl = normalizeServerUrl(launchTarget?.serverUrlOverride)
      ?? overrideProfile?.serverUrl
      ?? defaultProfile.serverUrl
      ?? normalizeServerUrl(fallbackServerUrl)
      ?? MAIN_PROFILE.serverUrl;
    const resolvedProfileId = overrideProfileId ?? (!hasExplicitOverrideUrl ? defaultProfile.id : null);

    return {
      profileId: resolvedProfileId,
      profileMeta: overrideProfile,
      effectiveServerUrl,
      displayLabel: deriveDisplayLabel(
        resolvedProfileId,
        effectiveServerUrl,
        launchTarget?.profileLabelOverride,
        normalizedCustomProfiles,
      ),
      resolutionSource: "launch-override",
      launchProfileOverride: overrideProfileId,
      isOverrideSession: true,
      attachOnly: Boolean(launchTarget?.attachOnlyOverride),
    };
  }

  return {
    profileId: defaultProfile.id,
    profileMeta: defaultProfile,
    effectiveServerUrl: defaultProfile.serverUrl,
    displayLabel: defaultProfile.label,
    resolutionSource: normalizedDefault === defaultProfile.id ? "settings-default" : "invalid-default-fallback",
    launchProfileOverride: null,
    isOverrideSession: false,
    attachOnly: false,
  };
}
