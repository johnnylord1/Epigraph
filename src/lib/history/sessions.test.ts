import { describe, expect, it } from "vitest";
import { groupReadingSessions, READING_SESSION_GAP_MS } from "./sessions";

const read = (title: string, minutesAgo: number) => ({ title, readAt: 1_000_000_000 - minutesAgo * 60_000 });
const group = (items: ReturnType<typeof read>[]) =>
  groupReadingSessions(items, (item) => item.title, (item) => item.readAt).map((session) => session.length);

describe("groupReadingSessions", () => {
  it("joins back-to-back reads of one title and splits on another title or a long pause", () => {
    expect(group([
      read("One Piece", 0),
      read("One Piece", 10),
      read("One Piece", 20),
      read("Changeling", 25),
      read("One Piece", 30),
      read("One Piece", 30 + READING_SESSION_GAP_MS / 60_000 + 1),
    ])).toEqual([3, 1, 1, 1]);
  });

  it("returns nothing for no reads", () => {
    expect(group([])).toEqual([]);
  });
});
