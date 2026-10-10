import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyAppLanguage } from "./runtime";
import { formatAppList, formatRelativeTime, formatWorkStatus } from "./format";

beforeEach(() => applyAppLanguage("en"));
afterEach(() => applyAppLanguage("en"));

describe("formatRelativeTime", () => {
  const now = Date.UTC(2026, 9, 4, 12, 0, 0);

  it("says just now instead of zero minutes ago", () => {
    expect(formatRelativeTime(now, now)).toBe("Just now");
    expect(formatRelativeTime(now - 59_000, now)).toBe("Just now");
    // A slightly-ahead clock on the other side must not read as "in 0 minutes".
    expect(formatRelativeTime(now + 5_000, now)).toBe("Just now");
  });

  it("uses the app language for just now", () => {
    applyAppLanguage("pt-BR");
    expect(formatRelativeTime(now - 30_000, now)).toBe("Agora mesmo");
  });

  it("switches to minutes once a full minute has passed", () => {
    expect(formatRelativeTime(now - 60_000, now)).not.toBe("Just now");
    expect(formatRelativeTime(now - 60_000, now)).toMatch(/1/);
  });
});

describe("formatAppList", () => {
  it("joins with the conjunction of the app language", () => {
    expect(formatAppList(["Action", "Sci Fi"])).toBe("Action and Sci Fi");
    applyAppLanguage("pt-BR");
    expect(formatAppList(["Action", "Sci Fi"])).toBe("Action e Sci Fi");
    expect(formatAppList(["Action"])).toBe("Action");
  });
});

describe("formatWorkStatus", () => {
  it("reads the statuses trackers use", () => {
    applyAppLanguage("pt-BR");
    expect(formatWorkStatus("RELEASING")).toBe("Em andamento");
    expect(formatWorkStatus("Releasing")).toBe("Em andamento");
    expect(formatWorkStatus("FINISHED")).toBe("Concluído");
    expect(formatWorkStatus("ONGOING")).toBe("Em andamento");
  });
});
