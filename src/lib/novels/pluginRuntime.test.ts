import { describe, expect, it, vi } from "vitest";

interface MockFetchResponse {
  ok: boolean;
  status: number;
  statusText?: string;
  headers?: Headers;
  text?: () => Promise<string>;
  arrayBuffer?: () => Promise<ArrayBuffer>;
  json?: () => Promise<unknown>;
}

const { tauriFetchMock } = vi.hoisted(() => ({
  tauriFetchMock: vi.fn(async (url: string): Promise<MockFetchResponse> => {
    const encodeUtf8 = (html: string) => new TextEncoder().encode(html);
    const makeGarbledUtf8Text = (html: string) => new TextDecoder("latin1").decode(encodeUtf8(html));

    if (url.includes("/book/6644/list.html")) {
      const html = `
        <html>
          <body>
            <dl class="panel-chapterlist">
              <dd><a href="/book/6644/1.html">Chapter 1</a></dd>
              <dd><a href="/book/6644/2.html">Chapter 2</a></dd>
            </dl>
            <div class="listpage"></div>
          </body>
        </html>
      `;
      return {
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "text/html; charset=utf-8" }),
        text: async () => makeGarbledUtf8Text(html),
        arrayBuffer: async () => encodeUtf8(html).buffer,
        json: async () => ({ data: {} }),
      };
    }

    if (url.includes("/book/6644")) {
      const html = `
        <html>
          <body>
            <h1>\u6df1\u6d77\u4f59\u70ec</h1>
            <div class="cover"><img src="/covers/deep-sea-embers.webp" /></div>
            <div id="bookIntro">A fogbound apocalypse at sea.</div>
            <div class="caption-bookinfo">
              <p><a title="Yuan Tong"></a>\u8fde\u8f7d</p>
            </div>
            <dd class="all"><a href="/book/6644/list.html"></a></dd>
          </body>
        </html>
      `;
      return {
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "text/html; charset=utf-8" }),
        text: async () => makeGarbledUtf8Text(html),
        arrayBuffer: async () => encodeUtf8(html).buffer,
        json: async () => ({ data: {} }),
      };
    }

    return {
      ok: true,
      status: 200,
      text: async () => "",
      json: async () => {
        if (url.includes("/book/")) {
          return {
            data: {
              book: {
                name: "Shadow Slave",
                image: "/covers/shadow-slave.webp",
                authorize: {
                  description: "A test synopsis.",
                  name: "Guiltythree",
                },
                status: "updating",
              },
              tags: {
                tags_name: ["Fantasy", "Action"],
              },
              chapters: [
                { title: "Chapter 1", index: 1, slug: "chapter-1" },
                { title: "Chapter 2", index: 2, slug: "chapter-2" },
              ],
            },
          };
        }

        return {
          data: {},
        };
      },
    };
  }),
}));

vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: tauriFetchMock,
}));

import {
  loadNovelPluginBoundary,
  readNovelPluginChapter,
  readNovelPluginDetails,
  readNovelPluginFilters,
  readNovelPluginPopular,
  readNovelPluginSearch,
  readNovelPluginSettings,
  resolveNovelPluginRuntimeUrl,
} from "./pluginRuntime";

const SAMPLE_PLUGIN_SOURCE = `
Object.defineProperty(exports, "__esModule", { value: true });
const storage = require("@libs/storage");
const filterInputs = require("@libs/filterInputs");
class SamplePlugin {
  constructor() {
    this.id = "sample.plugin";
    this.name = "Sample Plugin";
    this.site = "https://example.com";
    this.filters = {
      genre: { type: filterInputs.FilterTypes.Picker, value: "fantasy" },
      mode: new filterInputs.TextInput({ label: "Mode", value: "full" })
    };
    this.pluginSettings = {
      hideLocked: { type: filterInputs.FilterTypes.Switch, value: storage.storage.get("hideLocked") ?? false }
    };
  }
  resolveUrl(path) {
    return new URL(path, this.site).toString();
  }
}
exports.default = new SamplePlugin();
`;

