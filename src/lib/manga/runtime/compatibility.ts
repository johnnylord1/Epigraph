import {
  array,
  boolean,
  field,
  integer,
  integerString,
  nodes,
  nullableBoolean,
  nullableIntegerNumber,
  nullableString,
  number as finiteNumber,
  record,
  string,
} from "./codec";
import type {
  CompatibilityProfileId,
  ExtensionRef,
  ExtensionStore,
  RuntimeContract,
  SourceChapter,
  SourceItemDetails,
  SourcePage,
  SourcePreference,
  SourceRef,
  SourceSearchResult,
} from "./types";
import type { GraphQLOperation } from "./transport";

interface RuntimeInfoPayload {
  name: string;
  version: string;
  revision: string | null;
  buildType: string | null;
  buildTime: number | null;
}

interface ExtensionActionVariables {
  id: string;
}

interface SourceSearchVariables {
  source: string;
  type: "SEARCH" | "POPULAR" | "LATEST";
  page: number;
  query?: string;
}

interface MangaVariables {
  id: number;
}

interface ChapterVariables {
  mangaId: number;
}

interface PageVariables {
  chapterId: number;
}

interface SourcePreferencesVariables {
  id: string;
}

interface SourcePreferenceChangeVariables {
  input: {
    source: string;
    change: {
      position: number;
      checkBoxState?: boolean;
      switchState?: boolean;
      listState?: string;
      editTextState?: string;
      multiSelectState?: readonly string[];
    };
  };
}

interface ExtensionStoreVariables {
  indexUrl: string;
}

interface LegacyExtensionReposVariables {
  repos: readonly string[];
}

export interface CompatibilityProfileOperations {
  runtimeInfo: GraphQLOperation<Readonly<Record<string, never>>, RuntimeInfoPayload>;
  listStores: GraphQLOperation<Readonly<Record<string, never>>, readonly ExtensionStore[]>;
  addStore: GraphQLOperation<LegacyExtensionReposVariables | ExtensionStoreVariables, ExtensionStore>;
  removeStore: GraphQLOperation<LegacyExtensionReposVariables | ExtensionStoreVariables, ExtensionStore | null>;
  listExtensions: GraphQLOperation<Readonly<Record<string, never>>, readonly ExtensionRef[]>;
  refreshExtensions: GraphQLOperation<Readonly<Record<string, never>>, readonly ExtensionRef[]>;
  listSources: GraphQLOperation<Readonly<Record<string, never>>, readonly SourceRef[]>;
  sourcePreferences: GraphQLOperation<SourcePreferencesVariables, readonly SourcePreference[]>;
  updateSourcePreference: GraphQLOperation<
    SourcePreferenceChangeVariables,
    readonly SourcePreference[]
  >;
  installExtension: GraphQLOperation<ExtensionActionVariables, void>;
  updateExtension: GraphQLOperation<ExtensionActionVariables, void>;
  uninstallExtension: GraphQLOperation<ExtensionActionVariables, void>;
  search: GraphQLOperation<SourceSearchVariables, SourceSearchResult>;
  details: GraphQLOperation<MangaVariables, SourceItemDetails>;
  chapters: GraphQLOperation<ChapterVariables, readonly SourceChapter[]>;
  pages: GraphQLOperation<PageVariables, readonly SourcePage[]>;
}

export interface CompatibilityProfile {
  readonly id: CompatibilityProfileId;
  readonly contract: RuntimeContract;
  readonly operations: CompatibilityProfileOperations;
}

const RUNTIME_INFO: CompatibilityProfileOperations["runtimeInfo"] = {
  name: "EpigraphRuntimeInfo",
  kind: "query",
  document: `
    query EpigraphRuntimeInfo {
      aboutServer {
        name
        version
        revision
        buildType
        buildTime
      }
    }
  `,
  decode(value) {
    const root = record(value, "data");
    const about = record(field(root, "aboutServer", "data"), "data.aboutServer");
    return {
      name: string(field(about, "name", "data.aboutServer"), "data.aboutServer.name"),
      version: string(field(about, "version", "data.aboutServer"), "data.aboutServer.version"),
      revision: nullableString(about.revision, "data.aboutServer.revision"),
      buildType: nullableString(about.buildType, "data.aboutServer.buildType"),
      buildTime: nullableIntegerNumber(about.buildTime, "data.aboutServer.buildTime"),
    };
  },
};

