import { cleanup, render, screen, fireEvent } from "@testing-library/svelte";
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

    expect(container.querySelector(".series-title")?.textContent).toBe("comics title");
    expect(container.querySelector(".chapter-title")?.textContent).toBe("comics chapter");
    expect(screen.getByText("comics progress")).not.toBeNull();
    expect(container.querySelector(".reader-capsule-bar")).not.toBeNull();
  });

  it("renders the same HUD chrome with books adapter content", () => {
    const { container } = render(ReaderHudFixture, {
      props: {
        domain: "books",
      },
    });

    expect(container.querySelector(".series-title")?.textContent).toBe("books title");
    expect(container.querySelector(".chapter-title")?.textContent).toBe("books chapter");
    expect(screen.getByText("books progress")).not.toBeNull();
  });

  it("hides HUD chrome overlay without unmounting adapter content", () => {
    const { container } = render(ReaderHudFixture, {
      props: {
        domain: "books",
        uiVisible: false,
      },
    });

    expect(container.querySelector(".reader-hud-overlay")?.classList.contains("hidden")).toBe(true);
    expect(screen.getByTestId("hud-content").textContent).toBe("books content");
  });

  it("toggles settings popover on cog click", async () => {
    const { container } = render(ReaderHudFixture, {
      props: {
        domain: "books",
        uiVisible: true,
      },
    });

    // Popover is initially closed
    expect(screen.queryByTestId("hud-settings-popover")).toBeNull();

    // Click settings button (cog button is the one with title "Settings")
    const settingsBtn = container.querySelector('button[title="Settings"]');
    expect(settingsBtn).not.toBeNull();
    if (settingsBtn) {
      await fireEvent.click(settingsBtn);
      expect(screen.getByTestId("hud-settings-popover")).not.toBeNull();
    }
  });

  it("toggles HUD chrome when the reading viewport is clicked", async () => {
    const { container } = render(ReaderHudFixture, {
      props: {
        domain: "books",
        uiVisible: false,
      },
    });

    const overlay = container.querySelector(".reader-hud-overlay");
    const content = screen.getByTestId("hud-content");
    expect(overlay?.classList.contains("hidden")).toBe(true);

    await fireEvent.click(content);
    expect(overlay?.classList.contains("hidden")).toBe(false);

    await fireEvent.click(content);
    expect(overlay?.classList.contains("hidden")).toBe(true);
  });

  it("does not toggle HUD chrome when an interactive control is clicked", async () => {
    const { container } = render(ReaderHudFixture, {
      props: {
        domain: "books",
        uiVisible: true,
      },
    });

    const overlay = container.querySelector(".reader-hud-overlay");
    const settingsBtn = container.querySelector('button[title="Settings"]');
    expect(settingsBtn).not.toBeNull();

    if (settingsBtn) {
      await fireEvent.click(settingsBtn);
      expect(overlay?.classList.contains("hidden")).toBe(false);
      expect(screen.getByTestId("hud-settings-popover")).not.toBeNull();
    }
  });

});
