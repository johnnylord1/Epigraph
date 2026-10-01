import { cleanup, render, screen } from "@testing-library/svelte";
import { afterEach, describe, expect, test } from "vitest";
import { applyAppLanguage, messagesReady } from "../../lib/i18n/runtime";
import NocturneState from "./NocturneState.svelte";

afterEach(() => {
  cleanup();
  applyAppLanguage("en");
});

describe("NocturneState error copy", () => {
  // Error states pass a caught error's message straight through, so the WebView's English wording for a
  // request that never left the machine has to be replaced where it is shown.
  test("shows a request that never reached its server in the app language", async () => {
    applyAppLanguage("pt-BR");
    await messagesReady();

    render(NocturneState, {
      props: { tone: "danger", title: "Falha na busca", body: "Failed to fetch", detail: "TypeError: Failed to fetch" },
    });

    const network = "Não foi possível acessar o serviço. Verifique sua conexão e tente novamente.";
    expect(screen.getByRole("alert").querySelector(".n-state__body")?.textContent).toBe(network);
    expect(screen.getByRole("alert").querySelector(".n-state__detail")?.textContent).toBe(network);
    expect(screen.queryByText("Failed to fetch")).toBeNull();
  });

  test("keeps any other message as written", () => {
    render(NocturneState, {
      props: { tone: "danger", title: "Search failed", body: "Suwayomi HTTP 500", detail: "Failed to fetch the moon" },
    });

    expect(screen.getByText("Suwayomi HTTP 500")).toBeTruthy();
    expect(screen.getByText("Failed to fetch the moon")).toBeTruthy();
  });
});