function decodeSource(value: unknown, path: string): SourceRef {
  const raw = record(value, path);
  const rawExtension = raw.extension;
  const extensionPackageName = rawExtension === null || rawExtension === undefined
    ? null
    : string(
        field(record(rawExtension, `${path}.extension`), "pkgName", `${path}.extension`),
        `${path}.extension.pkgName`,
      );
  return {
    id: integerString(field(raw, "id", path), `${path}.id`),
    name: string(field(raw, "name", path), `${path}.name`),
    displayName: string(field(raw, "displayName", path), `${path}.displayName`),
    language: string(field(raw, "lang", path), `${path}.lang`),
    iconUrl: nullableString(raw.iconUrl, `${path}.iconUrl`),
    isNsfw: boolean(field(raw, "isNsfw", path), `${path}.isNsfw`),
    supportsLatest: nullableBoolean(raw.supportsLatest, `${path}.supportsLatest`),
    isConfigurable: nullableBoolean(raw.isConfigurable, `${path}.isConfigurable`),
    extensionPackageName,
  };
}

function decodeStringList(value: unknown, path: string): readonly string[] {
  return array(value, path).map((entry, index) => string(entry, `${path}[${index}]`));
}

function decodeNullableStringList(value: unknown, path: string): readonly string[] | null {
  return value === null || value === undefined ? null : decodeStringList(value, path);
}

function decodePreference(value: unknown, path: string, position: number): SourcePreference {
  const raw = record(value, path);
  const upstreamType = string(field(raw, "__typename", path), `${path}.__typename`);
  const key = nullableString(raw.key, `${path}.key`) ?? `position:${position}`;
  const title = nullableString(raw.title, `${path}.title`) ?? key;
  const summary = nullableString(raw.summary, `${path}.summary`);
  const enabled = raw.enabled === undefined ? true : boolean(raw.enabled, `${path}.enabled`);
  const visible = raw.visible === undefined ? true : boolean(raw.visible, `${path}.visible`);
  const base = { key, title, summary, enabled, visible };

  switch (upstreamType) {
    case "CheckBoxPreference":
      return {
        ...base,
        type: upstreamType,
        defaultValue: boolean(
          field(raw, "checkBoxDefault", path),
          `${path}.checkBoxDefault`,
        ),
        currentValue: nullableBoolean(raw.checkBoxCurrent, `${path}.checkBoxCurrent`),
      };
    case "SwitchPreference":
      return {
        ...base,
        type: upstreamType,
        defaultValue: boolean(
          field(raw, "switchDefault", path),
          `${path}.switchDefault`,
        ),
        currentValue: nullableBoolean(raw.switchCurrent, `${path}.switchCurrent`),
      };
    case "ListPreference":
      return {
        ...base,
        type: upstreamType,
        defaultValue: nullableString(raw.listDefault, `${path}.listDefault`),
        currentValue: nullableString(raw.listCurrent, `${path}.listCurrent`),
        entries: decodeStringList(field(raw, "entries", path), `${path}.entries`),
        entryValues: decodeStringList(
          field(raw, "entryValues", path),
          `${path}.entryValues`,
        ),
      };
    case "EditTextPreference":
      return {
        ...base,
        type: upstreamType,
        defaultValue: nullableString(raw.editTextDefault, `${path}.editTextDefault`),
        currentValue: nullableString(raw.editTextCurrent, `${path}.editTextCurrent`),
        text: nullableString(raw.text, `${path}.text`),
        dialogTitle: nullableString(raw.dialogTitle, `${path}.dialogTitle`),
        dialogMessage: nullableString(raw.dialogMessage, `${path}.dialogMessage`),
      };
    case "MultiSelectListPreference":
      return {
        ...base,
        type: upstreamType,
        defaultValue: decodeNullableStringList(raw.multiSelectDefault, `${path}.multiSelectDefault`),
        currentValue: decodeNullableStringList(raw.multiSelectCurrent, `${path}.multiSelectCurrent`),
        entries: decodeStringList(field(raw, "entries", path), `${path}.entries`),
        entryValues: decodeStringList(
          field(raw, "entryValues", path),
          `${path}.entryValues`,
        ),
        dialogTitle: nullableString(raw.dialogTitle, `${path}.dialogTitle`),
        dialogMessage: nullableString(raw.dialogMessage, `${path}.dialogMessage`),
      };
    default:
      return {
        ...base,
        type: "UnsupportedPreference",
        upstreamType,
      };
  }
}

