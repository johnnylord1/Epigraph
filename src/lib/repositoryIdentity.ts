const GITHUB_HOSTS = new Set(["raw.githubusercontent.com", "github.com"]);

function githubPath(url: string) {
  try {
    const u = new URL(url);
    return GITHUB_HOSTS.has(u.hostname) ? u.pathname.split("/").filter(Boolean) : null;
  } catch { return null; }
}

/** Readable name for a repository URL: `owner/repo` on GitHub, the host elsewhere. */
export function repositoryLabel(url: string) {
  const parts = githubPath(url);
  if (parts && parts.length >= 2) return `${parts[0]}/${parts[1]}`;
  try { return new URL(url).hostname || url; } catch { return url; }
}

// Repository catalogs carry no icon; a GitHub-hosted one shows its owner's avatar (404 when the account is gone).
export function repositoryAvatar(url: string) {
  const owner = githubPath(url)?.[0];
  return owner ? `https://github.com/${encodeURIComponent(owner)}.png?size=64` : null;
}