const ADVANCED_PLUGIN_SOURCE = `
Object.defineProperty(exports, "__esModule", { value: true });
const { storage, localStorage, sessionStorage } = require("@libs/storage");
const filterInputs = require("@libs/filterInputs");
const { utf8ToBytes, bytesToUtf8 } = require("@libs/utils");
const { gcm } = require("@libs/aes");
const { Parser } = require("htmlparser2");

storage.set("alpha", "one");
storage.set("beta", "two", Date.now() + 60000);

class AdvancedPlugin {
  constructor() {
    this.id = "advanced.plugin";
    this.name = "Advanced Plugin";
    this.site = "https://example.com";
    this.webStorageUtilized = true;
    this.filters = {
      query: new filterInputs.TextInput({ label: "Query", value: "shadow" }),
      genres: new filterInputs.CheckboxGroup({
        label: "Genres",
        options: [{ label: "Fantasy", value: "fantasy" }],
        value: ["fantasy"],
      }),
      tags: new filterInputs.ExcludableCheckboxGroup({
        label: "Tags",
        options: [{ label: "Slow Burn", value: "slow-burn" }],
        value: { include: ["slow-burn"], exclude: [] },
      }),
      mature: new filterInputs.Switch({ label: "Mature", value: true }),
    };
    this.pluginSettings = {
      remember: {
        type: filterInputs.FilterTypes.Switch,
        value: storage.get("remember") ?? false,
      },
    };
    const rawBeta = storage.get("beta", true);
    storage.delete("alpha");
    const keysAfterDelete = storage.getAllKeys();
    storage.clearAll();
    this.debug = {
      parserAvailable: typeof Parser === "function",
      gcmAvailable: typeof gcm === "function",
      utf8RoundTrip: bytesToUtf8(utf8ToBytes("Deep Sea")),
      localSummary: localStorage.get()?.summary ?? null,
      sessionChapter: sessionStorage.get()?.chapter ?? null,
      rawExpiresType: typeof rawBeta?.expires,
      keysAfterDelete,
    };
  }
  popularNovels(pageNo, options) {
    const genres = options && options.filters && options.filters.genres && options.filters.genres.value;
    if (!genres) throw new Error("filters missing");
    return [{
      name: "Popular Novel",
      path: "/popular/" + pageNo,
      cover: "https://example.com/popular.jpg",
      genres,
    }];
  }
  searchNovels(searchTerm, pageNo) {
    return [{ name: "Search " + searchTerm, path: "/search/" + pageNo, cover: null }];
  }
  parseNovel(novelPath) {
    return {
      path: novelPath,
      name: this.debug.utf8RoundTrip,
      summary: this.debug.localSummary,
      chapters: [{ name: "Chapter 1", path: "/chapter/1" }],
    };
  }
  parseChapter(chapterPath) {
    return this.debug.sessionChapter ?? "<p>" + chapterPath + "</p>";
  }
  parsePage(novelPath, page) {
    return [novelPath + ":" + page];
  }
}

exports.default = new AdvancedPlugin();
`;