function decodePreferences(value: unknown, path: string): readonly SourcePreference[] {
  return array(value, path).map(
    (entry, index) => decodePreference(entry, `${path}[${index}]`, index),
  );
}

const SOURCE_PREFERENCE_FIELDS = `
  __typename
  ... on CheckBoxPreference {
    key title summary enabled visible
    checkBoxDefault: default
    checkBoxCurrent: currentValue
  }
  ... on SwitchPreference {
    key title summary enabled visible
    switchDefault: default
    switchCurrent: currentValue
  }
  ... on ListPreference {
    key title summary enabled visible entries entryValues
    listDefault: default
    listCurrent: currentValue
  }
  ... on EditTextPreference {
    key title summary enabled visible text dialogTitle dialogMessage
    editTextDefault: default
    editTextCurrent: currentValue
  }
  ... on MultiSelectListPreference {
    key title summary enabled visible entries entryValues dialogTitle dialogMessage
    multiSelectDefault: default
    multiSelectCurrent: currentValue
  }
`;

function decodeExtension(value: unknown, path: string, v23: boolean): ExtensionRef {
  const raw = record(value, path);
  const versionValue = v23 ? field(raw, "versionCodeLong", path) : field(raw, "versionCode", path);
  return {
    packageName: string(field(raw, "pkgName", path), `${path}.pkgName`),
    name: string(field(raw, "name", path), `${path}.name`),
    language: string(field(raw, "lang", path), `${path}.lang`),
    versionName: string(field(raw, "versionName", path), `${path}.versionName`),
    versionCode: integerString(versionValue, `${path}.${v23 ? "versionCodeLong" : "versionCode"}`),
    isInstalled: boolean(field(raw, "isInstalled", path), `${path}.isInstalled`),
    isObsolete: boolean(field(raw, "isObsolete", path), `${path}.isObsolete`),
    hasUpdate: boolean(field(raw, "hasUpdate", path), `${path}.hasUpdate`),
    // Absent on fixtures and older payloads; the extension is then treated as not adult-only.
    isNsfw: raw.isNsfw === true,
    iconUrl: nullableString(raw.iconUrl, `${path}.iconUrl`),
    storeId: nullableString(v23 ? raw.storeIndexUrl : raw.repo, `${path}.${v23 ? "storeIndexUrl" : "repo"}`),
    apkName: nullableString(raw.apkName, `${path}.apkName`),
    apkUrl: nullableString(raw.apkUrl, `${path}.apkUrl`),
    jarUrl: nullableString(raw.jarUrl, `${path}.jarUrl`),
  };
}

function extensionFields(v23: boolean): string {
  return v23
    ? `
      pkgName name lang versionName versionCodeLong isInstalled isObsolete hasUpdate isNsfw
      iconUrl storeIndexUrl apkName apkUrl jarUrl
    `
    : `
      pkgName name lang versionName versionCode isInstalled isObsolete hasUpdate isNsfw
      iconUrl repo apkName
    `;
}

function extensionAction(
  name: string,
  patch: "install" | "update" | "uninstall",
  v23: boolean,
): GraphQLOperation<ExtensionActionVariables, void> {
  return {
    name,
    kind: "mutation",
    document: `
      mutation ${name}($id: String!) {
        updateExtension(input: { id: $id, patch: { ${patch}: true } }) {
          extension { ${extensionFields(v23)} }
        }
      }
    `,
    decode(value) {
      const root = record(value, "data");
      const payload = record(field(root, "updateExtension", "data"), "data.updateExtension");
      if (payload.extension !== null) {
        decodeExtension(payload.extension, "data.updateExtension.extension", v23);
      }
    },
  };
}

