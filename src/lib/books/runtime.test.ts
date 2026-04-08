import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockedResolveEpubSourceUrl, mockedResolvePdfSourceUrl } = vi.hoisted(() => ({
  mockedResolveEpubSourceUrl: vi.fn(() => "http://book.localhost/C%3A%5Cbooks%5Cdemo.epub?v=1"),
  mockedResolvePdfSourceUrl: vi.fn(() => "http://book.localhost/C%3A%5Cbooks%5Cdemo.pdf?v=1"),
}));

vi.mock("./assets", () => ({
  BookAssetResolver: {
    resolveEpubSourceUrl: mockedResolveEpubSourceUrl,
    resolvePdfSourceUrl: mockedResolvePdfSourceUrl,
  },
}));

import {
  classifyBookRuntimeFailure,
  probeBookRuntimeSource,
  resolveBookRuntimeSource,
} from "./runtime";

const fetchMock = vi.fn<typeof fetch>();

describe("resolveBookRuntimeSource", () => {
  it("returns the shared URL-first runtime source for EPUB", () => {
    vi.stubGlobal("window", {
      location: { origin: "http://tauri.localhost" },
    });

    const source = resolveBookRuntimeSource({
      id: "book-1",
      title: "Demo EPUB",
      subtype: "epub",
      assetPath: "C:\\books\\demo.epub",
      updatedAt: 1,
    });

    expect(source).toEqual({
      bookId: "book-1",
      title: "Demo EPUB",
      subtype: "epub",
      sourceUrl: "http://book.localhost/C%3A%5Cbooks%5Cdemo.epub?v=1",
      origin: "http://tauri.localhost",
    });
  });
});

describe("probeBookRuntimeSource", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  it("captures HEAD evidence for EPUB and leaves classification empty after fetch success", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(null, {
        status: 200,
        headers: {
          "Content-Type": "application/epub+zip",
          "Content-Length": "128",
        },
      }),
    );

    const source = resolveBookRuntimeSource({
      id: "book-1",
      title: "Demo EPUB",
      subtype: "epub",
      assetPath: "C:\\books\\demo.epub",
      updatedAt: 1,
    });
    const events: string[] = [];
    const result = await probeBookRuntimeSource(source, {
      expectRange: false,
      onEvent: ({ phase, requestKind }) => events.push(`${requestKind}:${phase}`),
    });

    expect(events).toEqual(["HEAD:started", "HEAD:succeeded"]);
    expect(result.classification).toBeNull();
    expect(result.head?.status).toBe(200);
    expect(result.head?.headers["content-type"]).toBe("application/epub+zip");
    expect(result.range).toBeNull();
  });

  it("classifies successful HEAD plus broken RANGE as range behavior failure for PDFs", async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(null, {
          status: 200,
          headers: {
            "Content-Type": "application/pdf",
            "Accept-Ranges": "bytes",
            "Content-Length": "2048",
          },
        }),
      )
      .mockResolvedValueOnce(
        new Response("not partial", {
          status: 200,
          headers: {
            "Content-Type": "application/pdf",
            "Accept-Ranges": "bytes",
            "Content-Length": "10",
          },
        }),
      );

    const source = resolveBookRuntimeSource({
      id: "book-2",
      title: "Demo PDF",
      subtype: "pdf",
      assetPath: "C:\\books\\demo.pdf",
      updatedAt: 1,
    });
    const result = await probeBookRuntimeSource(source, { expectRange: true });

    expect(result.classification).toBe("missing/incorrect range behavior");
    expect(result.head?.status).toBe(200);
    expect(result.range?.status).toBe(200);
  });

  it("classifies cross-origin fetch rejection as CORS rejection when book.localhost differs from app origin", async () => {
    vi.stubGlobal("window", {
      location: { origin: "http://tauri.localhost" },
    });
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));

    const source = resolveBookRuntimeSource({
      id: "book-1",
      title: "Demo EPUB",
      subtype: "epub",
      assetPath: "C:\\books\\demo.epub",
      updatedAt: 1,
    });
    const result = await probeBookRuntimeSource(source, { expectRange: false });

    expect(result.classification).toBe("CORS rejection");
    expect(result.head?.error).toContain("Failed to fetch");
  });
});

describe("classifyBookRuntimeFailure", () => {
  it("marks later parser/runtime failures after fetch success", () => {
    expect(
      classifyBookRuntimeFailure(
        {
          origin: "http://tauri.localhost",
          sourceUrl: "http://book.localhost/demo.epub",
          subtype: "epub",
          expectedMimeType: "application/epub+zip",
          head: {
            requestKind: "HEAD",
            ok: true,
            status: 200,
            finalUrl: "http://book.localhost/demo.epub",
            headers: { "content-type": "application/epub+zip" },
            error: null,
          },
          range: null,
          classification: null,
        },
        "epub.ready",
        new Error("EPUB parser exploded"),
      ),
    ).toBe("later parser/runtime failure after fetch succeeds");
  });
});
