import { mount } from "svelte";
import App from "./App.svelte";
import "./styles/global.css";

mount(App, { target: document.getElementById("app")! });

function dismissBootSplash() {
  const bootSplash = document.getElementById("boot-splash");
  if (!bootSplash) return;

  bootSplash.classList.add("boot-splash--gone");
  window.setTimeout(() => bootSplash.remove(), 220);
}

let bootSplashDismissed = false;
function requestBootSplashDismiss() {
  if (bootSplashDismissed) return;
  bootSplashDismissed = true;
  requestAnimationFrame(() => requestAnimationFrame(dismissBootSplash));
}

window.addEventListener("aethon:splash-mounted", requestBootSplashDismiss, { once: true });
window.setTimeout(requestBootSplashDismiss, 1200);
