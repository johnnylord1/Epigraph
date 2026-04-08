import { BookAssetResolver } from "./assets";
import type { BookEntry, BookSubtype } from "./types";

export type BookRuntimeFailureClassification =
  | "CORS rejection"
  | "wrong MIME/content type"
  | "missing/incorrect range behavior"
  | "bad book.localhost resolution"
  | "later parser/runtime failure after fetch succeeds";

export type BookRuntimeRequestKind = "HEAD" | "RANGE";

export type BookRuntimeStage =
  | "idle"
  | "source.resolved"
  | "fetch.started"
  | "fetch.succeeded"
  | "fetch.failed"
  | "epub.open.started"
  | "epub.ready"
  | "epub.locations.started"
  | "epub.locations.ready"
  | "epub.displayed"
  | "pdf.open.started"
  | "pdf.ready"
  | "pdf.page.rendered";

export interface BookRuntimeSource {
  bookId: string;
  title: string;
  subtype: BookSubtype;
  sourceUrl: string;
  origin: string | null;
}

export interface BookRuntimeRequestEvidence {
  requestKind: BookRuntimeRequestKind;
  ok: boolean;
  status: number | null;
  finalUrl: string;
  headers: Record<string, string>;
  error: string | null;
}

export interface BookRuntimeProbeEvidence {
  origin: string | null;
  sourceUrl: string;
  subtype: BookSubtype;
  expectedMimeType: string;
  head: BookRuntimeRequestEvidence | null;
  range: BookRuntimeRequestEvidence | null;
  classification: BookRuntimeFailureClassification | null;
}

export type BookRuntimeProbeEvent = {
  phase: "started" | "succeeded" | "failed";
  requestKind: BookRuntimeRequestKind;
  payload: BookRuntimeRequestEvidence;
};

type ProbeOptions = {
  expectRange?: boolean;
  onEvent?: (event: BookRuntimeProbeEvent) => void;
};

const EXPECTED_MIME_BY_SUBTYPE: Record<BookSubtype, string> = {
  epub: "application/epub+zip",
  pdf: "application/pdf",
};

function currentWindowOrigin(): string | null {
  if (typeof window === "undefined" || !window.location?.origin) return null;
  return window.location.origin;
}

function headersToObject(headers: Headers): Record<string, string> {
  const entries: Record<string, string> = {};
  headers.forEach((value, key) => {
    entries[key.toLowerCase()] = value;
  });
  return entries;
}

function classifyFetchError(
  source: BookRuntimeSource,
  request: BookRuntimeRequestEvidence,
): BookRuntimeFailureClassification {
  const message = (request.error ?? "").toLowerCase();
  if (
    message.includes("cors")
    || message.includes("cross-origin")
    || message.includes("cross origin")
    || message.includes("access-control-allow-origin")
  ) {
    return "CORS rejection";
  }

  const sourceHost = safeHostname(source.sourceUrl);
  const originHost = safeHostname(source.origin);
  if (sourceHost === "book.localhost" && originHost && originHost !== sourceHost) {
    return "CORS rejection";
  }

  return "bad book.localhost resolution";
}

function safeHostname(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).hostname || null;
  } catch {
    return null;
  }
}

function classifyMimeMismatch(
  subtype: BookSubtype,
  request: BookRuntimeRequestEvidence,
): BookRuntimeFailureClassification | null {
  if (!request.ok) return null;
  const contentType = request.headers["content-type"]?.toLowerCase() ?? "";
  const expectedMime = EXPECTED_MIME_BY_SUBTYPE[subtype];
  if (!contentType || contentType.includes(expectedMime)) {
    return null;
  }
  return "wrong MIME/content type";
}

function classifyRangeFailure(request: BookRuntimeRequestEvidence): BookRuntimeFailureClassification | null {
  if (request.error) return "missing/incorrect range behavior";
  if (!request.ok || request.status !== 206) {
    return "missing/incorrect range behavior";
  }
  const acceptRanges = request.headers["accept-ranges"]?.toLowerCase() ?? "";
  const contentRange = request.headers["content-range"]?.toLowerCase() ?? "";
  if (!acceptRanges.includes("bytes") || !contentRange.startsWith("bytes ")) {
    return "missing/incorrect range behavior";
  }
  return null;
}

