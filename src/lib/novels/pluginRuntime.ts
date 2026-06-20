import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import * as cheerio from "cheerio";
import { Parser } from "htmlparser2";
import { gcm } from "@noble/ciphers/aes.js";
import { bytesToUtf8, utf8ToBytes } from "@noble/ciphers/utils.js";
import { parse as parseProto } from "protobufjs";
import { isSourceChallengeMessage } from "../sourceAccess";

export interface NovelPluginSmokeInput {
  pluginId: string;
  artifactUrl: string;
  pluginSource: string;
  settingsSeed?: Record<string, unknown> | null;
  webStorageSeed?: {
    localStorage?: unknown;
    sessionStorage?: unknown;
  } | null;
}

export interface NovelPluginDetailsSmokeInput extends NovelPluginSmokeInput {
  novelPath: string;
}

export interface NovelPluginSearchSmokeInput extends NovelPluginSmokeInput {
  searchTerm: string;
  pageNo?: number;
}

export interface NovelPluginPopularSmokeInput extends NovelPluginSmokeInput {
  pageNo?: number;
  options?: Record<string, unknown>;
}

export interface NovelPluginChapterSmokeInput extends NovelPluginSmokeInput {
  chapterPath: string;
}

export type NovelPluginContractKind = "plugin-base" | "page-plugin" | "unknown";

export interface NovelPluginBoundarySummary {
  pluginId: string;
  name: string | null;
  site: string | null;
  hasDefaultExport: boolean;
  hasFilters: boolean;
  hasPluginSettings: boolean;
  hasPopularNovels: boolean;
  hasSearchNovels: boolean;
  hasParseNovel: boolean;
  hasParseChapter: boolean;
  hasParsePage: boolean;
  usesWebStorage: boolean;
  contractKind: NovelPluginContractKind;
  filterKeys: string[];
  pluginSettingKeys: string[];
}

export interface LoadedNovelPluginBoundary {
  plugin: NovelPluginLike;
  summary: NovelPluginBoundarySummary;
  storageSnapshot: Record<string, unknown>;
  webStorageSnapshot: {
    localStorage: unknown;
    sessionStorage: unknown;
  };
}

export interface NovelPluginDetailsSummary {
  pluginId: string;
  name: string | null;
  novelPath: string;
  chapterCount: number | null;
  firstChapterPath: string | null;
  hasSummary: boolean;
  author: string | null;
  cover: string | null;
  summary: string | null;
  status: string | null;
  tags: string[];
  chapters: Array<{
    path: string | null;
    title: string | null;
    releaseTime: number | null;
  }>;
}

export interface NovelPluginSearchResultSummary {
  name: string | null;
  path: string | null;
  cover: string | null;
  rating: number | string | null;
  score: number | string | null;
  stars: number | string | null;
  ratingMax: number | string | null;
  scoreMax: number | string | null;
}

export interface NovelPluginSearchSummary {
  pluginId: string;
  searchTerm: string;
  pageNo: number;
  resultCount: number;
  results: NovelPluginSearchResultSummary[];
}

export interface NovelPluginPopularSummary {
  pluginId: string;
  pageNo: number;
  resultCount: number;
  results: NovelPluginSearchResultSummary[];
}

export interface NovelPluginChapterSummary {
  pluginId: string;
  chapterPath: string;
  contentLength: number;
  hasContent: boolean;
  preview: string | null;
  content: string;
}

interface NovelPluginLike extends Record<string, unknown> {
  id?: string;
  name?: string;
  site?: string;
  filters?: Record<string, unknown>;
  pluginSettings?: Record<string, unknown>;
  imageRequestInit?: {
    headers?: Record<string, string>;
    [key: string]: unknown;
  };
  webStorageUtilized?: boolean;
  resolveUrl?: (path: string, isNovel?: boolean) => Promise<string> | string;
  popularNovels?: (pageNo: number, options?: Record<string, unknown>) => Promise<unknown> | unknown;
  searchNovels?: (searchTerm: string, pageNo: number) => Promise<unknown> | unknown;
  parseNovel?: (novelPath: string) => Promise<unknown> | unknown;
  parseChapter?: (chapterPath: string) => Promise<unknown> | unknown;
  parsePage?: (novelPath: string, page: number) => Promise<unknown> | unknown;
}

interface MemoryStoredItem {
  created: Date;
  value: unknown;
  expires?: number;
}

