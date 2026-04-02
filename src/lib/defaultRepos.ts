import { gql } from "./client";
import { GET_SETTINGS, SET_EXTENSION_REPOS } from "./queries";

export interface ExtensionRepoDefinition {
  name: string;
  url: string;
}

export const RECOMMENDED_EXTENSION_REPO: ExtensionRepoDefinition = {
  name: "Keiyoushi Extensions",
  url: "https://raw.githubusercontent.com/keiyoushi/extensions/repo/index.min.json",
};

function normalizeRepoUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

export async function ensureExtensionRepo(repo: ExtensionRepoDefinition) {
  const settingsData = await gql<{ settings: { extensionRepos: string[] } }>(GET_SETTINGS);
  const currentRepos = settingsData.settings.extensionRepos ?? [];
  const targetUrl = normalizeRepoUrl(repo.url);
  const exists = currentRepos.some((current) => normalizeRepoUrl(current) === targetUrl);

  if (exists) {
    return {
      status: "existing" as const,
      repos: currentRepos,
      repo,
    };
  }

  const updatedRepos = [...currentRepos, repo.url];
  const result = await gql<{ setSettings: { settings: { extensionRepos: string[] } } }>(SET_EXTENSION_REPOS, {
    repos: updatedRepos,
  });

  return {
    status: "added" as const,
    repos: result.setSettings.settings.extensionRepos,
    repo,
  };
}
