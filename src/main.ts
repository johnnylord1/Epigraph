import { mount } from "svelte";
import App from "./App.svelte";
import "./styles/global.css";
import { isDetachedReaderWindow } from "./lib/reader/detachedChannel";
import { applyAppLanguage, messagesReady } from "./lib/i18n/runtime";
import { store } from "./store/state.svelte";

const target = document.getElementById("app")!;
const LANGUAGE_WAIT_MS = 1500;

// The first frame uses the saved language; a catalog that is slow to arrive must not keep the window blank.
function savedLanguageReady() {
  applyAppLanguage(store.settings.appLanguage);
  return Promise.race([messagesReady(), new Promise((resolve) => setTimeout(resolve, LANGUAGE_WAIT_MS))]);
}

if (isDetachedReaderWindow()) {
  void (async () => {
    const { connectDetachedReader } = await import("./lib/reader/detachedReaderClient");
    const client = await connectDetachedReader().catch((error) => {
      console.error("Detached reader could not reach the main window:", error);
      return null;
    });
    const { default: DetachedReaderApp } = await import("./components/reader/DetachedReaderApp.svelte");
    await savedLanguageReady();
    mount(DetachedReaderApp, { target, props: { client } });
  })();
} else {
  void savedLanguageReady().then(() => mount(App, { target }));
}
