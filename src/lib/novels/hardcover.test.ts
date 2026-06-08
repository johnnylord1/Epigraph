import { describe, expect, it } from "vitest";

import {
  hardcoverRecordToRecommendationCandidate,
  matchHardcoverBook,
  normalizeHardcoverBook,
} from "./hardcover";
import {
  buildSearchRecommendations,
  recommendationTitleKey,
  recommendationTrackerRemoteKey,
} from "../recommendations";

describe("Hardcover novel tracking helpers", () => {
  it("normalizes Hardcover book search results", () => {
    const book = normalizeHardcoverBook({
      id: 123,
      title: "Lord of the Mysteries",
      slug: "lord-of-the-mysteries",
      cached_image: "https://img.example/lotm.jpg",
      description: "<p>Victorian mystery fantasy.</p>",
      release_year: 2018,
      rating: "4.37",
      ratings_count: 1200,
      contributions: [{ author: { name: "Cuttlefish" } }],
    });

    expect(book).toMatchObject({
      id: 123,
      title: "Lord of the Mysteries",
      rating: 4.37,
      ratingsCount: 1200,
      authors: ["Cuttlefish"],
      description: "Victorian mystery fantasy.",
      releaseYear: 2018,
      url: "https://hardcover.app/books/lord-of-the-mysteries",
    });
  });

  it("normalizes nested Hardcover cover objects", () => {
    const book = normalizeHardcoverBook({
      id: 124,
      title: "Book With Image Object",
      cached_image: { url: "//assets.hardcover.app/covers/book.jpg" },
    });

    expect(book?.coverUrl).toBe("https://assets.hardcover.app/covers/book.jpg");
  });

  it("normalizes scalar Hardcover cover URL fields", () => {
    const book = normalizeHardcoverBook({
      id: 125,
      title: "Book With Cover Url",
      cached_image_url: "https://assets.hardcover.app/covers/scalar.jpg",
    });

    expect(book?.coverUrl).toBe("https://assets.hardcover.app/covers/scalar.jpg");
  });

  it("normalizes JSON-encoded Hardcover image fields", () => {
    const book = normalizeHardcoverBook({
      id: 126,
      title: "Book With Json Image",
      cached_image: JSON.stringify({ large: "https://assets.hardcover.app/covers/json.jpg" }),
    });

    expect(book?.coverUrl).toBe("https://assets.hardcover.app/covers/json.jpg");
  });

  it("falls back to Open Library covers when Hardcover only returns ISBNs", () => {
    const book = normalizeHardcoverBook({
      id: 127,
      title: "Book With Isbn",
      isbns: ["978-1-23456-789-7"],
    });

    expect(book?.coverUrl).toBe("https://covers.openlibrary.org/b/isbn/9781234567897-L.jpg?default=false");
  });

  it("normalizes Hardcover default cover edition images", () => {
    const book = normalizeHardcoverBook({
      id: 128,
      title: "Book With Default Cover Edition",
      default_cover_edition: {
        image: { url: "https://assets.hardcover.app/covers/default-edition.jpg" },
      },
    });

    expect(book?.coverUrl).toBe("https://assets.hardcover.app/covers/default-edition.jpg");
  });

  it("rejects weak title matches", () => {
    const match = matchHardcoverBook("Lord of the Mysteries", [
      {
        id: 9,
        title: "A Court of Thorns and Roses",
        authors: [],
        coverUrl: null,
        description: null,
        releaseYear: null,
        rating: 4.1,
        ratingsCount: 10,
        slug: "acotar",
        url: "https://hardcover.app/books/acotar",
      },
    ]);

    expect(match).toBeNull();
  });

  it("matches strong title overlap", () => {
    const match = matchHardcoverBook("Lord of Mysteries", [
      {
        id: 1,
        title: "Lord of the Mysteries",
        authors: [],
        coverUrl: null,
        description: null,
        releaseYear: null,
        rating: 4.5,
        ratingsCount: 10,
        slug: "lord-of-the-mysteries",
        url: "https://hardcover.app/books/lord-of-the-mysteries",
      },
    ]);

    expect(match?.id).toBe(1);
  });

  it("converts Hardcover records into tracker-backed recommendation candidates", () => {
    const candidate = hardcoverRecordToRecommendationCandidate({
      bookId: 7,
      title: "The Wandering Inn",
      authors: ["Pirateaba"],
      coverUrl: "https://img.example/twi.jpg",
      status: "Currently Reading",
      rating: 4.6,
      progress: 25,
      remoteUrl: "https://hardcover.app/books/the-wandering-inn",
      updatedAt: 1000,
      sourceNovelId: "novel:source:path",
      sourceTitleKey: "novel:the wandering inn",
    });

    expect(candidate.providers[0]).toMatchObject({
      providerId: "hardcover",
      providerName: "Hardcover",
      kind: "tracker",
      iconKey: "HC",
    });
    expect(candidate.providers[0]?.score?.value).toBeCloseTo(0.92);
  });

  it("treats linked Hardcover titles as known recommendations by default", () => {
    const known = hardcoverRecordToRecommendationCandidate({
      bookId: 7,
      title: "The Wandering Inn",
      authors: ["Pirateaba"],
      coverUrl: "https://img.example/twi.jpg",
      status: "Currently Reading",
      rating: 4.6,
      progress: 25,
      remoteUrl: "https://hardcover.app/books/the-wandering-inn",
      updatedAt: Date.parse("2026-04-01T00:00:00.000Z"),
      sourceNovelId: "novel:source:path",
      sourceTitleKey: recommendationTitleKey("The Wandering Inn", "novel"),
    });
    const fresh = {
      ...known,
      id: "novel-source:ln:new",
      title: "New Fantasy Serial",
      inLibrary: false,
      providers: [{
        providerId: "lnreader",
        providerName: "LNReader",
        kind: "source" as const,
        availability: { value: 0.9, confidence: 0.8, method: "test" },
      }],
    };

    const hidden = buildSearchRecommendations({
      extraCandidates: [known, fresh],
      extraSeeds: [{
        id: "hardcover:7",
        title: "The Wandering Inn",
        tags: ["Fantasy"],
        contentType: "novel",
        userRating: 4.6,
        userRatingMax: 5,
      }],
    }, {
      includeInLibrary: false,
      knownTitleKeys: [recommendationTitleKey("The Wandering Inn", "novel")],
      knownProviderKeys: [recommendationTrackerRemoteKey("hardcover", 7)!],
      nowMs: Date.parse("2026-05-01T00:00:00.000Z"),
    });

    const hiddenTitles = hidden.sections.flatMap((section) => section.items.map((item) => item.candidate.title));
    expect(hiddenTitles).not.toContain("The Wandering Inn");
    expect(hiddenTitles).toContain("New Fantasy Serial");

    const included = buildSearchRecommendations({
      extraCandidates: [known, fresh],
    }, {
      includeInLibrary: true,
      knownTitleKeys: [recommendationTitleKey("The Wandering Inn", "novel")],
      knownProviderKeys: [recommendationTrackerRemoteKey("hardcover", 7)!],
      nowMs: Date.parse("2026-05-01T00:00:00.000Z"),
    });
    const includedTitles = included.sections.flatMap((section) => section.items.map((item) => item.candidate.title));
    expect(includedTitles).toContain("The Wandering Inn");
  });
});
