import { getCurrentWindow } from "@tauri-apps/api/window";

/**
 * Window drag for the frameless topbars, done from the DOM instead of `-webkit-app-region: drag`.
 * WebView2 only recomputes app-region areas on layout, so the kept-alive pages stacked under the
 * active one (hidden with `visibility`, which is not a layout change) could leave a stale drag area
 * over the visible page's buttons: the OS took those clicks and nothing in the page responded.
 *
 * Same contract as Tauri's own drag script: a first click drags, a double click toggles maximize.
 * Returns whether the press was taken by the window.
 */
export function handleWindowDragMouseDown(event: MouseEvent, interactiveSelector: string): boolean {
  if (event.button !== 0 || (event.detail !== 1 && event.detail !== 2)) return false;
  const target = event.target;
  if (!(target instanceof Element) || target.closest(interactiveSelector)) return false;
  event.preventDefault();
  const appWindow = getCurrentWindow();
  if (event.detail === 2) appWindow.toggleMaximize().catch(() => {});
  else appWindow.startDragging().catch(() => {});
  return true;
}
