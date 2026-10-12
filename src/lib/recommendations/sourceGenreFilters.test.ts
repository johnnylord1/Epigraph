import { describe, expect, test } from "vitest";

import type { SourceFilter } from "../manga/runtime/types";
import { sourceGenreFilterChange } from "./sourceGenreFilters";

const leaf = (kind: SourceFilter["kind"], name: string, values: string[] = []): SourceFilter =>
  ({ kind, name, values, filters: [] });
const group = (name: string, filters: SourceFilter[]): SourceFilter =>
  ({ kind: "group", name, values: [], filters });

describe("sourceGenreFilterChange", () => {
  test("checks a genre box inside the source's genre group", () => {
    const filters = [
      leaf("header", "Ignored with a text search"),
      leaf("sort", "Order by", ["Popular", "Fantasy"]),
      group("Genres", [leaf("checkbox", "Action (171)"), leaf("checkbox", "Fantasy (98)")]),
    ];
    expect(sourceGenreFilterChange(filters, "Fantasy")).toEqual({
      position: 2,
      groupChange: { position: 1, checkBoxState: true },
    });
  });

  test("includes a tri-state tag and matches the genre's other names", () => {
    const filters = [group("Tags", [leaf("tristate", "Romance"), leaf("tristate", "Science Fiction")])];
    expect(sourceGenreFilterChange(filters, "Sci-Fi")).toEqual({
      position: 0,
      groupChange: { position: 1, triState: "INCLUDE" },
    });
  });

  test("picks the genre from a select list", () => {
    const filters = [leaf("select", "Status", ["All", "Ongoing"]), leaf("select", "Category", ["All", "Action", "Fantasy"])];
    expect(sourceGenreFilterChange(filters, "Fantasy")).toEqual({ position: 1, selectState: 2 });
  });

  test("never uses a list that leaves genres out, nor a compound genre for a single one", () => {
    const filters = [
      group("Exclude genres", [leaf("checkbox", "Romance")]),
      group("Genres", [leaf("checkbox", "Romantic Comedy")]),
    ];
    expect(sourceGenreFilterChange(filters, "Romance")).toBeNull();
  });

  test("prefers the list named for genres", () => {
    const filters = [
      group("Demographic", [leaf("checkbox", "Action")]),
      group("Genre", [leaf("checkbox", "Action")]),
    ];
    expect(sourceGenreFilterChange(filters, "Action")).toMatchObject({ position: 1 });
  });
});