describe("novel plugin runtime smoke loader", () => {
  it("loads a CommonJS LNReader-style plugin boundary and exposes settings and filters", () => {
    const loaded = loadNovelPluginBoundary({
      pluginId: "sample.plugin",
      artifactUrl: "https://example.com/plugin.js",
      pluginSource: SAMPLE_PLUGIN_SOURCE,
      settingsSeed: { hideLocked: true },
    });

    expect(loaded.summary).toMatchObject({
      pluginId: "sample.plugin",
      name: "Sample Plugin",
      hasFilters: true,
      hasPluginSettings: true,
      contractKind: "unknown",
      hasSearchNovels: false,
      hasParseNovel: false,
    });
    expect(loaded.storageSnapshot).toEqual({ hideLocked: true });
  });

  it("reads plugin settings and filters separately for the hidden host boundary", () => {
    const settings = readNovelPluginSettings({
      pluginId: "sample.plugin",
      artifactUrl: "https://example.com/plugin.js",
      pluginSource: SAMPLE_PLUGIN_SOURCE,
      settingsSeed: { hideLocked: true },
    });
    const filters = readNovelPluginFilters({
      pluginId: "sample.plugin",
      artifactUrl: "https://example.com/plugin.js",
      pluginSource: SAMPLE_PLUGIN_SOURCE,
    });

    expect(settings.pluginSettingKeys).toEqual(["hideLocked"]);
    expect(filters.filterKeys).toEqual(["genre", "mode"]);
  });

  it("resolves plugin URLs through resolveUrl when the plugin exposes it", async () => {
    const resolved = await resolveNovelPluginRuntimeUrl({
      pluginId: "sample.plugin",
      artifactUrl: "https://example.com/plugin.js",
      pluginSource: SAMPLE_PLUGIN_SOURCE,
      url: "/novel/123",
    });

    expect(resolved).toBe("https://example.com/novel/123");
  });

  it("fails loudly when plugin code cannot be evaluated", () => {
    expect(() => loadNovelPluginBoundary({
      pluginId: "broken.plugin",
      artifactUrl: "https://example.com/plugin.js",
      pluginSource: "module.exports =",
    })).toThrow(/broken\.plugin/);
  });

  it("exposes LNReader filter input enums and constructors used by real plugins", () => {
    const loaded = loadNovelPluginBoundary({
      pluginId: "sample.plugin",
      artifactUrl: "https://example.com/plugin.js",
      pluginSource: SAMPLE_PLUGIN_SOURCE,
    });

    expect(loaded.plugin.filters).toMatchObject({
      genre: { type: "Picker" },
      mode: { type: "Text", value: "full" },
    });
    expect(loaded.summary.filterKeys).toEqual(["genre", "mode"]);
  });

  it("aligns heavier upstream filter shapes, storage helpers, aes/utils, htmlparser2, and page plugin detection", () => {
    const loaded = loadNovelPluginBoundary({
      pluginId: "advanced.plugin",
      artifactUrl: "https://example.com/plugin.js",
      pluginSource: ADVANCED_PLUGIN_SOURCE,
      settingsSeed: { remember: true },
      webStorageSeed: {
        localStorage: { summary: "Stored summary" },
        sessionStorage: { chapter: "<p>cached</p>" },
      },
    });

    expect(loaded.summary).toMatchObject({
      contractKind: "page-plugin",
      hasPopularNovels: true,
      hasSearchNovels: true,
      hasParseNovel: true,
      hasParseChapter: true,
      hasParsePage: true,
      usesWebStorage: true,
    });
    expect(loaded.plugin.filters).toMatchObject({
      query: { type: "Text" },
      genres: { type: "Checkbox", value: ["fantasy"] },
      tags: { type: "XCheckbox", value: { include: ["slow-burn"], exclude: [] } },
      mature: { type: "Switch", value: true },
    });
    expect(loaded.storageSnapshot).toEqual({});
    expect(loaded.webStorageSnapshot).toEqual({
      localStorage: { summary: "Stored summary" },
      sessionStorage: { chapter: "<p>cached</p>" },
    });
    expect((loaded.plugin.debug as Record<string, unknown>)).toMatchObject({
      parserAvailable: true,
      gcmAvailable: true,
      utf8RoundTrip: "Deep Sea",
      localSummary: "Stored summary",
      sessionChapter: "<p>cached</p>",
      rawExpiresType: "number",
    });
    expect((loaded.plugin.debug as Record<string, unknown>).keysAfterDelete).toEqual(
      expect.arrayContaining(["remember", "beta"]),
    );
  });

  it("supports upstream-style search, popular, and chapter plugin entrypoints without widening claims", async () => {
    const search = await readNovelPluginSearch({
      pluginId: "advanced.plugin",
      artifactUrl: "https://example.com/plugin.js",
      pluginSource: ADVANCED_PLUGIN_SOURCE,
      searchTerm: "shadow",
      pageNo: 2,
    });
    const popular = await readNovelPluginPopular({
      pluginId: "advanced.plugin",
      artifactUrl: "https://example.com/plugin.js",
      pluginSource: ADVANCED_PLUGIN_SOURCE,
      pageNo: 3,
    });
    const chapter = await readNovelPluginChapter({
      pluginId: "advanced.plugin",
      artifactUrl: "https://example.com/plugin.js",
      pluginSource: ADVANCED_PLUGIN_SOURCE,
      webStorageSeed: {
        sessionStorage: { chapter: "<p>cached</p>" },
      },
      chapterPath: "/chapter/1",
    });

    expect(search).toMatchObject({
      pluginId: "advanced.plugin",
      searchTerm: "shadow",
      pageNo: 2,
      resultCount: 1,
      results: [{ name: "Search shadow", path: "/search/2" }],
    });
    expect(popular).toMatchObject({
      pluginId: "advanced.plugin",
      pageNo: 3,
      resultCount: 1,
      results: [{ name: "Popular Novel", path: "/popular/3" }],
    });
    expect(chapter).toMatchObject({
      pluginId: "advanced.plugin",
      chapterPath: "/chapter/1",
      hasContent: true,
      preview: "<p>cached</p>",
    });
  });

  it("runs a safe hotnovelpub-style details probe through parseNovel and the fetch shim", async () => {
    const details = await readNovelPluginDetails({
      pluginId: "hotnovelpub",
      artifactUrl: "https://example.com/hotnovelpub.js",
      pluginSource: `
Object.defineProperty(exports, "__esModule", { value: true });
const { fetchApi } = require("@libs/fetch");
const { NovelStatus } = require("@libs/novelStatus");
class HotNovelPubLikePlugin {
  constructor() {
    this.id = "hotnovelpub";
    this.name = "HotNovelPub";
    this.site = "https://hotnovelpub.com";
    this.apiSite = "https://api.hotnovelpub.com";
  }
  async parseNovel(path) {
    const response = await fetchApi(this.apiSite + "/book/" + path, {
      headers: { lang: "en" },
    }).then((result) => result.json());
    return {
      path,
      name: response.data.book.name,
      author: response.data.book.authorize.name,
      summary: response.data.book.authorize.description,
      cover: this.site + response.data.book.image,
      status: response.data.book.status === "updating" ? NovelStatus.Ongoing : NovelStatus.Completed,
      genre: response.data.tags,
      chapters: response.data.chapters.map((chapter, index) => ({
        name: chapter.title,
        path: chapter.slug,
        chapterNumber: (chapter.index || index) + 1,
      })),
    };
  }
}
exports.default = new HotNovelPubLikePlugin();
`,
      novelPath: "shadow-slave",
    });

    expect(details).toMatchObject({
      pluginId: "hotnovelpub",
      name: "Shadow Slave",
      novelPath: "shadow-slave",
      chapterCount: 2,
      firstChapterPath: "chapter-1",
      hasSummary: true,
      author: "Guiltythree",
      tags: ["Fantasy", "Action"],
    });
    expect(tauriFetchMock).toHaveBeenCalled();
  });

  it("normalizes LNReader detail genres from tags_name objects and fallback fields", async () => {
    const details = await readNovelPluginDetails({
      pluginId: "lnreader-style",
      artifactUrl: "https://example.com/lnreader-style.js",
      pluginSource: `
Object.defineProperty(exports, "__esModule", { value: true });
class LnReaderStylePlugin {
  constructor() {
    this.id = "lnreader-style";
    this.name = "LNReader Style";
    this.site = "https://example.com";
  }
  async parseNovel(path) {
    return {
      path,
      name: "Tagged Novel",
      genre: { tags_name: ["Fantasy", "Action"] },
      genres: ["Drama"],
      tags: [{ name: "Mystery" }, "Fantasy"],
      chapters: [{ name: "Chapter 1", path: "chapter-1" }],
    };
  }
}
exports.default = new LnReaderStylePlugin();
`,
      novelPath: "tagged-novel",
    });

    expect(details.tags).toEqual(["Fantasy", "Action", "Drama", "Mystery"]);
  });

  it("runs a 69shu-style details probe through fetchText and cheerio", async () => {
    const details = await readNovelPluginDetails({
      pluginId: "69shu",
      artifactUrl: "https://example.com/69shu.js",
      pluginSource: `
Object.defineProperty(exports, "__esModule", { value: true });
const cheerio = require("cheerio");
const fetch = require("@libs/fetch");
const { NovelStatus } = require("@libs/novelStatus");
class SixNineShuLikePlugin {
  constructor() {
    this.id = "69shu";
    this.name = "69\\u4e66\\u5427";
    this.site = "https://www.69shu.xyz";
  }
  async parseNovel(path) {
    const html = await fetch.fetchText(this.site + path);
    const $ = cheerio.load(html);
    const novel = {
      path,
      name: $("h1").text().trim(),
      cover: $("div.cover > img").attr("src"),
      summary: $("#bookIntro").text().trim(),
      author: $("div.caption-bookinfo > p").find("a").attr("title"),
      status: $("div.caption-bookinfo > p").text().includes("\\u8fde\\u8f7d") ? NovelStatus.Ongoing : NovelStatus.Completed,
      chapters: [],
    };
    const chapterListUrl = $("dd.all > a").attr("href");
    const chapterHtml = await fetch.fetchText(new URL(chapterListUrl, this.site).toString());
    const chapterPage = cheerio.load(chapterHtml);
    chapterPage("dl.panel-chapterlist dd").each((index, element) => {
      const link = chapterPage(element).find("a");
      novel.chapters.push({
        name: link.text().trim(),
        path: link.attr("href"),
      });
    });
    return novel;
  }
}
exports.default = new SixNineShuLikePlugin();
`,
      novelPath: "/book/6644",
    });

    expect(details).toMatchObject({
      pluginId: "69shu",
      name: "\u6df1\u6d77\u4f59\u70ec",
      novelPath: "/book/6644",
      chapterCount: 2,
      firstChapterPath: "/book/6644/1.html",
      hasSummary: true,
      author: "Yuan Tong",
    });
  });

  it("normalizes fetchApi().text() decoding for utf-8 pt-BR sources like illusia", async () => {
    tauriFetchMock.mockImplementationOnce(async () => {
      const html = `
        <html>
          <head><meta charset="UTF-8" /></head>
          <body>
            <h1>\u00caxodo</h1>
            <section id="chapter-content">
              <div>O homem mais confi\u00e1vel da Lua</div>
            </section>
          </body>
        </html>
      `;
      const bytes = new TextEncoder().encode(html);
      const garbledText = new TextDecoder("latin1").decode(bytes);
      return {
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "text/html; charset=UTF-8" }),
        text: async () => garbledText,
        arrayBuffer: async () => bytes.buffer,
        json: async () => ({ invalid: true }),
      };
    });

    const details = await readNovelPluginDetails({
      pluginId: "illusia",
      artifactUrl: "https://example.com/illusia.js",
      pluginSource: `
Object.defineProperty(exports, "__esModule", { value: true });
const { fetchApi } = require("@libs/fetch");
const cheerio = require("cheerio");
class IllusiaLikePlugin {
  constructor() {
    this.id = "illusia";
    this.name = "Illusia";
    this.site = "https://illusia.com.br";
  }
  async parseNovel(path) {
    const html = await fetchApi(this.site + "/" + path + "/", {}).then((result) => result.text());
    const $ = cheerio.load(html);
    return {
      path,
      name: $("h1").text().trim(),
      chapters: [{ name: $("#chapter-content").text().trim(), path: "chapter-1" }],
    };
  }
}
exports.default = new IllusiaLikePlugin();
`,
      novelPath: "story/exodo",
    });

    expect(details.name).toBe("\u00caxodo");
    expect(details.chapters[0]?.title).toBe("O homem mais confi\u00e1vel da Lua");
  });

  it("recovers an LNReader default cover from standard page metadata", async () => {
    const html = `
      <html>
        <head><meta property="og:image" content="/covers/recovered.webp" /></head>
      </html>
    `;
    const bytes = new TextEncoder().encode(html);
    tauriFetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "text/html; charset=UTF-8" }),
      text: async () => html,
      arrayBuffer: async () => bytes.buffer,
      json: async () => ({}),
    });

    const details = await readNovelPluginDetails({
      pluginId: "default-cover",
      artifactUrl: "https://example.com/default-cover.js",
      pluginSource: `
Object.defineProperty(exports, "__esModule", { value: true });
class DefaultCoverPlugin {
  constructor() {
    this.id = "default-cover";
    this.name = "Default Cover";
    this.site = "https://novels.example/";
  }
  async parseNovel(path) {
    return { path, name: "Recovered", cover: "about:blank", chapters: [] };
  }
}
exports.default = new DefaultCoverPlugin();
`,
      novelPath: "story/recovered",
    });

    expect(details.cover).toBe("https://novels.example/covers/recovered.webp");
  });

  it("uses FlareSolverr for LNReader source challenge responses when enabled", async () => {
    tauriFetchMock.mockReset();
    vi.stubGlobal("localStorage", {
      getItem: vi.fn(() => JSON.stringify({
        settings: {
          flareSolverrEnabled: true,
          flareSolverrUrl: "http://localhost:8191",
          flareSolverrTimeout: 60,
          flareSolverrSessionName: "epigraph",
          flareSolverrSessionTtl: 15,
        },
      })),
    });

    tauriFetchMock
      .mockResolvedValueOnce({
        ok: false,
        status: 403,
        statusText: "Forbidden",
        headers: new Headers({ server: "cloudflare", "content-type": "text/html; charset=utf-8" }),
        text: async () => "<html><title>Just a moment...</title><body>Cloudflare challenge</body></html>",
        arrayBuffer: async () => new TextEncoder().encode("<html>Cloudflare challenge</html>").buffer,
        json: async () => ({}),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => ({
          status: "ok",
          solution: {
            status: 200,
            response: JSON.stringify({
              data: {
                book: {
                  name: "Recovered Novel",
                  image: "/covers/recovered.webp",
                  authorize: { description: "Recovered.", name: "Author" },
                  status: "updating",
                },
                tags: { tags_name: [] },
                chapters: [{ title: "Chapter 1", index: 1, slug: "chapter-1" }],
              },
            }),
            headers: { "content-type": "application/json" },
          },
        }),
        text: async () => "",
      });

    const details = await readNovelPluginDetails({
      pluginId: "hotnovelpub",
      artifactUrl: "https://example.com/hotnovelpub.js",
      pluginSource: `
Object.defineProperty(exports, "__esModule", { value: true });
const { fetchApi } = require("@libs/fetch");
class HotNovelPubLikePlugin {
  constructor() {
    this.id = "hotnovelpub";
    this.name = "HotNovelPub";
    this.apiSite = "https://api.hotnovelpub.com";
  }
  async parseNovel(path) {
    const response = await fetchApi(this.apiSite + "/book/" + path).then((result) => result.json());
    return {
      path,
      name: response.data.book.name,
      author: response.data.book.authorize.name,
      summary: response.data.book.authorize.description,
      chapters: response.data.chapters.map((chapter) => ({ name: chapter.title, path: chapter.slug })),
    };
  }
}
exports.default = new HotNovelPubLikePlugin();
`,
      novelPath: "shadow-slave",
    });

    expect(details.name).toBe("Recovered Novel");
    expect(tauriFetchMock).toHaveBeenCalledWith("http://localhost:8191/v1", expect.objectContaining({
      method: "POST",
    }));
  });
});
