export type LocalProfileId = "main" | "test";
export type RuntimeProfileResolutionSource =
  | "launch-override"
  | "settings-default"
  | "legacy-fallback"
  | "invalid-default-fallback";

export interface LocalProfileMeta {
  id: LocalProfileId;
  label: "MAIN" | "TEST";
  title: string;
  serverUrl: string;
  port: number;
  local: true;
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

export const DEFAULT_LOCAL_PROFILE_ID: LocalProfileId = "test";

const MAIN_PROFILE: LocalProfileMeta = {
  id: "main",
  label: "MAIN",
  title: "MAIN :4567",
  serverUrl: "http://127.0.0.1:4567",
  port: 4567,
  local: true,
};

const TEST_PROFILE: LocalProfileMeta = {
  id: "test",
  label: "TEST",
  title: "TEST :4667",
  serverUrl: "http://127.0.0.1:4667",
  port: 4667,
  local: true,
};

export const BUILTIN_LOCAL_PROFILES: readonly LocalProfileMeta[] = [
  TEST_PROFILE,
  MAIN_PROFILE,
] as const;

export function normalizeServerUrl(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed ? trimmed.replace(/\/$/, "") : null;
}

export function normalizeLocalProfileId(raw: unknown): LocalProfileId | null {
  if (typeof raw !== "string") return null;
  const normalized = raw.trim().toLowerCase();
  if (normalized === "main" || normalized === "test") return normalized;
  return null;
}

export function getLocalProfileMeta(profileId: LocalProfileId | null | undefined): LocalProfileMeta | null {
  if (profileId === "main") return MAIN_PROFILE;
  if (profileId === "test") return TEST_PROFILE;
  return null;
}

function inferProfileId(profileLabel: string | null | undefined, serverUrl: string | null | undefined): LocalProfileId | null {
  const normalizedLabel = typeof profileLabel === "string" ? profileLabel.trim().toUpperCase() : "";
  if (normalizedLabel === "MAIN") return "main";
  if (normalizedLabel === "TEST") return "test";

  const normalizedUrl = normalizeServerUrl(serverUrl);
  if (!normalizedUrl) return null;

  try {
    const parsed = new URL(normalizedUrl);
    const port = Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80));
    if (port === MAIN_PROFILE.port) return "main";
    if (port === TEST_PROFILE.port) return "test";
  } catch {}

  return null;
}

function deriveDisplayLabel(profileId: LocalProfileId | null, serverUrl: string, explicitLabel?: string | null): string {
  const meta = getLocalProfileMeta(profileId);
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
      || (typeof target.auditBookIdOverride === "string" && target.auditBookIdOverride.trim())
  );
}

export function resolveSessionProfile(
  launchTarget: LaunchTargetProfileOverrides | null | undefined,
  persistedDefaultProfileId: unknown,
  fallbackServerUrl?: string | null,
): ResolvedSessionProfile {
  const normalizedDefault = normalizeLocalProfileId(persistedDefaultProfileId);
  const defaultProfileId = normalizedDefault ?? DEFAULT_LOCAL_PROFILE_ID;
  const defaultProfile = getLocalProfileMeta(defaultProfileId) ?? TEST_PROFILE;
  const overrideSession = hasLaunchOverride(launchTarget);
  const overrideProfileId = inferProfileId(launchTarget?.profileLabelOverride, launchTarget?.serverUrlOverride);

  if (overrideSession) {
    const hasExplicitOverrideUrl = Boolean(normalizeServerUrl(launchTarget?.serverUrlOverride));
    const overrideProfile = getLocalProfileMeta(overrideProfileId)
      ?? (!hasExplicitOverrideUrl ? defaultProfile : null);
    const effectiveServerUrl = normalizeServerUrl(launchTarget?.serverUrlOverride)
      ?? overrideProfile?.serverUrl
      ?? defaultProfile.serverUrl
      ?? normalizeServerUrl(fallbackServerUrl)
      ?? TEST_PROFILE.serverUrl;

    return {
      profileId: overrideProfileId ?? (!hasExplicitOverrideUrl ? defaultProfile.id : null),
      profileMeta: overrideProfile,
      effectiveServerUrl,
      displayLabel: deriveDisplayLabel(
        overrideProfileId ?? (!hasExplicitOverrideUrl ? defaultProfile.id : null),
        effectiveServerUrl,
        launchTarget?.profileLabelOverride,
      ),
      resolutionSource: "launch-override",
      launchProfileOverride: overrideProfileId,
      isOverrideSession: true,
      attachOnly: Boolean(launchTarget?.attachOnlyOverride),
    };
  }

  const profileId = defaultProfileId;
  const profileMeta = defaultProfile;

  return {
    profileId,
    profileMeta,
    effectiveServerUrl: profileMeta.serverUrl,
    displayLabel: profileMeta.label,
    resolutionSource: normalizedDefault ? "settings-default" : "invalid-default-fallback",
    launchProfileOverride: null,
    isOverrideSession: false,
    attachOnly: false,
  };
}
