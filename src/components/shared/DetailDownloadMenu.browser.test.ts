import { cleanup, fireEvent, render, screen } from "@testing-library/svelte";
import { afterEach, expect, test } from "vitest";
import DetailDownloadMenu from "./DetailDownloadMenu.svelte";

const noop = () => {};

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

test("the custom range fields and Go button stay inside the popover", async () => {
  const wrap = document.createElement("div");
  wrap.style.cssText = "position:absolute;top:40px;right:40px;";
  wrap.append(Object.assign(document.createElement("button"), { textContent: "Download" }));
  document.body.append(wrap);
  render(DetailDownloadMenu, {
    target: wrap,
    props: {
      downloaded: 3, total: 142, nextFrom: 12,
      nextOptions: [{ amount: 5, available: 5 }, { amount: 10, available: 10 }, { amount: 25, available: 25 }],
      unreadCount: 130, notDownloadedCount: 139,
      onNext: noop, onRange: noop, onUnread: noop, onAll: noop, onDeleteAll: noop, onClose: noop,
    },
  });

  await fireEvent.click(screen.getByRole("button", { name: /Custom range/ }));
  const panel = document.querySelector<HTMLElement>("[data-detail-download-menu]")!.getBoundingClientRect();
  for (const element of [
    screen.getByRole("textbox", { name: "From" }),
    screen.getByRole("textbox", { name: "To" }),
    screen.getByRole("button", { name: "Go" }),
    screen.getByText("139"),
  ]) {
    const box = element.getBoundingClientRect();
    expect(box.width).toBeGreaterThan(0);
    expect(box.left).toBeGreaterThanOrEqual(panel.left);
    expect(box.right).toBeLessThanOrEqual(panel.right);
  }
  expect(document.querySelector<HTMLElement>("[data-detail-download-menu]")!.scrollWidth)
    .toBeLessThanOrEqual(Math.ceil(panel.width));
});