interface NovelRuntimeStorageShape {
  storage: {
    get: (key: string, raw?: boolean) => unknown;
    set: (key: string, value: unknown, expires?: Date | number) => unknown;
    delete: (key: string) => void;
    remove: (key: string) => void;
    clearAll: () => void;
    getAllKeys: () => string[];
  };
  localStorage: {
    get: () => unknown;
  };
  sessionStorage: {
    get: () => unknown;
  };
  snapshot: () => Record<string, unknown>;
  webStorageSnapshot: () => { localStorage: unknown; sessionStorage: unknown };
}

type NovelFilterOption = {
  label: string;
  value: string;
};

type NovelFilterInputConfig = {
  type?: string;
  label?: string;
  value?: unknown;
  options?: NovelFilterOption[];
  [key: string]: unknown;
};

type NovelRuntimeFetchInit = {
  headers?: Headers | Record<string, string>;
  method?: string;
  body?: BodyInit | Uint8Array | string | null;
  [key: string]: unknown;
};

type NovelRuntimeProtoInit = {
  proto: string;
  requestType: string;
  requestData?: Record<string, unknown>;
  responseType: string;
};

function normalizeText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function normalizeNumberish(value: unknown): number | string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  return normalizeText(value);
}

function normalizeRuntimeErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  try {
    const serialized = JSON.stringify(error);
    if (serialized && serialized !== "{}") {
      return serialized;
    }
  } catch {}
  return String(error);
}

function normalizeResultList(payload: unknown): NovelPluginSearchResultSummary[] {
  if (!Array.isArray(payload)) {
    return [];
  }

  return payload
    .map((entry) => {
      if (!entry || typeof entry !== "object") {
        return null;
      }

      const record = entry as Record<string, unknown>;
      return {
        name: normalizeText(record.name),
        path: normalizeText(record.path),
        cover: normalizeText(record.cover),
        rating: normalizeNumberish(
          record.rating
            ?? record.rate
            ?? record.averageRating
            ?? record.avgRating
            ?? record.ratingText,
        ),
        score: normalizeNumberish(record.score ?? record.scoreText),
        stars: normalizeNumberish(record.stars ?? record.starRating),
        ratingMax: normalizeNumberish(record.ratingMax ?? record.maxRating),
        scoreMax: normalizeNumberish(record.scoreMax ?? record.maxScore),
      } satisfies NovelPluginSearchResultSummary;
    })
    .filter((entry): entry is NovelPluginSearchResultSummary => Boolean(entry));
}

function normalizeChapterList(payload: unknown): Array<{
  path: string | null;
  title: string | null;
  releaseTime: number | null;
}> {
  if (!Array.isArray(payload)) {
    return [];
  }

  return payload
    .map((entry) => {
      if (!entry || typeof entry !== "object") {
        return null;
      }

      const record = entry as Record<string, unknown>;
      return {
        path: normalizeText(record.path),
        title: normalizeText(record.name) ?? normalizeText(record.chapterName) ?? normalizeText(record.title),
        releaseTime: typeof record.releaseTime === "number" ? record.releaseTime : null,
      };
    })
    .filter((entry): entry is { path: string | null; title: string | null; releaseTime: number | null } => Boolean(entry));
}

function normalizeTagList(payload: unknown): string[] {
  if (!Array.isArray(payload)) {
    return [];
  }

  return [...new Set(
    payload
      .map((entry) => normalizeText(entry))
      .filter((entry): entry is string => Boolean(entry)),
  )];
}

function getDefaultUserAgent(): string {
  const browserAgent = normalizeText(globalThis.navigator?.userAgent);
  return browserAgent ?? "Aethon Novel Runtime";
}

interface RuntimeFlareSolverrSettings {
  enabled: boolean;
  url: string;
  timeoutSeconds: number;
  sessionName: string;
  sessionTtlMinutes: number;
  responseFallback: boolean;
}

