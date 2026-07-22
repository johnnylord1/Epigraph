export interface AethonUpdateStatus {
  update_available: boolean;
  current_version: string;
  version: string | null;
  body: string | null;
  published_at: string | null;
}

export interface AethonReleaseInfo {
  tag_name: string;
  name: string;
  body: string;
  published_at: string;
  html_url: string;
}

const STABLE_SEMVER = /^v?(\d+)\.(\d+)\.(\d+)$/i;

export function normalizeAethonVersion(value: string | null | undefined): string | null {
  const match = value?.trim().match(STABLE_SEMVER);
  if (!match) return null;
  return `${Number(match[1])}.${Number(match[2])}.${Number(match[3])}`;
}

export function compareAethonVersions(left: string, right: string): number {
  const normalizedLeft = normalizeAethonVersion(left);
  const normalizedRight = normalizeAethonVersion(right);
  if (!normalizedLeft || !normalizedRight) return 0;

  const leftParts = normalizedLeft.split(".").map(Number);
  const rightParts = normalizedRight.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = leftParts[index] - rightParts[index];
    if (difference !== 0) return difference;
  }
  return 0;
}

export function isAuthorizedAethonUpdate(
  release: AethonReleaseInfo,
  status: AethonUpdateStatus | null,
): boolean {
  if (!status?.update_available || !status.version) return false;
  const releaseVersion = normalizeAethonVersion(release.tag_name);
  const authorizedVersion = normalizeAethonVersion(status.version);
  return releaseVersion !== null && releaseVersion === authorizedVersion;
}

export function sortAethonReleaseHistory(releases: readonly AethonReleaseInfo[]): AethonReleaseInfo[] {
  return releases
    .filter((release) => normalizeAethonVersion(release.tag_name) !== null)
    .slice()
    .sort((left, right) => compareAethonVersions(right.tag_name, left.tag_name));
}
