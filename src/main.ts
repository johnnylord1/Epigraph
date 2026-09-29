import { mount } from "svelte";
import App from "./App.svelte";
import "./styles/global.css";
import { isDetachedReaderWindow } from "./lib/reader/detachedChannel";

const target = document.getElementById("app")!;

if (isDetachedReaderWindow()) {
  void (async () => {
    const { connectDetachedReader } = await import("./lib/reader/detachedReaderClient");
    const client = await connectDetachedReader().catch((error) => {
      console.error("Detached reader could not reach the main window:", error);
      return null;
    });
    const { default: DetachedReaderApp } = await import("./components/reader/DetachedReaderApp.svelte");
    mount(DetachedReaderApp, { target, props: { client } });
  })();
} else {
  mount(App, { target });
}