function readRuntimeFlareSolverrSettings(): RuntimeFlareSolverrSettings {
  const defaults: RuntimeFlareSolverrSettings = {
    enabled: false,
    url: "http://localhost:8191",
    timeoutSeconds: 60,
    sessionName: "aethon",
    sessionTtlMinutes: 15,
    responseFallback: false,
  };

  try {
    const raw =
      globalThis.localStorage?.getItem("aethon-store")
        ?? globalThis.localStorage?.getItem("moku-store");
    const parsed = raw ? JSON.parse(raw) : null;
    const settings = parsed?.settings ?? {};
    return {
      enabled: settings.flareSolverrEnabled === true,
      url: typeof settings.flareSolverrUrl === "string" && settings.flareSolverrUrl.trim()
        ? settings.flareSolverrUrl.trim()
        : defaults.url,
      timeoutSeconds: typeof settings.flareSolverrTimeout === "number" ? settings.flareSolverrTimeout : defaults.timeoutSeconds,
      sessionName: typeof settings.flareSolverrSessionName === "string" && settings.flareSolverrSessionName.trim()
        ? settings.flareSolverrSessionName.trim()
        : defaults.sessionName,
      sessionTtlMinutes: typeof settings.flareSolverrSessionTtl === "number" ? settings.flareSolverrSessionTtl : defaults.sessionTtlMinutes,
      responseFallback: settings.flareSolverrFallback === true || settings.flareSolverrAsResponseFallback === true,
    };
  } catch {
    return defaults;
  }
}

function flareSolverrEndpoint(rawUrl: string): string {
  const parsed = new URL(rawUrl || "http://localhost:8191");
  return `${parsed.origin}/v1`;
}

function responseHeadersContainChallenge(headers: Headers | undefined): boolean {
  if (!headers || typeof headers.entries !== "function") return false;
  for (const [key, value] of headers.entries()) {
    if (/^cf-|server|set-cookie/i.test(key) && /cloudflare|cf-|__cf|challenge/i.test(value)) return true;
  }
  return false;
}

function responseStatusMayBeChallenge(status: number): boolean {
  return status === 403
    || status === 429
    || status === 503
    || status === 520
    || status === 521
    || status === 522
    || status === 523
    || status === 524;
}

function responseTextLooksLikeChallenge(text: string): boolean {
  return isSourceChallengeMessage(text)
    || /checking your browser|just a moment|cf-browser-verification|cf-chl|turnstile/i.test(text);
}

function normalizeFlareSolverrHeaders(headers: unknown): Headers {
  const normalized = new Headers();
  if (!headers || typeof headers !== "object") return normalized;
  for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
    if (typeof value === "string") normalized.set(key, value);
  }
  return normalized;
}

async function requestViaFlareSolverr(
  url: string,
  init: NovelRuntimeFetchInit | undefined,
  settings: RuntimeFlareSolverrSettings,
): Promise<Response> {
  const response = await tauriFetch(flareSolverrEndpoint(settings.url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      cmd: "request.get",
      url,
      maxTimeout: Math.max(10_000, Math.floor(settings.timeoutSeconds * 1000)),
      session: settings.sessionName,
      session_ttl_minutes: settings.sessionTtlMinutes,
      headers: normalizeFetchHeaders(init?.headers),
    }),
  });

  if (!response.ok) {
    throw new Error(`FlareSolverr request failed with HTTP ${response.status}.`);
  }

  const payload = await response.json().catch(() => null) as {
    status?: string;
    message?: string;
    solution?: {
      response?: string;
      status?: number;
      url?: string;
      headers?: Record<string, string>;
    };
  } | null;
  if (payload?.status !== "ok" || !payload.solution?.response) {
    throw new Error(payload?.message || "FlareSolverr did not return a usable response.");
  }

  return new Response(payload.solution.response, {
    status: payload.solution.status ?? 200,
    headers: normalizeFlareSolverrHeaders(payload.solution.headers),
  });
}

function normalizeFetchHeaders(headers?: Headers | Record<string, string>): Record<string, string> {
  const normalized: Record<string, string> = {
    Connection: "keep-alive",
    Accept: "*/*",
    "Accept-Language": "*",
    "Sec-Fetch-Mode": "cors",
    "Accept-Encoding": "gzip, deflate",
    "Cache-Control": "max-age=0",
    "User-Agent": getDefaultUserAgent(),
  };

  if (!headers) {
    return normalized;
  }

  if (headers instanceof Headers) {
    headers.forEach((value, key) => {
      normalized[key] = value;
    });
    if (!Object.keys(normalized).some((key) => key.toLowerCase() === "user-agent")) {
      normalized["User-Agent"] = getDefaultUserAgent();
    }
    return normalized;
  }

  return {
    ...normalized,
    ...headers,
  };
}

class MemoryStorage {
  private readonly values = new Map<string, MemoryStoredItem>();

  constructor(seed?: Record<string, unknown> | null) {
    for (const [key, value] of Object.entries(seed ?? {})) {
      this.values.set(key, {
        created: new Date(0),
        value,
      });
    }
  }

  set(key: string, value: unknown, expires?: Date | number) {
    this.values.set(key, {
      created: new Date(),
      value,
      expires: expires instanceof Date ? expires.getTime() : expires,
    });
    return value;
  }