function commonOperations(v23: boolean): Omit<CompatibilityProfileOperations, "listStores" | "addStore" | "removeStore"> {
  const decodeExtensions = (value: unknown, path: string): readonly ExtensionRef[] =>
    nodes(value, path).map(
      (item, index) => decodeExtension(item, `${path}.nodes[${index}]`, v23),
    );

  return {
    runtimeInfo: RUNTIME_INFO,
    listExtensions: {
      name: "EpigraphExtensions",
      kind: "query",
      document: `
        query EpigraphExtensions {
          extensions {
            nodes { ${extensionFields(v23)} }
          }
        }
      `,
      decode(value) {
        const root = record(value, "data");
        return decodeExtensions(field(root, "extensions", "data"), "data.extensions");
      },
    },
    refreshExtensions: {
      name: "EpigraphRefreshExtensions",
      kind: "mutation",
      document: `
        mutation EpigraphRefreshExtensions {
          fetchExtensions(input: {}) {
            extensions { ${extensionFields(v23)} }
          }
        }
      `,
      decode(value) {
        const root = record(value, "data");
        const payload = record(
          field(root, "fetchExtensions", "data"),
          "data.fetchExtensions",
        );
        return array(
          field(payload, "extensions", "data.fetchExtensions"),
          "data.fetchExtensions.extensions",
        ).map(
          (item, index) =>
            decodeExtension(item, `data.fetchExtensions.extensions[${index}]`, v23),
        );
      },
    },
    listSources: {
      name: "EpigraphSources",
      kind: "query",
      document: `
        query EpigraphSources {
          sources {
            nodes {
              id name lang displayName iconUrl isNsfw supportsLatest isConfigurable
              extension { pkgName }
            }
          }
        }
      `,
      decode(value) {
        const root = record(value, "data");
        return nodes(field(root, "sources", "data"), "data.sources").map(
          (item, index) => decodeSource(item, `data.sources.nodes[${index}]`),
        );
      },
    },
    sourcePreferences: {
      name: "EpigraphSourcePreferences",
      kind: "query",
      document: `
        query EpigraphSourcePreferences($id: LongString!) {
          source(id: $id) {
            preferences { ${SOURCE_PREFERENCE_FIELDS} }
          }
        }
      `,
      decode(value) {
        const root = record(value, "data");
        const source = record(field(root, "source", "data"), "data.source");
        return decodePreferences(
          field(source, "preferences", "data.source"),
          "data.source.preferences",
        );
      },
    },
    updateSourcePreference: {
      name: "EpigraphUpdateSourcePreference",
      kind: "mutation",
      document: `
        mutation EpigraphUpdateSourcePreference($input: UpdateSourcePreferenceInput!) {
          updateSourcePreference(input: $input) {
            preferences { ${SOURCE_PREFERENCE_FIELDS} }
          }
        }
      `,
      decode(value) {
        const root = record(value, "data");
        const payload = record(
          field(root, "updateSourcePreference", "data"),
          "data.updateSourcePreference",
        );
        return decodePreferences(
          field(payload, "preferences", "data.updateSourcePreference"),
          "data.updateSourcePreference.preferences",
        );
      },
    },
    installExtension: extensionAction("EpigraphInstallExtension", "install", v23),
    updateExtension: extensionAction("EpigraphUpdateExtension", "update", v23),
    uninstallExtension: extensionAction("EpigraphUninstallExtension", "uninstall", v23),
    search: {
      name: "EpigraphSourceSearch",
      kind: "mutation",
      document: `
        mutation EpigraphSourceSearch(
          $source: LongString!
          $type: FetchSourceMangaType!
          $page: Int!
          $query: String
        ) {
          fetchSourceManga(input: { source: $source, type: $type, page: $page, query: $query }) {
            mangas {
              id title thumbnailUrl inLibrary status
              source { id name lang displayName iconUrl isNsfw supportsLatest isConfigurable extension { pkgName } }
            }
            hasNextPage
          }
        }
      `,
      decode(value) {
        const root = record(value, "data");
        const payload = record(field(root, "fetchSourceManga", "data"), "data.fetchSourceManga");
        const items = array(field(payload, "mangas", "data.fetchSourceManga"), "data.fetchSourceManga.mangas").map(
          (item, index) => {
            const path = `data.fetchSourceManga.mangas[${index}]`;
            const raw = record(item, path);
            const source = raw.source === null ? null : decodeSource(raw.source, `${path}.source`);
            return {
              id: integer(field(raw, "id", path), `${path}.id`),
              sourceId: source?.id ?? "",
              title: string(field(raw, "title", path), `${path}.title`),
              thumbnailUrl: nullableString(raw.thumbnailUrl, `${path}.thumbnailUrl`),
              inLibrary: boolean(field(raw, "inLibrary", path), `${path}.inLibrary`),
              status: nullableString(raw.status, `${path}.status`),
              source,
            };
          },
        );
        return {
          items,
          hasNextPage: boolean(field(payload, "hasNextPage", "data.fetchSourceManga"), "data.fetchSourceManga.hasNextPage"),
        };
      },
    },
    details: {
      name: "EpigraphSourceDetails",
      kind: "mutation",
      document: `
        mutation EpigraphSourceDetails($id: Int!) {
          fetchManga(input: { id: $id }) {
            manga {
              id title thumbnailUrl inLibrary status description author artist genre realUrl
              source { id name lang displayName iconUrl isNsfw supportsLatest isConfigurable extension { pkgName } }
            }
          }
        }
      `,
      decode(value) {
        const root = record(value, "data");
        const payload = record(field(root, "fetchManga", "data"), "data.fetchManga");
        const raw = record(field(payload, "manga", "data.fetchManga"), "data.fetchManga.manga");
        const source = raw.source === null ? null : decodeSource(raw.source, "data.fetchManga.manga.source");
        return {
          id: integer(field(raw, "id", "data.fetchManga.manga"), "data.fetchManga.manga.id"),
          sourceId: source?.id ?? "",
          title: string(field(raw, "title", "data.fetchManga.manga"), "data.fetchManga.manga.title"),
          thumbnailUrl: nullableString(raw.thumbnailUrl, "data.fetchManga.manga.thumbnailUrl"),
          inLibrary: boolean(field(raw, "inLibrary", "data.fetchManga.manga"), "data.fetchManga.manga.inLibrary"),
          status: nullableString(raw.status, "data.fetchManga.manga.status"),
          source,
          description: nullableString(raw.description, "data.fetchManga.manga.description"),
          author: nullableString(raw.author, "data.fetchManga.manga.author"),
          artist: nullableString(raw.artist, "data.fetchManga.manga.artist"),
          genres: array(field(raw, "genre", "data.fetchManga.manga"), "data.fetchManga.manga.genre").map(
            (genre, index) => string(genre, `data.fetchManga.manga.genre[${index}]`),
          ),
          realUrl: nullableString(raw.realUrl, "data.fetchManga.manga.realUrl"),
        };
      },
    },
    chapters: {
      name: "EpigraphSourceChapters",
      kind: "mutation",
      document: `
        mutation EpigraphSourceChapters($mangaId: Int!) {
          fetchChapters(input: { mangaId: $mangaId }) {
            chapters {
              id name chapterNumber sourceOrder isRead isDownloaded isBookmarked pageCount
              mangaId uploadDate realUrl lastPageRead scanlator
            }
          }
        }
      `,
      decode(value) {
        const root = record(value, "data");
        const payload = record(field(root, "fetchChapters", "data"), "data.fetchChapters");
        return array(field(payload, "chapters", "data.fetchChapters"), "data.fetchChapters.chapters").map(
          (item, index) => {
            const path = `data.fetchChapters.chapters[${index}]`;
            const raw = record(item, path);
            return {
              id: integer(field(raw, "id", path), `${path}.id`),
              mangaId: integer(field(raw, "mangaId", path), `${path}.mangaId`),
              name: string(field(raw, "name", path), `${path}.name`),
              chapterNumber: finiteNumber(field(raw, "chapterNumber", path), `${path}.chapterNumber`),
              sourceOrder: integer(field(raw, "sourceOrder", path), `${path}.sourceOrder`),
              isRead: boolean(field(raw, "isRead", path), `${path}.isRead`),
              isDownloaded: boolean(field(raw, "isDownloaded", path), `${path}.isDownloaded`),
              isBookmarked: boolean(field(raw, "isBookmarked", path), `${path}.isBookmarked`),
              pageCount: integer(field(raw, "pageCount", path), `${path}.pageCount`),
              uploadDate: nullableString(raw.uploadDate, `${path}.uploadDate`),
              realUrl: nullableString(raw.realUrl, `${path}.realUrl`),
              lastPageRead: integer(field(raw, "lastPageRead", path), `${path}.lastPageRead`),
              scanlator: nullableString(raw.scanlator, `${path}.scanlator`),
            };
          },
        );
      },
    },
    pages: {
      name: "EpigraphSourcePages",
      kind: "mutation",
      document: `
        mutation EpigraphSourcePages($chapterId: Int!) {
          fetchChapterPages(input: { chapterId: $chapterId }) {
            pages
          }
        }
      `,
      decode(value) {
        const root = record(value, "data");
        const payload = record(field(root, "fetchChapterPages", "data"), "data.fetchChapterPages");
        return array(field(payload, "pages", "data.fetchChapterPages"), "data.fetchChapterPages.pages").map(
          (url, index) => ({ index, url: string(url, `data.fetchChapterPages.pages[${index}]`) }),
        );
      },
    },
  };
}

