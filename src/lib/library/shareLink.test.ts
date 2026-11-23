import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import {
  buildShareManifest,
  buildShareWebUrl,
  chooseShareLinkToken,
  decodeShareManifest,
  embedShareTokenInPng,
  encodeShareManifest,
  extractShareTokenFromPng,
  hostedUrlToShareToken,
  INLINE_TOKEN_PREFERRED_MAX,
  parseIncomingImportLink,
  sanitizePublicRepoUrl,
  shareTokenToHostedUrl,
} from "./shareLink";

// Minimal valid 1x1 PNG.
const SAMPLE_PNG = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="),
  (c) => c.charCodeAt(0),
);

describe("shareLink manifest codec", () => {
  test("round-trips deduplicated sources, repo URLs, remote works, and local works", () => {
    const manifest = buildShareManifest([
      {
        title: "Solo Leveling",
        sourceId: "2499283573021220255",
        url: "/manga/solo-leveling",
        sourceName: "MangaDex",
        sourceLang: "en",
        extensionPkgName: "eu.kanade.tachiyomi.extension.all.mangadex",
        repoUrl: "https://raw.githubusercontent.com/keiyoushi/extensions/repo/index.min.json",
        webUrl: "https://mangadex.org/title/solo-leveling",
        coverUrl: "https://mangadex.org/covers/solo-leveling.jpg",
      },
      {
        title: "Frieren",
        sourceId: "2499283573021220255",
        url: "/manga/frieren",
        sourceName: "MangaDex",
        sourceLang: "en",
        extensionPkgName: "eu.kanade.tachiyomi.extension.all.mangadex",
        repoUrl: "https://raw.githubusercontent.com/keiyoushi/extensions/repo/index.min.json",
        webUrl: "https://mangadex.org/title/solo-leveling",
        coverUrl: "https://mangadex.org/covers/solo-leveling.jpg",
      },
      {
        title: "Local Comic",
        sourceId: "0",
        url: "/local/comic",
      },
    ]);

    expect(manifest.sources).toHaveLength(1);
    const token = encodeShareManifest(manifest);
    expect(token.startsWith("d.")).toBe(true);

    const decoded = decodeShareManifest(token);
    expect(decoded).toEqual(manifest);
  });

  test("rejects private or non-HTTPS repo URLs", () => {
    expect(sanitizePublicRepoUrl("https://raw.githubusercontent.com/keiyoushi/extensions/repo/index.min.json")).toBe(
      "https://raw.githubusercontent.com/keiyoushi/extensions/repo/index.min.json",
    );
    expect(sanitizePublicRepoUrl("http://example.com/index.min.json")).toBeNull();
    expect(sanitizePublicRepoUrl("https://127.0.0.1/index.min.json")).toBeNull();
    expect(sanitizePublicRepoUrl("https://192.168.0.5/index.min.json")).toBeNull();
    expect(sanitizePublicRepoUrl("https://localhost/index.min.json")).toBeNull();
  });

  test("embeds and extracts share token inside a PNG tEXt chunk without corrupting PNG framing", () => {
    const manifest = buildShareManifest([
      { title: "One Piece", sourceId: "12345", url: "/manga/one-piece", sourceName: "TestSource" },
    ]);
    const token = encodeShareManifest(manifest);
    const embedded = embedShareTokenInPng(SAMPLE_PNG, token);

    expect(embedded.length).toBeGreaterThan(SAMPLE_PNG.length);
    // Ends with the exact original IEND chunk (12 bytes).
    expect(embedded.subarray(embedded.length - 12)).toEqual(SAMPLE_PNG.subarray(SAMPLE_PNG.length - 12));
    expect(extractShareTokenFromPng(embedded)).toBe(token);
    expect(extractShareTokenFromPng(SAMPLE_PNG)).toBeNull();
  });

  test("keeps large folders in the hosted PNG while rejecting oversized direct links", () => {
    const manifest = buildShareManifest(Array.from({ length: 500 }, (_, index) => {
      const id = createHash("sha256").update(String(index)).digest("hex");
      return { title: `Work ${index}`, sourceId: "12345", sourceName: "Source", url: `/manga/${id}` };
    }));
    const token = encodeShareManifest(manifest);
    expect(token.length).toBeGreaterThan(16384);
    expect(parseIncomingImportLink(`epigraph://import?p=${token}`)).toBeNull();

    const embedded = embedShareTokenInPng(SAMPLE_PNG, token);
    const extracted = extractShareTokenFromPng(embedded);
    expect(extracted).toBe(token);
    expect(decodeShareManifest(extracted!)).toEqual(manifest);
    expect(chooseShareLinkToken(token, "https://iili.io/sample.png")).toBe("i.sample");
  });

  test("converts allowlisted hosted card URLs to compact pointer tokens and back", () => {
    expect(hostedUrlToShareToken("https://iili.io/oKis7El.png")).toBe("i.oKis7El");
    expect(hostedUrlToShareToken("https://kappa.lol/lfAoW8.png")).toBe("k.lfAoW8");
    expect(hostedUrlToShareToken("https://pomf2.lain.la/f/n6bzrnex.png")).toBe("p.n6bzrnex");
    expect(hostedUrlToShareToken("https://x0.at/dFhZ.png")).toBe("a.dFhZ");
    expect(hostedUrlToShareToken("https://litter.catbox.moe/abc123.png")).toBe("l.abc123");
    expect(hostedUrlToShareToken("https://files.catbox.moe/xyz9.png")).toBe("c.xyz9");
    expect(hostedUrlToShareToken("https://d.uguu.se/XArdEvq.png")).toBe("u.d.XArdEvq");
    expect(hostedUrlToShareToken("https://evil.example.com/abc.png")).toBeNull();

    expect(shareTokenToHostedUrl("i.oKis7El")).toEqual({ host: "freeimage", url: "https://iili.io/oKis7El.png" });
    expect(shareTokenToHostedUrl("k.lfAoW8")).toEqual({ host: "kappa", url: "https://kappa.lol/lfAoW8.png" });
    expect(shareTokenToHostedUrl("p.n6bzrnex")).toEqual({ host: "pomf2", url: "https://pomf2.lain.la/f/n6bzrnex.png" });
    expect(shareTokenToHostedUrl("a.dFhZ")).toEqual({ host: "x0at", url: "https://x0.at/dFhZ.png" });
    expect(shareTokenToHostedUrl("l.abc123")).toEqual({ host: "litterbox", url: "https://litter.catbox.moe/abc123.png" });
    expect(shareTokenToHostedUrl("c.xyz9")).toEqual({ host: "catbox", url: "https://files.catbox.moe/xyz9.png" });
    expect(shareTokenToHostedUrl("u.d.XArdEvq")).toEqual({ host: "uguu", url: "https://d.uguu.se/XArdEvq.png" });
    expect(shareTokenToHostedUrl("x.bad")).toBeNull();
  });

  test("parses GitHub Pages URLs, epigraph:// deep links, and rejects foreign URLs", () => {
    const manifest = buildShareManifest([
      { title: "Berserk", sourceId: "99", url: "/manga/berserk", sourceName: "Source" },
    ]);
    const inlineToken = encodeShareManifest(manifest);

    expect(parseIncomingImportLink(buildShareWebUrl(inlineToken))).toEqual({ kind: "inline", token: inlineToken });
    expect(parseIncomingImportLink(buildShareWebUrl(inlineToken, "https://iili.io/oKis7El.png"))).toEqual({
      kind: "inline",
      token: inlineToken,
    });
    expect(parseIncomingImportLink(`epigraph://import?p=${inlineToken}`)).toEqual({ kind: "inline", token: inlineToken });
    expect(parseIncomingImportLink("epigraph://import?p=l.abc123")).toEqual({
      kind: "hosted",
      token: "l.abc123",
      host: "litterbox",
      url: "https://litter.catbox.moe/abc123.png",
    });
    expect(parseIncomingImportLink("https://evil.example.com/share/#l.abc123")).toBeNull();
    expect(parseIncomingImportLink("epigraph://pair?b=something")).toBeNull();
  });

  test("round-trips work kind ('comic' | 'book') and omits wire slot when unset", () => {
    const manifest = buildShareManifest([
      {
        title: "+99 Reinforced Wooden Stick",
        sourceId: "2499283573021220255",
        url: "/manga/99-reinforced-wooden-stick",
        sourceName: "Mangakakalot",
        kind: "comic",
      },
      {
        title: "Lord of the Mysteries",
        sourceId: "777",
        url: "/novel/lotm",
        sourceName: "NovelSource",
        kind: "book",
      },
      {
        title: "Mistborn",
        sourceId: "0",
        url: "",
        kind: "book",
      },
      {
        title: "Legacy Work",
        sourceId: "2499283573021220255",
        url: "/manga/legacy",
        sourceName: "Mangakakalot",
      },
    ]);

    expect(manifest.works.map((work) => work.kind)).toEqual(["comic", "book", "book", undefined]);
    const token = encodeShareManifest(manifest);
    const decoded = decodeShareManifest(token);
    expect(decoded).toEqual(manifest);
  });

  test("prefers inline for small lists and hosted pointer for large lists", () => {
    const small = "d." + "a".repeat(200);
    const large = "d." + "a".repeat(INLINE_TOKEN_PREFERRED_MAX + 50);

    expect(chooseShareLinkToken(small, "https://litter.catbox.moe/abc.png")).toBe(small);
    expect(chooseShareLinkToken(large, "https://litter.catbox.moe/abc.png")).toBe("l.abc");
    expect(chooseShareLinkToken(large, null)).toBe(large);
  });
});
