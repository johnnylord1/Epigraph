import { afterEach, describe, expect, it } from "vitest";
import { applyAppLanguage, messagesReady } from "./runtime";
import { addToast, store } from "../../store/state.svelte";

afterEach(() => {
  applyAppLanguage("en");
  store.toasts = [];
});

describe("toasts about a request that never reached its server", () => {
  it("say so in the app language instead of the WebView's English wording", async () => {
    applyAppLanguage("pt-BR");
    await messagesReady();

    addToast({ kind: "error", title: "Não foi possível excluir os downloads", body: "Failed to fetch" });
    addToast({ kind: "error", title: "Falha na sincronização", body: "NetworkError when attempting to fetch resource." });
    addToast({ kind: "error", title: "Falha na busca", body: "TypeError: Failed to fetch" });

    expect(store.toasts.map((toast) => toast.body)).toEqual([
      "Não foi possível acessar o serviço. Verifique sua conexão e tente novamente.",
      "Não foi possível acessar o serviço. Verifique sua conexão e tente novamente.",
      "Não foi possível acessar o serviço. Verifique sua conexão e tente novamente.",
    ]);
  });

  it("keep any other error text as the server wrote it", () => {
    addToast({ kind: "error", title: "Could not delete the downloads", body: "Suwayomi HTTP 500" });
    addToast({ kind: "info", title: "Downloads deleted", body: "Failed to fetch the moon" });

    expect(store.toasts.map((toast) => toast.body)).toEqual(["Suwayomi HTTP 500", "Failed to fetch the moon"]);
  });
});
