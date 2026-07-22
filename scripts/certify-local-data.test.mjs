import test from "node:test";
import assert from "node:assert/strict";

import { normalizeBookState } from "./certify-local-data.mjs";

test("normalizes volatile book persistence into a deterministic release comparison", () => {
  const normalized = normalizeBookState({
    state: {
      books: [
        { id: "b", title: "PDF", subtype: "pdf", assetFingerprint: "pdf-hash", updatedAt: 20 },
        { id: "a", title: "EPUB", subtype: "epub", assetFingerprint: "epub-hash", updatedAt: 10 },
      ],
      bookProgress: [
        { bookId: "b", progressPercent: 0.5, lastReadAt: 999 },
        { bookId: "a", progressPercent: 0.25, lastReadAt: 888 },
      ],
      bookBookmarks: [{ bookId: "a", label: "Resume", progressPercent: 0.25, savedAt: 777 }],
      booksCategories: [{ id: "audit", name: "Audit Shelf", order: 1 }],
      booksCategoryAssignments: { a: ["audit"] },
    },
  });

  assert.deepEqual(normalized.books.map((entry) => entry.id), ["a", "b"]);
  assert.deepEqual(normalized.progress.map((entry) => entry.bookId), ["a", "b"]);
  assert.deepEqual(normalized.bookmarks, [{ bookId: "a", label: "Resume", progressPercent: 0.25 }]);
  assert.deepEqual(normalized.categories, [{ id: "audit", name: "Audit Shelf" }]);
});
