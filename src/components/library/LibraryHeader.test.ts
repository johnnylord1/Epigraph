import { cleanup, fireEvent, render, screen } from "@testing-library/svelte";
import { afterEach, describe, expect, test, vi } from "vitest";
import LibraryHeader from "./LibraryHeader.svelte";

describe("LibraryHeader", () => {
  afterEach(() => cleanup());

  test("renders section tabs and forwards explicit callbacks", async () => {
    const onSectionChange = vi.fn();

    render(LibraryHeader, {
      props: {
        heading: "Library",
        sectionTabs: [
          { id: "comics", label: "Comics", icon: "stack", active: true },
          { id: "books", label: "Books", icon: "book", active: false },
        ],
        onSectionChange,
      },
    });

    expect(screen.getByRole("button", { name: /Comics/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Books/i })).toBeTruthy();

    await fireEvent.click(screen.getByRole("button", { name: /Books/i }));

    expect(onSectionChange).toHaveBeenCalledWith("books");
  });
});
