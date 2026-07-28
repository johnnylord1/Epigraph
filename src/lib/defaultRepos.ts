import { canonicalizeExtensionStoreUrl, getManagedSourceRuntime } from "./manga/runtime";

export interface ExtensionRepoDefinition {
  name: string;
  url: string;
}

export const RECOMMENDED_EXTENSION_REPO: ExtensionRepoDefinition = {
  name: "Keiyoushi Extensions",
  url: "https://raw.githubusercontent.com/keiyoushi/extensions/repo/index.min.json",
};

export async function ensureExtensionRepo(repo: ExtensionRepoDefinition) {
  const targetUrl = canonicalizeExtensionStoreUrl(repo.url);
  const runtime = await getManagedSourceRuntime();
  const stores = await runtime.listStores();
  const exists = stores.some((store) => canonicalizeExtensionStoreUrl(store.indexUrl) === targetUrl);

  if (exists) {
    return {
      status: "existing" as const,
      repos: stores.map((store) => store.indexUrl),
      repo,
    };
  }

  await runtime.addStore({ indexUrl: repo.url });
  const updatedStores = await runtime.listStores();

  return {
    status: "added" as const,
    repos: updatedStores.map((store) => store.indexUrl),
    repo,
  };
}