function decodeExtensionStore(value: unknown, path: string): ExtensionStore {
  const raw = record(value, path);
  const indexUrl = string(field(raw, "indexUrl", path), `${path}.indexUrl`);
  return {
    id: indexUrl,
    name: string(field(raw, "name", path), `${path}.name`),
    indexUrl,
    badgeLabel: nullableString(raw.badgeLabel, `${path}.badgeLabel`),
    signingFingerprint: nullableString(raw.signingKey, `${path}.signingKey`),
    contactWebsite: nullableString(raw.contactWebsite, `${path}.contactWebsite`),
    contactDiscord: nullableString(raw.contactDiscord, `${path}.contactDiscord`),
    extensionListUrl: nullableString(raw.extensionListUrl, `${path}.extensionListUrl`),
    isLegacy: boolean(field(raw, "isLegacy", path), `${path}.isLegacy`),
  };
}

const V21_CONTRACT: RuntimeContract = {
  requiredQueries: ["aboutServer", "settings", "extensions", "sources"],
  requiredMutations: [
    "fetchExtensions",
    "updateExtension",
    "fetchSourceManga",
    "fetchManga",
    "fetchChapters",
    "fetchChapterPages",
    "setSettings",
  ],
  requiredFields: {
    ExtensionType: [
      "pkgName",
      "name",
      "lang",
      "versionName",
      "versionCode",
      "isInstalled",
      "isObsolete",
      "hasUpdate",
      "iconUrl",
      "repo",
      "apkName",
    ],
    SourceType: [
      "id",
      "name",
      "lang",
      "displayName",
      "iconUrl",
      "isNsfw",
      "supportsLatest",
      "isConfigurable",
      "extension",
    ],
  },
  optionalCapabilities: ["sourcePreferences", "sourcePreferenceWrite"],
};