  get(key: string, raw?: boolean) {
    const item = this.values.get(key);
    if (!item) {
      return undefined;
    }

    if (typeof item.expires === "number" && Date.now() > item.expires) {
      this.delete(key);
      return undefined;
    }

    if (raw) {
      return {
        created: item.created,
        value: item.value,
        expires: item.expires,
      };
    }

    return item.value;
  }

  delete(key: string) {
    this.values.delete(key);
  }

  remove(key: string) {
    this.delete(key);
  }

  clearAll() {
    this.values.clear();
  }

  getAllKeys() {
    return [...this.values.keys()];
  }

  snapshot() {
    const entries = [...this.values.entries()].map(([key, item]) => [key, item.value]);
    return Object.fromEntries(entries);
  }
}

class MemoryWebStorage {
  constructor(private readonly value: unknown) {}

  get() {
    return this.value;
  }
}

function createStorageShim(input: NovelPluginSmokeInput): NovelRuntimeStorageShape {
  const storage = new MemoryStorage(input.settingsSeed);
  const localStorage = new MemoryWebStorage(input.webStorageSeed?.localStorage);
  const sessionStorage = new MemoryWebStorage(input.webStorageSeed?.sessionStorage);

  return {
    storage: {
      get: (key, raw) => storage.get(key, raw),
      set: (key, value, expires) => storage.set(key, value, expires),
      delete: (key) => storage.delete(key),
      remove: (key) => storage.remove(key),
      clearAll: () => storage.clearAll(),
      getAllKeys: () => storage.getAllKeys(),
    },
    localStorage: {
      get: () => localStorage.get(),
    },
    sessionStorage: {
      get: () => sessionStorage.get(),
    },
    snapshot() {
      return storage.snapshot();
    },
    webStorageSnapshot() {
      return {
        localStorage: localStorage.get(),
        sessionStorage: sessionStorage.get(),
      };
    },
  };
}

function createDayJsShim() {
  const createValue = (input?: unknown) => ({
    subtract() {
      return createValue(input);
    },
    format() {
      return typeof input === "string" ? input : "1970-01-01";
    },
  });

  const dayJs = ((input?: unknown) => createValue(input)) as ((input?: unknown) => ReturnType<typeof createValue>) & {
    extend: (...args: unknown[]) => void;
    locale: (...args: unknown[]) => void;
  };

  dayJs.extend = () => {};
  dayJs.locale = () => {};
  return dayJs;
}

function unsupportedModule(moduleId: string): never {
  throw new Error(`LNReader smoke runtime does not expose module ${moduleId}.`);
}