async function captureRequestEvidence(
  sourceUrl: string,
  requestKind: BookRuntimeRequestKind,
): Promise<BookRuntimeRequestEvidence> {
  const init: RequestInit = requestKind === "HEAD"
    ? { method: "HEAD" }
    : {
        method: "GET",
        headers: {
          Range: "bytes=0-0",
        },
      };

  try {
    const response = await fetch(sourceUrl, init);
    return {
      requestKind,
      ok: response.ok,
      status: response.status,
      finalUrl: response.url || sourceUrl,
      headers: headersToObject(response.headers),
      error: null,
    };
  } catch (error) {
    return {
      requestKind,
      ok: false,
      status: null,
      finalUrl: sourceUrl,
      headers: {},
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function resolveBookRuntimeSource(
  book: Pick<BookEntry, "id" | "title" | "subtype" | "assetPath" | "updatedAt">,
): BookRuntimeSource {
  return {
    bookId: book.id,
    title: book.title,
    subtype: book.subtype,
    sourceUrl: book.subtype === "epub"
      ? BookAssetResolver.resolveEpubSourceUrl(book)
      : BookAssetResolver.resolvePdfSourceUrl(book),
    origin: currentWindowOrigin(),
  };
}

export async function probeBookRuntimeSource(
  source: BookRuntimeSource,
  options: ProbeOptions = {},
): Promise<BookRuntimeProbeEvidence> {
  const expectRange = options.expectRange ?? source.subtype === "pdf";

  const headStarted: BookRuntimeRequestEvidence = {
    requestKind: "HEAD",
    ok: false,
    status: null,
    finalUrl: source.sourceUrl,
    headers: {},
    error: null,
  };
  options.onEvent?.({ phase: "started", requestKind: "HEAD", payload: headStarted });
  const head = await captureRequestEvidence(source.sourceUrl, "HEAD");
  options.onEvent?.({
    phase: head.error || !head.ok ? "failed" : "succeeded",
    requestKind: "HEAD",
    payload: head,
  });

  let classification: BookRuntimeFailureClassification | null = null;
  if (head.error) {
    classification = classifyFetchError(source, head);
  } else {
    classification = classifyMimeMismatch(source.subtype, head);
  }

  let range: BookRuntimeRequestEvidence | null = null;
  if (!classification && expectRange) {
    const rangeStarted: BookRuntimeRequestEvidence = {
      requestKind: "RANGE",
      ok: false,
      status: null,
      finalUrl: source.sourceUrl,
      headers: {},
      error: null,
    };
    options.onEvent?.({ phase: "started", requestKind: "RANGE", payload: rangeStarted });
    range = await captureRequestEvidence(source.sourceUrl, "RANGE");
    options.onEvent?.({
      phase: range.error || !range.ok ? "failed" : "succeeded",
      requestKind: "RANGE",
      payload: range,
    });
    classification = classifyRangeFailure(range);
  }

  return {
    origin: source.origin,
    sourceUrl: source.sourceUrl,
    subtype: source.subtype,
    expectedMimeType: EXPECTED_MIME_BY_SUBTYPE[source.subtype],
    head,
    range,
    classification,
  };
}

export function classifyBookRuntimeFailure(
  probe: BookRuntimeProbeEvidence | null,
  stage: BookRuntimeStage,
  error: unknown,
): BookRuntimeFailureClassification | null {
  if (probe?.classification) {
    return probe.classification;
  }

  if (stage === "fetch.failed") {
    const message = error instanceof Error ? error.message.toLowerCase() : String(error ?? "").toLowerCase();
    if (message.includes("cors") || message.includes("cross-origin") || message.includes("access-control-allow-origin")) {
      return "CORS rejection";
    }
    return "bad book.localhost resolution";
  }

  if (probe?.head?.ok) {
    return "later parser/runtime failure after fetch succeeds";
  }

  return null;
}