const V23_CONTRACT: RuntimeContract = {
  requiredQueries: ["aboutServer", "extensionStores", "extensions", "sources"],
  requiredMutations: [
    "addExtensionStore",
    "removeExtensionStore",
    "fetchExtensions",
    "updateExtension",
    "fetchSourceManga",
    "fetchManga",
    "fetchChapters",
    "fetchChapterPages",
  ],
  requiredFields: {
    ExtensionType: [
      "pkgName",
      "name",
      "lang",
      "versionName",
      "versionCodeLong",
      "isInstalled",
      "isObsolete",
      "hasUpdate",
      "iconUrl",
      "storeIndexUrl",
      "apkName",
      "apkUrl",
      "jarUrl",
    ],
    ExtensionStoreType: [
      "name",
      "badgeLabel",
      "signingKey",
      "contactWebsite",
      "contactDiscord",
      "indexUrl",
      "isLegacy",
      "extensionListUrl",
    ],
    SourceType: [
      "id",
      "name",
      "lang",
      "displayName",
      "iconUrl",
      "isNsfw",
      "supportsLatest",
      "isConfigurable",
      "extension",
    ],
  },
  optionalCapabilities: [
    "extensionStoresV2",
    "directJarInstall",
    "extensionApi16",
    "sourcePreferences",
    "sourcePreferenceWrite",
  ],
};