function normalizeCharsetLabel(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = value.trim().replace(/^["']|["']$/g, "").toLowerCase();
  if (!normalized) return null;

  switch (normalized) {
    case "utf8":
      return "utf-8";
    case "gbk":
    case "gb2312":
    case "gb_2312":
    case "cp936":
      return "gb18030";
    case "big5-hkscs":
      return "big5";
    default:
      return normalized;
  }
}

function extractCharsetFromContentType(contentType: string | null | undefined): string | null {
  if (!contentType) return null;
  const match = /charset\s*=\s*([^;]+)/i.exec(contentType);
  return normalizeCharsetLabel(match?.[1] ?? null);
}

function detectCharsetFromHtmlHead(bytes: Uint8Array): string | null {
  const asciiHead = new TextDecoder("latin1").decode(bytes.slice(0, 2048));
  const charsetMetaMatch = /<meta[^>]+charset=["']?\s*([a-zA-Z0-9._-]+)/i.exec(asciiHead);
  if (charsetMetaMatch?.[1]) {
    return normalizeCharsetLabel(charsetMetaMatch[1]);
  }

  const contentTypeMetaMatch = /<meta[^>]+content=["'][^"']*charset=([a-zA-Z0-9._-]+)/i.exec(asciiHead);
  return normalizeCharsetLabel(contentTypeMetaMatch?.[1] ?? null);
}

function decodeBytesWithCharset(bytes: Uint8Array, charset: string | null): string {
  const candidates = [
    charset,
    charset?.startsWith("utf-") ? null : "utf-8",
    "latin1",
  ].filter((value, index, values): value is string => Boolean(value) && values.indexOf(value) === index);

  for (const candidate of candidates) {
    try {
      return new TextDecoder(candidate).decode(bytes);
    } catch {}
  }

  return new TextDecoder().decode(bytes);
}

async function readResponseBytes(response: Response): Promise<Uint8Array> {
  if (typeof response.arrayBuffer === "function") {
    return new Uint8Array(await response.arrayBuffer());
  }

  const text = await response.text();
  return utf8ToBytes(text);
}

async function readResponseText(response: Response): Promise<string> {
  const bytes = await readResponseBytes(response);
  const contentType = typeof response.headers?.get === "function"
    ? response.headers.get("content-type")
    : null;
  const headerCharset = extractCharsetFromContentType(contentType);
  const sniffedCharset = detectCharsetFromHtmlHead(bytes);
  const preferredCharset = sniffedCharset ?? headerCharset;
  return decodeBytesWithCharset(bytes, preferredCharset);
}

function wrapRuntimeResponse(response: Response): Response {
  const wrapped = {
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    url: response.url,
    redirected: response.redirected,
    type: response.type,
    headers: response.headers,
  } as Response;
  const originalJson = typeof response.json === "function" ? response.json.bind(response) : null;
  wrapped.text = async () => readResponseText(response);
  wrapped.arrayBuffer = async () => {
    const bytes = await readResponseBytes(response);
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  };
  wrapped.json = async () => {
    if (originalJson) {
      return originalJson();
    }
    return JSON.parse(await readResponseText(response));
  };
  return wrapped;
}

function encodeGrpcEnvelope(payload: Uint8Array): Uint8Array {
  const header = new Uint8Array(5);
  header[0] = 0;
  header[1] = (payload.length >>> 24) & 0xff;
  header[2] = (payload.length >>> 16) & 0xff;
  header[3] = (payload.length >>> 8) & 0xff;
  header[4] = payload.length & 0xff;

  const body = new Uint8Array(header.length + payload.length);
  body.set(header, 0);
  body.set(payload, header.length);
  return body;
}

function createFetchShim() {
  const fetchApi = async (url: string, init?: NovelRuntimeFetchInit) => {
    const settings = readRuntimeFlareSolverrSettings();
    const response = await tauriFetch(url, {
      method: init?.method ?? "GET",
      headers: normalizeFetchHeaders(init?.headers),
      body: init?.body ?? undefined,
    });

    if (
      responseStatusMayBeChallenge(response.status)
      || responseHeadersContainChallenge(response.headers)
    ) {
      const text = await readResponseText(response);
      if (responseTextLooksLikeChallenge(text)) {
        if (!settings.enabled) {
          throw new Error("Source challenge requires FlareSolverr recovery for this LNReader source.");
        }
        return wrapRuntimeResponse(await requestViaFlareSolverr(url, init, settings));
      }

      return wrapRuntimeResponse(new Response(text, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      }));
    }

    return wrapRuntimeResponse(response);
  };

  return {
    fetchApi,
    async fetchText(url: string, init?: NovelRuntimeFetchInit, _encoding?: string) {
      const response = await fetchApi(url, init);
      if (!response.ok) {
        return "";
      }
      return response.text();
    },
    async fetchJson(url: string, init?: NovelRuntimeFetchInit) {
      const response = await fetchApi(url, init);
      return response.json();
    },
    async fetchProto(protoInit: NovelRuntimeProtoInit, url: string, init?: NovelRuntimeFetchInit) {
      const protoRoot = parseProto(protoInit.proto).root;
      const requestMessage = protoRoot.lookupType(protoInit.requestType);
      const verifyError = requestMessage.verify(protoInit.requestData ?? {});
      if (verifyError) {
        throw new Error(`Invalid Proto: ${verifyError}`);
      }

      const encodedRequest = requestMessage.encode(protoInit.requestData ?? {}).finish();
      const response = await fetchApi(url, {
        ...init,
        method: "POST",
        body: encodeGrpcEnvelope(encodedRequest),
      });
      const payload = await readResponseBytes(response);
      if (payload.length < 5) {
        throw new Error("Proto response payload is too short.");
      }

      const responseLength = (
        (payload[1] << 24)
        | (payload[2] << 16)
        | (payload[3] << 8)
        | payload[4]
      ) >>> 0;
      const responseMessage = protoRoot.lookupType(protoInit.responseType);
      return responseMessage.decode(payload.slice(5, 5 + responseLength));
    },
  };
}

function createFilterInputsShim() {
  const FilterTypes = {
    TextInput: "Text",
    Picker: "Picker",
    CheckboxGroup: "Checkbox",
    Switch: "Switch",
    ExcludableCheckboxGroup: "XCheckbox",
  } as const;

  class FilterInput {
    type: string;
    label?: string;
    value?: unknown;
    options?: NovelFilterOption[];

    constructor(config: NovelFilterInputConfig = {}) {
      Object.assign(this, config);
      this.type = typeof config.type === "string" ? config.type : FilterTypes.TextInput;
    }
  }

  class TextInput extends FilterInput {
    constructor(config: NovelFilterInputConfig = {}) {
      super({ ...config, type: FilterTypes.TextInput });
    }
  }

  class Picker extends FilterInput {
    constructor(config: NovelFilterInputConfig = {}) {
      super({ ...config, type: FilterTypes.Picker });
    }
  }

  class CheckboxGroup extends FilterInput {
    constructor(config: NovelFilterInputConfig = {}) {
      super({ ...config, type: FilterTypes.CheckboxGroup });
    }
  }

  class Switch extends FilterInput {
    constructor(config: NovelFilterInputConfig = {}) {
      super({ ...config, type: FilterTypes.Switch });
    }
  }

  class ExcludableCheckboxGroup extends FilterInput {
    constructor(config: NovelFilterInputConfig = {}) {
      super({ ...config, type: FilterTypes.ExcludableCheckboxGroup });
    }
  }

  return {
    FilterTypes,
    FilterInput,
    TextInput,
    Picker,
    CheckboxGroup,
    Switch,
    ExcludableCheckboxGroup,
    // Compatibility aliases for older Aethon tests and partial shims.
    Input: TextInput,
    Checkbox: CheckboxGroup,
    ExcludableCheckbox: ExcludableCheckboxGroup,
  };
}

function createRequireShim(storageShim: NovelRuntimeStorageShape) {
  const fetchShim = createFetchShim();
  const filterInputs = createFilterInputsShim();
  const isUrlAbsolute = (value: string) => /^[a-z]+:/i.test(value);

  const modules = new Map<string, unknown>([
    ["htmlparser2", { Parser }],
    ["cheerio", { ...cheerio, default: cheerio }],
    ["dayjs", createDayJsShim()],
    ["urlencode", {
      encode: encodeURIComponent,
      decode: decodeURIComponent,
    }],
    ["@libs/novelStatus", {
      NovelStatus: {
        Ongoing: "ongoing",
        Completed: "completed",
        Unknown: "unknown",
      },
    }],
    ["@libs/fetch", { ...fetchShim, default: fetchShim }],
    ["@libs/isAbsoluteUrl", {
      isUrlAbsolute,
      isAbsoluteUrl: isUrlAbsolute,
    }],
    ["@libs/filterInputs", filterInputs],
    ["@libs/defaultCover", { defaultCover: "about:blank" }],
    ["@libs/aes", { gcm }],
    ["@libs/utils", { utf8ToBytes, bytesToUtf8 }],
    ["@libs/storage", {
      storage: storageShim.storage,
      localStorage: storageShim.localStorage,
      sessionStorage: storageShim.sessionStorage,
    }],
  ]);

  return (moduleId: string) => modules.get(moduleId) ?? unsupportedModule(moduleId);
}

function resolveNovelPluginContractKind(plugin: NovelPluginLike): NovelPluginContractKind {
  if (typeof plugin.parsePage === "function") {
    return "page-plugin";
  }

  if (
    typeof plugin.popularNovels === "function"
    || typeof plugin.searchNovels === "function"
    || typeof plugin.parseNovel === "function"
    || typeof plugin.parseChapter === "function"
  ) {
    return "plugin-base";
  }

  return "unknown";
}

function ensureDefaultImageRequestInit(plugin: NovelPluginLike) {
  const userAgent = getDefaultUserAgent();
  if (!plugin.imageRequestInit) {
    plugin.imageRequestInit = {
      headers: {
        "User-Agent": userAgent,
      },
    };
    return;
  }

  if (!plugin.imageRequestInit.headers) {
    plugin.imageRequestInit.headers = {};
  }

  const hasUserAgent = Object.keys(plugin.imageRequestInit.headers).some((key) => key.toLowerCase() === "user-agent");
  if (!hasUserAgent) {
    plugin.imageRequestInit.headers["User-Agent"] = userAgent;
  }
}

function cloneRuntimeValue<T>(value: T): T {
  if (value == null || typeof value !== "object") return value;
  if (typeof structuredClone === "function") {
    try {
      return structuredClone(value);
    } catch {
      // Fall back to JSON cloning for plugin metadata, which is expected to be data-only.
    }
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

function createPopularOptions(plugin: NovelPluginLike, inputOptions: Record<string, unknown> | undefined): Record<string, unknown> {
  const options = { ...(inputOptions ?? {}) };
  if (!("filters" in options) && plugin.filters && typeof plugin.filters === "object") {
    options.filters = cloneRuntimeValue(plugin.filters);
  }
  return options;
}

function evaluatePluginSource(input: NovelPluginSmokeInput): LoadedNovelPluginBoundary {
  const storageShim = createStorageShim(input);
  const require = createRequireShim(storageShim);
  const module = { exports: {} as Record<string, unknown> };
  const exports = module.exports;

  const runtime = new Function(
    "module",
    "exports",
    "require",
    "__filename",
    "__dirname",
    "globalThis",
    `${input.pluginSource}\nreturn module.exports;`,
  );

  const moduleExports = runtime(
    module,
    exports,
    require,
    `${input.pluginId}.js`,
    "/",
    globalThis,
  ) as Record<string, unknown>;

  const defaultExport = (
    moduleExports.default
    ?? module.exports.default
    ?? module.exports
  ) as NovelPluginLike | null | undefined;

  if (!defaultExport || typeof defaultExport !== "object") {
    throw new Error("LNReader plugin did not expose an object default export.");
  }

  ensureDefaultImageRequestInit(defaultExport);

  const filters = (defaultExport.filters && typeof defaultExport.filters === "object")
    ? Object.keys(defaultExport.filters as Record<string, unknown>)
    : [];
  const pluginSettings = (defaultExport.pluginSettings && typeof defaultExport.pluginSettings === "object")
    ? Object.keys(defaultExport.pluginSettings as Record<string, unknown>)
    : [];

  return {
    plugin: defaultExport,
    summary: {
      pluginId: input.pluginId,
      name: normalizeText(defaultExport.name),
      site: normalizeText(defaultExport.site),
      hasDefaultExport: true,
      hasFilters: filters.length > 0,
      hasPluginSettings: pluginSettings.length > 0,
      hasPopularNovels: typeof defaultExport.popularNovels === "function",
      hasSearchNovels: typeof defaultExport.searchNovels === "function",
      hasParseNovel: typeof defaultExport.parseNovel === "function",
      hasParseChapter: typeof defaultExport.parseChapter === "function",
      hasParsePage: typeof defaultExport.parsePage === "function",
      usesWebStorage: defaultExport.webStorageUtilized === true,
      contractKind: resolveNovelPluginContractKind(defaultExport),
      filterKeys: filters,
      pluginSettingKeys: pluginSettings,
    },
    storageSnapshot: storageShim.snapshot(),
    webStorageSnapshot: storageShim.webStorageSnapshot(),
  };
}

export function loadNovelPluginBoundary(input: NovelPluginSmokeInput): LoadedNovelPluginBoundary {
  try {
    return evaluatePluginSource(input);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown LNReader plugin load failure.";
    throw new Error(`Plugin ${input.pluginId} could not be loaded in the smoke runtime: ${message}`);
  }
}

export function readNovelPluginSettings(input: NovelPluginSmokeInput) {
  const loaded = loadNovelPluginBoundary(input);
  return {
    ...loaded.summary,
    pluginSettings: loaded.plugin.pluginSettings ?? {},
    storageSnapshot: loaded.storageSnapshot,
    webStorageSnapshot: loaded.webStorageSnapshot,
  };
}

export function readNovelPluginFilters(input: NovelPluginSmokeInput) {
  const loaded = loadNovelPluginBoundary(input);
  return {
    ...loaded.summary,
    filters: loaded.plugin.filters ?? {},
  };
}

export async function resolveNovelPluginRuntimeUrl(input: NovelPluginSmokeInput & { url: string; isNovel?: boolean }): Promise<string> {
  const loaded = loadNovelPluginBoundary(input);
  const pluginResolveUrl = loaded.plugin.resolveUrl;

  if (typeof pluginResolveUrl === "function") {
    const resolved = await pluginResolveUrl.call(loaded.plugin, input.url, input.isNovel);
    const value = normalizeText(resolved);
    if (!value) {
      throw new Error("Plugin resolveUrl returned an empty value.");
    }
    return value;
  }

  return new URL(input.url, input.artifactUrl).toString();
}

export async function readNovelPluginDetails(input: NovelPluginDetailsSmokeInput): Promise<NovelPluginDetailsSummary> {
  const loaded = loadNovelPluginBoundary(input);
  const parseNovel = loaded.plugin.parseNovel;

  if (typeof parseNovel !== "function") {
    throw new Error(`Plugin ${input.pluginId} does not expose a parseNovel details entrypoint.`);
  }

  let details: unknown;
  try {
    details = await parseNovel.call(loaded.plugin, input.novelPath);
  } catch (error) {
    throw new Error(
      `Plugin ${input.pluginId} parseNovel failed for ${input.novelPath}: ${normalizeRuntimeErrorMessage(error)}`,
    );
  }
  if (!details || typeof details !== "object") {
    throw new Error(`Plugin ${input.pluginId} returned an invalid novel details payload.`);
  }

  const detailRecord = details as Record<string, unknown>;
  const chapters = Array.isArray(detailRecord.chapters) ? detailRecord.chapters : [];
  const summary = normalizeText(detailRecord.summary);

  return {
    pluginId: loaded.summary.pluginId,
    name: normalizeText(detailRecord.name),
    novelPath: input.novelPath,
    chapterCount: chapters.length,
    firstChapterPath: chapters.length > 0 && chapters[0] && typeof chapters[0] === "object"
      ? normalizeText((chapters[0] as Record<string, unknown>).path)
      : null,
    hasSummary: Boolean(summary),
    author: normalizeText(detailRecord.author),
    cover: normalizeText(detailRecord.cover),
    summary,
    status: normalizeText(detailRecord.status),
    tags: normalizeTagList(detailRecord.genre ?? detailRecord.tags),
    chapters: normalizeChapterList(chapters),
  };
}

export async function readNovelPluginSearch(input: NovelPluginSearchSmokeInput): Promise<NovelPluginSearchSummary> {
  const loaded = loadNovelPluginBoundary(input);
  const searchNovels = loaded.plugin.searchNovels;

  if (typeof searchNovels !== "function") {
    throw new Error(`Plugin ${input.pluginId} does not expose a searchNovels entrypoint.`);
  }

  const pageNo = input.pageNo ?? 1;
  let results: unknown;
  try {
    results = await searchNovels.call(loaded.plugin, input.searchTerm, pageNo);
  } catch (error) {
    throw new Error(
      `Plugin ${input.pluginId} searchNovels failed for "${input.searchTerm}" page ${pageNo}: ${normalizeRuntimeErrorMessage(error)}`,
    );
  }

  const normalizedResults = normalizeResultList(results);
  return {
    pluginId: input.pluginId,
    searchTerm: input.searchTerm,
    pageNo,
    resultCount: normalizedResults.length,
    results: normalizedResults,
  };
}

export async function readNovelPluginPopular(input: NovelPluginPopularSmokeInput): Promise<NovelPluginPopularSummary> {
  const loaded = loadNovelPluginBoundary(input);
  const popularNovels = loaded.plugin.popularNovels;

  if (typeof popularNovels !== "function") {
    throw new Error(`Plugin ${input.pluginId} does not expose a popularNovels entrypoint.`);
  }

  const pageNo = input.pageNo ?? 1;
  const options = createPopularOptions(loaded.plugin, input.options);
  let results: unknown;
  try {
    results = await popularNovels.call(loaded.plugin, pageNo, options);
  } catch (error) {
    throw new Error(
      `Plugin ${input.pluginId} popularNovels failed for page ${pageNo}: ${normalizeRuntimeErrorMessage(error)}`,
    );
  }

  const normalizedResults = normalizeResultList(results);
  return {
    pluginId: input.pluginId,
    pageNo,
    resultCount: normalizedResults.length,
    results: normalizedResults,
  };
}

export async function readNovelPluginChapter(input: NovelPluginChapterSmokeInput): Promise<NovelPluginChapterSummary> {
  const loaded = loadNovelPluginBoundary(input);
  const parseChapter = loaded.plugin.parseChapter;

  if (typeof parseChapter !== "function") {
    throw new Error(`Plugin ${input.pluginId} does not expose a parseChapter entrypoint.`);
  }

  let content: unknown;
  try {
    content = await parseChapter.call(loaded.plugin, input.chapterPath);
  } catch (error) {
    throw new Error(
      `Plugin ${input.pluginId} parseChapter failed for ${input.chapterPath}: ${normalizeRuntimeErrorMessage(error)}`,
    );
  }

  const normalizedContent = typeof content === "string" ? content : "";
  return {
    pluginId: input.pluginId,
    chapterPath: input.chapterPath,
    contentLength: normalizedContent.length,
    hasContent: normalizedContent.length > 0,
    preview: normalizeText(normalizedContent.slice(0, 120)),
    content: normalizedContent,
  };
}
