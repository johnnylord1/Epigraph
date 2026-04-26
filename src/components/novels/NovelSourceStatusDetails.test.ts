import { cleanup, fireEvent, render, screen, within } from "@testing-library/svelte";
import { afterEach, describe, expect, test, vi } from "vitest";

import NovelSourceStatusDetails from "./NovelSourceStatusDetails.svelte";

const pendingRecord = {
  pluginId: "scribblehub",
  repositoryId: "repo-1",
  repositoryUrl: "https://example.invalid",
  lang: "en",
  version: "1.0.0",
  status: "pending" as const,
  notes: "Waiting for the next automatic source check.",
  baselineStatus: "pending" as const,
  baselineNotes: "Priority English cohort target.",
  issues: [
    {
      code: "automatic-smoke-queued" as const,
      message: "Automatic source check is queued and still waiting for the bounded smoke recipe.",
      severity: "info" as const,
    },
  ],
  smoke: {
    pluginLoadConfirmed: false,
    searchConfirmed: false,
    detailsConfirmed: false,
    chapterConfirmed: false,
  },
  filterKeys: [],
  pluginSettingsKeys: [],
  classifiedAtMs: Date.now(),
};

describe("NovelSourceStatusDetails", () => {
  afterEach(() => cleanup());

  test("opens details on hover and shows retry when relevant", async () => {
    const onRetryCheck = vi.fn();

    const { container } = render(NovelSourceStatusDetails, {
      props: {
        pluginName: "ScribbleHub",
        record: pendingRecord,
        badge: {
          shortLabel: "Pending",
          longLabel: "Pending smoke",
          tone: "muted",
        },
        onRetryCheck,
      },
    });

    await fireEvent.mouseEnter(container.firstElementChild as Element);

    const dialog = screen.getByRole("dialog", { name: "Pending smoke" });
    expect(dialog).toBeTruthy();
    expect(within(dialog).getByText("Still checking")).toBeTruthy();
    expect(within(dialog).queryByText("Primary reason")).toBeNull();

    await fireEvent.click(within(dialog).getByRole("button", { name: "Retry check" }));
    expect(onRetryCheck).toHaveBeenCalledTimes(1);
  });

  test("is keyboard-focusable and closes with Escape", async () => {
    render(NovelSourceStatusDetails, {
      props: {
        pluginName: "Royal Road",
        record: {
          ...pendingRecord,
          pluginId: "royalroad",
          status: "migration-safe",
          notes: "Automatic smoke passed.",
          issues: [],
        },
        badge: {
          shortLabel: "Migration-safe",
          longLabel: "Migration-safe",
          tone: "success",
        },
      },
    });

    const trigger = screen.getByRole("button", { name: "Show status details for Royal Road" });
    trigger.focus();
    await fireEvent.focusIn(trigger);

    expect(screen.getByRole("dialog", { name: "Migration-safe" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry check" })).toBeNull();

    await fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Migration-safe" })).toBeNull();
  });
});
