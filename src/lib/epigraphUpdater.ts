export interface EpigraphUpdateStatus {
  update_available: boolean;
  current_version: string;
  version: string | null;
  body: string | null;
  published_at: string | null;
}

export interface EpigraphReleaseInfo {
  tag_name: string;
  name: string;
  body: string;
  published_at: string;
  html_url: string;
}

const STABLE_SEMVER = /^v?(\d+)\.(\d+)\.(\d+)$/i;

export function normalizeEpigraphVersion(value: string | null | undefined): string | null {
  const match = value?.trim().match(STABLE_SEMVER);
  if (!match) return null;
  return `${Number(match[1])}.${Number(match[2])}.${Number(match[3])}`;
}

export function compareEpigraphVersions(left: string, right: string): number {
  const normalizedLeft = normalizeEpigraphVersion(left);
  const normalizedRight = normalizeEpigraphVersion(right);
  if (!normalizedLeft || !normalizedRight) return 0;

  const leftParts = normalizedLeft.split(".").map(Number);
  const rightParts = normalizedRight.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = leftParts[index] - rightParts[index];
    if (difference !== 0) return difference;
  }
  return 0;
}

export function isAuthorizedEpigraphUpdate(
  release: EpigraphReleaseInfo,
  status: EpigraphUpdateStatus | null,
): boolean {
  if (!status?.update_available || !status.version) return false;
  const releaseVersion = normalizeEpigraphVersion(release.tag_name);
  const authorizedVersion = normalizeEpigraphVersion(status.version);
  return releaseVersion !== null && releaseVersion === authorizedVersion;
}

export function sortEpigraphReleaseHistory(releases: readonly EpigraphReleaseInfo[]): EpigraphReleaseInfo[] {
  return releases
    .filter((release) => normalizeEpigraphVersion(release.tag_name) !== null)
    .slice()
    .sort((left, right) => compareEpigraphVersions(right.tag_name, left.tag_name));
}

const PLATFORM_HEADING = /^##\s+(windows|android)\b/i;

/**
 * Release notes list the Windows and Android changes under their own `## Windows` and
 * `## Android` headings; the desktop shows only its part. Notes without them are shown whole.
 */
export function desktopReleaseNotes(body: string): string {
  const kept: string[] = [];
  let otherPlatform = false;
  for (const line of body.split(/\r?\n/)) {
    if (/^##\s/.test(line)) {
      const platform = line.match(PLATFORM_HEADING)?.[1]?.toLowerCase();
      otherPlatform = platform === "android";
      if (platform) continue;
    }
    if (!otherPlatform) kept.push(line);
  }
  return kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
