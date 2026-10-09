import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    startDragging: vi.fn(async () => undefined),
  }),
}));

vi.mock("../../lib/serverLifecycle", () => ({
  SERVER_READY_EVENT: "epigraph:server-ready",
}));

import SeriesDetailV3Shell from "./SeriesDetailV3Shell.svelte";

describe("SeriesDetailV3Shell", () => {
  afterEach(() => cleanup());

  test("keeps the window controls in the detail topbar", () => {
    render(SeriesDetailV3Shell, {
      props: { mediaKind: "manga", title: "Dangerous Dungeon Escape", coverUrl: null, fallbackLabel: "Manga" },
    });

    const controls = document.querySelector(".n-topbar .window-controls-inline");
    expect(controls?.querySelectorAll("button")).toHaveLength(3);
  });

  test("retries a failed cover when Suwayomi reports ready", async () => {
    render(SeriesDetailV3Shell, {
      props: {
        mediaKind: "manga",
        title: "Dangerous Dungeon Escape",
        coverUrl: "http://127.0.0.1:4567/api/v1/manga/1/thumbnail",
        fallbackLabel: "Manga",
      },
    });

    const cover = screen.getByAltText("Dangerous Dungeon Escape");
    await fireEvent.error(cover);

    await waitFor(() => {
      expect(screen.queryByAltText("Dangerous Dungeon Escape")).toBeNull();
      expect(screen.getByText("Manga")).toBeTruthy();
    });

    window.dispatchEvent(new CustomEvent("epigraph:server-ready"));

    await waitFor(() => {
      expect(screen.getByAltText("Dangerous Dungeon Escape")).toBeTruthy();
    });
  });

  test("clears failed cover state when the cover URL changes", async () => {
    const view = render(SeriesDetailV3Shell, {
      props: {
        mediaKind: "manga",
        title: "Dangerous Dungeon Escape",
        coverUrl: "http://127.0.0.1:4567/api/v1/manga/1/thumbnail?generation=1",
        fallbackLabel: "Manga",
      },
    });

    await fireEvent.error(screen.getByAltText("Dangerous Dungeon Escape"));
    await waitFor(() => {
      expect(screen.queryByAltText("Dangerous Dungeon Escape")).toBeNull();
    });

    await view.rerender({
      mediaKind: "manga",
      title: "Dangerous Dungeon Escape",
      coverUrl: "http://127.0.0.1:4567/api/v1/manga/1/thumbnail?generation=2",
      fallbackLabel: "Manga",
    });

    await waitFor(() => {
      expect(screen.getByAltText("Dangerous Dungeon Escape")).toBeTruthy();
    });
  });
});