export class CompatibilityProfileV21 implements CompatibilityProfile {
  readonly id = "suwayomi-v21" as const;
  readonly contract = V21_CONTRACT;
  readonly operations: CompatibilityProfileOperations = {
    ...commonOperations(false),
    listStores: {
      name: "EpigraphLegacyExtensionStores",
      kind: "query",
      document: `
        query EpigraphLegacyExtensionStores {
          settings { extensionRepos }
        }
      `,
      decode(value) {
        const root = record(value, "data");
        const settings = record(field(root, "settings", "data"), "data.settings");
        return array(field(settings, "extensionRepos", "data.settings"), "data.settings.extensionRepos").map(
          (url, index) => {
            const indexUrl = string(url, `data.settings.extensionRepos[${index}]`);
            return {
              id: indexUrl,
              name: indexUrl,
              indexUrl,
              badgeLabel: null,
              signingFingerprint: null,
              contactWebsite: null,
              contactDiscord: null,
              extensionListUrl: null,
              isLegacy: true,
            };
          },
        );
      },
    },
    addStore: {
      name: "EpigraphLegacyAddExtensionStore",
      kind: "mutation",
      document: `
        mutation EpigraphLegacyAddExtensionStore($repos: [String!]!) {
          setSettings(input: { settings: { extensionRepos: $repos } }) {
            settings { extensionRepos }
          }
        }
      `,
      decode(value) {
        const root = record(value, "data");
        const settings = record(field(root, "setSettings", "data"), "data.setSettings");
        const rawSettings = record(field(settings, "settings", "data.setSettings"), "data.setSettings.settings");
        const repos = array(field(rawSettings, "extensionRepos", "data.setSettings.settings"), "data.setSettings.settings.extensionRepos");
        const indexUrl = string(repos[repos.length - 1], "data.setSettings.settings.extensionRepos[-1]");
        return {
          id: indexUrl,
          name: indexUrl,
          indexUrl,
          badgeLabel: null,
          signingFingerprint: null,
          contactWebsite: null,
          contactDiscord: null,
          extensionListUrl: null,
          isLegacy: true,
        };
      },
    },
    removeStore: {
      name: "EpigraphLegacyRemoveExtensionStore",
      kind: "mutation",
      document: `
        mutation EpigraphLegacyRemoveExtensionStore($repos: [String!]!) {
          setSettings(input: { settings: { extensionRepos: $repos } }) {
            settings { extensionRepos }
          }
        }
      `,
      decode() {
        return null;
      },
    },
  };
}

export class CompatibilityProfileV23 implements CompatibilityProfile {
  readonly id = "suwayomi-v23" as const;
  readonly contract = V23_CONTRACT;
  readonly operations: CompatibilityProfileOperations = {
    ...commonOperations(true),
    listStores: {
      name: "EpigraphExtensionStores",
      kind: "query",
      document: `
        query EpigraphExtensionStores {
          extensionStores {
            nodes {
              name badgeLabel signingKey contactWebsite contactDiscord
              indexUrl isLegacy extensionListUrl
            }
          }
        }
      `,
      decode(value) {
        const root = record(value, "data");
        return nodes(field(root, "extensionStores", "data"), "data.extensionStores").map(
          (item, index) => {
            const path = `data.extensionStores.nodes[${index}]`;
            const raw = record(item, path);
            const indexUrl = string(field(raw, "indexUrl", path), `${path}.indexUrl`);
            return {
              id: indexUrl,
              name: string(field(raw, "name", path), `${path}.name`),
              indexUrl,
              badgeLabel: nullableString(raw.badgeLabel, `${path}.badgeLabel`),
              signingFingerprint: nullableString(raw.signingKey, `${path}.signingKey`),
              contactWebsite: nullableString(raw.contactWebsite, `${path}.contactWebsite`),
              contactDiscord: nullableString(raw.contactDiscord, `${path}.contactDiscord`),
              extensionListUrl: nullableString(raw.extensionListUrl, `${path}.extensionListUrl`),
              isLegacy: boolean(field(raw, "isLegacy", path), `${path}.isLegacy`),
            };
          },
        );
      },
    },
    addStore: {
      name: "EpigraphAddExtensionStore",
      kind: "mutation",
      document: `
        mutation EpigraphAddExtensionStore($indexUrl: String!) {
          addExtensionStore(input: { indexUrl: $indexUrl }) {
            extensionStore {
              name badgeLabel signingKey contactWebsite contactDiscord
              indexUrl isLegacy extensionListUrl
            }
          }
        }
      `,
      decode(value) {
        const root = record(value, "data");
        const payload = record(field(root, "addExtensionStore", "data"), "data.addExtensionStore");
        return decodeExtensionStore(
          field(payload, "extensionStore", "data.addExtensionStore"),
          "data.addExtensionStore.extensionStore",
        );
      },
    },
    removeStore: {
      name: "EpigraphRemoveExtensionStore",
      kind: "mutation",
      document: `
        mutation EpigraphRemoveExtensionStore($indexUrl: String!) {
          removeExtensionStore(input: { indexUrl: $indexUrl }) {
            extensionStore {
              name badgeLabel signingKey contactWebsite contactDiscord
              indexUrl isLegacy extensionListUrl
            }
          }
        }
      `,
      decode(value) {
        const root = record(value, "data");
        const payload = record(field(root, "removeExtensionStore", "data"), "data.removeExtensionStore");
        return payload.extensionStore === null || payload.extensionStore === undefined
          ? null
          : decodeExtensionStore(payload.extensionStore, "data.removeExtensionStore.extensionStore");
      },
    },
  };
}
