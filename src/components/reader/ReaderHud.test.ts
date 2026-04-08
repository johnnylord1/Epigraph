import { cleanup, render, screen } from "@testing-library/svelte";
import { afterEach, describe, expect, it } from "vitest";
import ReaderHudFixture from "./ReaderHud.test.fixture.svelte";

describe("ReaderHud", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders the same HUD chrome with comics adapter content", () => {
    const { container } = render(ReaderHudFixture, {
      props: {
        domain: "comics",
      },
    });

    expect(screen.getByTestId("hud-title").textContent).toBe("comics title");
    expect(screen.getByTestId("hud-action").textContent).toBe("comics action");
    expect(screen.getByLabelText("comics progress")).not.toBeNull();
    expect(container.querySelector(".topbar")).not.toBeNull();
    expect(container.querySelector(".bottombar")).not.toBeNull();
  });

  it("renders the same HUD chrome with books adapter content", () => {
    render(ReaderHudFixture, {
      props: {
        domain: "books",
      },
    });

    expect(screen.getByTestId("hud-title").textContent).toBe("books title");
    expect(screen.getByTestId("hud-action").textContent).toBe("books action");
    expect(screen.getByLabelText("books progress")).not.toBeNull();
  });

  it("hides top and bottom chrome without unmounting adapter content", () => {
    const { container } = render(ReaderHudFixture, {
      props: {
        domain: "books",
        uiVisible: false,
      },
    });

    expect(container.querySelector(".topbar")?.classList.contains("hidden")).toBe(true);
    expect(container.querySelector(".bottombar")?.classList.contains("hidden")).toBe(true);
    expect(screen.getByTestId("hud-content").textContent).toBe("books content");
  });
});
