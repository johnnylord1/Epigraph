import { cleanup, fireEvent, render, screen } from "@testing-library/svelte";
import { afterEach, describe, expect, test, vi } from "vitest";
import "../../lib/i18n/runtime";
import DetailDownloadMenu from "./DetailDownloadMenu.svelte";

function renderMenu(overrides: Record<string, unknown> = {}) {
  const props = {
    downloaded: 3,
    total: 40,
    nextFrom: 12,
    nextOptions: [
      { amount: 5, available: 5 },
      { amount: 10, available: 0 },
      { amount: 25, available: 20 },
    ],
    unreadCount: 28,
    notDownloadedCount: 37,
    onNext: vi.fn(),
    onRange: vi.fn(),
    onUnread: vi.fn(),
    onAll: vi.fn(),
    onDeleteAll: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
  // The menu hangs from its trigger's wrapper, the same way the detail pages mount it.
  const wrap = document.createElement("div");
  const trigger = document.createElement("button");
  trigger.textContent = "Download";
  wrap.append(trigger);
  document.body.append(wrap);
  render(DetailDownloadMenu, { target: wrap, props });
  return { props, trigger };
}

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

describe("DetailDownloadMenu", () => {
  test("summarises the downloads and runs each action once before closing", async () => {
    const { props } = renderMenu();

    expect(screen.getByText("3 of 40 downloaded")).toBeTruthy();
    expect(screen.getByText("Next from ch. 12")).toBeTruthy();

    await fireEvent.click(screen.getByRole("button", { name: "Download the next 25" }));
    expect(props.onNext).toHaveBeenCalledWith(25);
    expect((screen.getByRole("button", { name: "Download the next 10" }) as HTMLButtonElement).disabled).toBe(true);

    await fireEvent.click(screen.getByRole("button", { name: /Unread chapters/ }));
    expect(props.onUnread).toHaveBeenCalledTimes(1);
    await fireEvent.click(screen.getByRole("button", { name: /Download all/ }));
    expect(props.onAll).toHaveBeenCalledTimes(1);
    await fireEvent.click(screen.getByRole("button", { name: /Delete all downloads/ }));
    expect(props.onDeleteAll).not.toHaveBeenCalled();
    await fireEvent.click(screen.getByRole("button", { name: /Click again to delete/ }));
    expect(props.onDeleteAll).toHaveBeenCalledTimes(1);
    expect(props.onClose).toHaveBeenCalledTimes(4);
  });

  test("asks for a second press before deleting every download, and Escape backs out of it", async () => {
    const { props } = renderMenu();

    await fireEvent.click(screen.getByRole("button", { name: /Delete all downloads/ }));
    expect(screen.getByRole("button", { name: /Click again to delete/ })).toBeTruthy();
    await fireEvent.keyDown(window, { key: "Escape" });
    expect(props.onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /Delete all downloads/ })).toBeTruthy();

    await fireEvent.click(screen.getByRole("button", { name: /Delete all downloads/ }));
    await fireEvent.click(screen.getByRole("button", { name: /Click again to delete/ }));
    expect(props.onDeleteAll).toHaveBeenCalledTimes(1);
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  test("forgets an unconfirmed delete after a few seconds", async () => {
    vi.useFakeTimers();
    try {
      const { props } = renderMenu();
      await fireEvent.click(screen.getByRole("button", { name: /Delete all downloads/ }));
      await vi.advanceTimersByTimeAsync(4000);
      await fireEvent.click(screen.getByRole("button", { name: /Delete all downloads/ }));
      expect(props.onDeleteAll).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  test("shows the live status instead of the summary while downloads run", () => {
    renderMenu({ status: "2 active" });
    expect(screen.getByText("2 active")).toBeTruthy();
    expect(screen.queryByText("3 of 40 downloaded")).toBeNull();
  });

  test("hides the next shortcuts without a starting chapter and the delete action without downloads", () => {
    renderMenu({ nextFrom: null, downloaded: 0 });
    expect(screen.queryByRole("button", { name: /Download the next/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Delete all downloads/ })).toBeNull();
  });

  test("submits a custom range from the inline fields", async () => {
    const { props } = renderMenu();

    await fireEvent.click(screen.getByRole("button", { name: /Custom range/ }));
    const go = screen.getByRole("button", { name: "Go" }) as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    await fireEvent.input(screen.getByRole("textbox", { name: "From" }), { target: { value: "4" } });
    await fireEvent.input(screen.getByRole("textbox", { name: "To" }), { target: { value: "9" } });
    await fireEvent.click(go);

    expect(props.onRange).toHaveBeenCalledWith("4", "9");
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  test("disables every download action while busy", () => {
    renderMenu({ busy: true });
    for (const name of [/Unread chapters/, /Download all/, /Custom range/, /Delete all downloads/, /Download the next 5/]) {
      expect((screen.getByRole("button", { name }) as HTMLButtonElement).disabled).toBe(true);
    }
  });

  test("Escape leaves the range first, then closes and returns focus to the trigger", async () => {
    const { props, trigger } = renderMenu();

    await fireEvent.click(screen.getByRole("button", { name: /Custom range/ }));
    await fireEvent.keyDown(window, { key: "Escape" });
    expect(props.onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /Custom range/ })).toBeTruthy();

    await fireEvent.keyDown(window, { key: "Escape" });
    expect(props.onClose).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(trigger);
  });

  test("closes on a press outside its trigger wrapper only", async () => {
    const { props, trigger } = renderMenu();

    await fireEvent.mouseDown(trigger);
    expect(props.onClose).not.toHaveBeenCalled();
    await fireEvent.mouseDown(document.body);
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  test("runs extra actions such as the novel HTML export", async () => {
    const onSelect = vi.fn();
    const { props } = renderMenu({ extraActions: [{ label: "Export as HTML", count: 3, disabled: false, onSelect }] });

    await fireEvent.click(screen.getByRole("button", { name: /Export as HTML/ }));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });
});
