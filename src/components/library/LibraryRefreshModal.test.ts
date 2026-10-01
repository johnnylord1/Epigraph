import { cleanup, fireEvent, render, screen } from "@testing-library/svelte";
import { afterEach, describe, expect, test, vi } from "vitest";
import "../../lib/i18n/runtime";
import LibraryRefreshModal from "./LibraryRefreshModal.svelte";

function renderModal(overrides: { section?: "comics" | "books"; busy?: boolean } = {}) {
  const props = { section: "comics" as const, busy: false, onRun: vi.fn(), onClose: vi.fn(), ...overrides };
  render(LibraryRefreshModal, { props });
  return props;
}

afterEach(() => cleanup());

describe("LibraryRefreshModal", () => {
  test("offers the active library and all libraries", async () => {
    const props = renderModal();

    expect(screen.getByRole("dialog", { name: "Library refresh" })).toBeTruthy();
    await fireEvent.click(screen.getByRole("button", { name: /Update Comics library/ }));
    expect(props.onRun).toHaveBeenCalledWith("active");
    await fireEvent.click(screen.getByRole("button", { name: /Update All Libraries/ }));
    expect(props.onRun).toHaveBeenLastCalledWith("all");
  });

  test("names the Books library when Books is the active section", () => {
    renderModal({ section: "books" });
    expect(screen.getByRole("button", { name: /Update Books library/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Update Comics library/ })).toBeNull();
  });

  test("closes with Escape and the backdrop", async () => {
    const props = renderModal();

    await fireEvent.keyDown(window, { key: "Escape" });
    expect(props.onClose).toHaveBeenCalledTimes(1);
    const [backdrop] = screen.getAllByRole("button", { name: "Close refresh dialog" });
    await fireEvent.click(backdrop);
    expect(props.onClose).toHaveBeenCalledTimes(2);
  });

  test("stays open and inert while a refresh is running", async () => {
    const props = renderModal({ busy: true });

    await fireEvent.keyDown(window, { key: "Escape" });
    for (const button of screen.getAllByRole("button")) {
      expect((button as HTMLButtonElement).disabled).toBe(true);
    }
    expect(props.onClose).not.toHaveBeenCalled();
    expect(props.onRun).not.toHaveBeenCalled();
  });
});
