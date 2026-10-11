import { flip, type AnimationConfig } from "svelte/animate";
import { cubicOut } from "svelte/easing";
import { fade, fly, type FadeParams, type FlyParams, type TransitionConfig } from "svelte/transition";

/**
 * Epigraph motion. Everything here is decoration: it never gates navigation or state changes, and
 * all of it is skipped when the user asks for less motion or the Web Animations API is missing.
 */

/**
 * The app's own animation setting. `null` follows the system (Windows "Animation effects", which
 * WebView2 reports as `prefers-reduced-motion`); `true`/`false` is the user's explicit choice in
 * Settings › Appearance and wins over the system.
 */
let animationPreference: boolean | null = null;

export function setAnimationPreference(enabled: boolean | null | undefined) {
  animationPreference = typeof enabled === "boolean" ? enabled : null;
}

/** True when the system asks for less motion, regardless of the app setting. */
export function systemPrefersReducedMotion(): boolean {
  try {
    return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/** True when motion should be skipped: the app setting, then the system, or no Web Animations API. */
export function prefersReducedMotion(): boolean {
  if (typeof Element === "undefined" || typeof Element.prototype.animate !== "function") return true;
  if (animationPreference !== null) return !animationPreference;
  return systemPrefersReducedMotion();
}

/** Svelte's fade and fly, skipped entirely when motion is reduced. */
export function motionFade(node: Element, params?: FadeParams): TransitionConfig {
  return prefersReducedMotion() ? { duration: 0 } : fade(node, params);
}

export function motionFly(node: Element, params?: FlyParams): TransitionConfig {
  return prefersReducedMotion() ? { duration: 0 } : fly(node, params);
}

/** Soft spring (about 4% overshoot) for arrivals. */
export function spring(t: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return 1 - Math.exp(-7 * t) * Math.cos(7 * t);
}

const EASE_IN = (t: number) => t * t * t;
const OUT_EASING = "cubic-bezier(.16,1,.3,1)";
/** Unhurried deceleration for views: half the way at a fifth of the time, settled by two thirds. */
const SETTLE_EASING = "cubic-bezier(.33,1,.68,1)";
/** CSS equivalent of {@link spring}, sampled for the Web Animations API. */
export const SPRING_EASING = `linear(${Array.from({ length: 21 }, (_, index) => spring(index / 20).toFixed(3)).join(",")})`;

/** Content that appears inside a page (a new list, a status change) rises in with the spring. */
export function arrive(_node: Element, { delay = 0, y = 14 }: { delay?: number; y?: number } = {}): TransitionConfig {
  if (prefersReducedMotion()) return { duration: 0 };
  return {
    delay,
    duration: 650,
    easing: spring,
    css: (t, u) => `opacity:${Math.min(1, t)};transform:translateY(${u * y}px) scale(${0.97 + 0.03 * t})`,
  };
}

/** Page exit: slides toward the previous side while blurring out. */
export function depart(_node: Element, { direction = 1, duration = 240 }: { direction?: number; duration?: number } = {}): TransitionConfig {
  if (prefersReducedMotion()) return { duration: 0 };
  return {
    duration,
    easing: EASE_IN,
    css: (t, u) => `opacity:${t};transform:translate(${-u * 36 * direction}px,${-u * 6}px) scale(${0.98 + 0.02 * t});filter:blur(${u * 6}px)`,
  };
}

function animate(element: Element, keyframes: Keyframe[], options: KeyframeAnimationOptions): Animation | null {
  if (typeof (element as HTMLElement).animate !== "function") return null;
  try {
    return (element as HTMLElement).animate(keyframes, options);
  } catch {
    return (element as HTMLElement).animate(keyframes, { ...options, easing: OUT_EASING });
  }
}

type StaggerOptions = { direction?: number; baseDelay?: number; settle?: boolean };

/**
 * Staggered arrival for the given elements; headings marked `.fr-word` rise word by word. `settle`
 * trades the springy first-run cadence for the slower deceleration that pages use.
 */
export function enterElements(elements: Iterable<Element>, { direction = 1, baseDelay = 140, settle = false }: StaggerOptions = {}) {
  if (prefersReducedMotion()) return;
  let index = 0;
  for (const element of elements) {
    const words = element.querySelectorAll(":scope .fr-word > span");
    if (words.length > 0) {
      words.forEach((word, wordIndex) => animate(word, [
        { transform: "translateY(105%) rotate(4deg)", opacity: 0 },
        { transform: "none", opacity: 1 },
      ], { duration: 900, delay: 60 + wordIndex * 70, easing: OUT_EASING, fill: "backwards" }));
    } else {
      animate(element, [
        { opacity: 0, transform: settle ? "translateY(22px) scale(.985)" : `translate(${28 * direction}px,18px) scale(.965)`, filter: "blur(8px)" },
        { opacity: 1, transform: "none", filter: "blur(0)" },
      ], settle
        ? { duration: 900, delay: baseDelay + index * 90, easing: SETTLE_EASING, fill: "backwards" }
        : { duration: 850, delay: baseDelay + index * 48, easing: SPRING_EASING, fill: "backwards" });
    }
    index += 1;
  }
}

/** Svelte action: children marked `data-enter` arrive in sequence when the node mounts. */
export function staggerIn(node: HTMLElement, options: StaggerOptions = {}) {
  enterElements(node.querySelectorAll("[data-enter]"), options);
}

/** Brief emphasis when something becomes available (a button enabling, a counter changing). */
export function pulse(element: Element | null | undefined, scale = 1.08) {
  if (!element || prefersReducedMotion()) return;
  animate(element, [{ transform: "scale(1)" }, { transform: `scale(${scale})` }, { transform: "scale(1)" }], {
    duration: 600,
    easing: "cubic-bezier(.34,1.56,.64,1)",
  });
}

/** Element whose data attribute equals the value, without building a selector from user data. */
export function findByData(root: ParentNode | null | undefined, attribute: string, value: string): HTMLElement | null {
  if (!root) return null;
  for (const element of root.querySelectorAll<HTMLElement>(`[data-${attribute}]`)) {
    if (element.getAttribute(`data-${attribute}`) === value) return element;
  }
  return null;
}

/** Success tint that fades from a row, used after an install or a connection. */
export function flash(element: Element | null | undefined) {
  if (!element) return;
  element.classList.remove("is-flashing");
  void (element as HTMLElement).offsetWidth;
  element.classList.add("is-flashing");
}

/** Counts from zero to the value once the node mounts, with an ease-out. */
export function countUp(node: HTMLElement, value: number) {
  let frame = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  function run(target: number) {
    cancelAnimationFrame(frame);
    clearTimeout(timer);
    if (prefersReducedMotion() || target <= 0) {
      node.textContent = String(target);
      return;
    }
    const start = performance.now() + 250;
    const tick = () => {
      const progress = Math.min(Math.max((performance.now() - start) / 800, 0), 1);
      node.textContent = String(Math.round(target * (1 - Math.pow(1 - progress, 3))));
      // Timers keep the count honest when a background window throttles animation frames.
      if (progress < 1) timer = setTimeout(tick, 16);
    };
    tick();
  }
  run(value);
  return {
    update: run,
    destroy() { cancelAnimationFrame(frame); clearTimeout(timer); },
  };
}

/**
 * Runs `commit` once the current frame has painted. Callers flip a cheap visual state first (a
 * highlight or thumb starting its transform transition) and defer the heavy page change here, so
 * the motion is already on the compositor when the render blocks the main thread.
 */
export function afterPaint(commit: () => void) {
  requestAnimationFrame(() => setTimeout(commit, 0));
}

const PAGE_LEAVE_MS = 100;
let pageLeave: { swap: () => void } | null = null;

/**
 * Fades the page out under a veil of the app background, then swaps it (the next page runs its own
 * entrance). The veil is one flat layer: fading the page itself kept ~2,000 of its elements styled
 * through the switch and roughly doubled its cost. Clicks during the fade retarget the pending swap.
 */
export function swapAfterPageLeave(swap: () => void) {
  if (pageLeave) {
    pageLeave.swap = swap;
    return;
  }
  const main = document.querySelector<HTMLElement>(".main");
  if (!main || prefersReducedMotion()) {
    afterPaint(swap);
    return;
  }
  const veil = document.createElement("div");
  veil.className = "page-leave-veil";
  veil.setAttribute("aria-hidden", "true");
  veil.style.top = `${main.scrollTop}px`;
  veil.style.height = `${main.clientHeight}px`;
  main.append(veil);
  const animation = veil.animate({ opacity: [0, 1] }, { duration: PAGE_LEAVE_MS, easing: "cubic-bezier(0.4, 0, 1, 1)", fill: "forwards" });
  const pending = { swap };
  pageLeave = pending;
  const finish = () => {
    if (pageLeave !== pending) return;
    pageLeave = null;
    veil.remove();
    pending.swap();
  };
  animation.finished.then(finish, finish);
}

/** Controls that answer a press with a ripple. */
const PRESSABLE = [
  ".fr-btn", ".fr-link", ".fr-card",
  ".n-btn", ".n-icon-btn", ".n-chip", ".n-pill", ".n-genre-chip", ".n-segmented__btn", ".n-inline-segment",
  ".n-popover-item", ".n-sidebar-btn", "[data-ripple]",
  ".series-primary", ".series-action", ".series-utility", ".series-icon", ".series-toolbar-btn",
].join(", ");
/** Filled primary actions that lean slightly toward the pointer. */
const MAGNETIC = ".fr-btn--primary, .n-btn-primary";
/** Fields whose focus underline grows from the click position. */
const FIELD = ".fr-field, .n-field, .n-search";
/** Nested roots (the first run inside the app shell) handle each pointer event once, innermost first. */
const handledEvents = new WeakSet<Event>();

/**
 * Pointer effects delegated from a root: press ripples, a slight magnetic pull on primary actions,
 * tilt on `[data-tilt]` tiles, a spotlight on `[data-spotlight]` surfaces and field underlines that
 * grow from the click position. One set of listeners serves the whole subtree.
 */
export function pointerEffects(root: HTMLElement) {
  const reduced = prefersReducedMotion();
  let magnetized: HTMLElement | null = null;
  const release = () => {
    if (magnetized) magnetized.style.translate = "";
    magnetized = null;
  };
  const onDown = (event: PointerEvent) => {
    if (handledEvents.has(event)) return;
    handledEvents.add(event);
    const target = event.target as Element | null;
    const field = target?.closest<HTMLElement>(FIELD);
    if (field) {
      const rect = field.getBoundingClientRect();
      field.style.setProperty("--fr-origin", `${((event.clientX - rect.left) / rect.width) * 100}%`);
    }
    if (event.button !== 0) return;
    const pressable = target?.closest<HTMLElement>(PRESSABLE);
    if (!pressable || reduced || (pressable as HTMLButtonElement).disabled || pressable.getAttribute("aria-disabled") === "true") return;
    if (!root.contains(pressable) || pressable.dataset.ripple === "off") return;
    const rect = pressable.getBoundingClientRect();
    const ripple = document.createElement("span");
    ripple.className = "fr-ripple";
    ripple.setAttribute("aria-hidden", "true");
    ripple.style.left = `${event.clientX - rect.left}px`;
    ripple.style.top = `${event.clientY - rect.top}px`;
    // First-run controls clip their own ripple; app controls get a clipping host so the control
    // itself keeps its overflow (badges and focus rings may sit outside its box).
    let host: HTMLElement = pressable;
    if (!pressable.matches(".fr-btn, .fr-link, .fr-card")) {
      host = document.createElement("span");
      host.className = "ui-ripple-host";
      host.setAttribute("aria-hidden", "true");
      pressable.append(host);
    }
    host.append(ripple);
    const animation = animate(ripple, [
      { transform: "scale(0)", opacity: 0.3 },
      { transform: `scale(${Math.max(rect.width, rect.height) / 5})`, opacity: 0 },
    ], { duration: 650, easing: OUT_EASING });
    const remove = () => (host === pressable ? ripple : host).remove();
    if (animation) animation.onfinish = remove;
    setTimeout(remove, 900);
  };
  const onMove = (event: PointerEvent) => {
    if (reduced || handledEvents.has(event)) return;
    handledEvents.add(event);
    const target = event.target as Element | null;
    const primary = target?.closest<HTMLElement>(MAGNETIC);
    if (primary !== magnetized) release();
    if (primary && !(primary as HTMLButtonElement).disabled) {
      const rect = primary.getBoundingClientRect();
      primary.style.translate = `${(event.clientX - rect.left - rect.width / 2) * 0.12}px ${(event.clientY - rect.top - rect.height / 2) * 0.22}px`;
      magnetized = primary;
    }
    const tilt = target?.closest<HTMLElement>("[data-tilt]");
    if (tilt) {
      const rect = tilt.getBoundingClientRect();
      const x = (event.clientX - rect.left) / rect.width;
      const y = (event.clientY - rect.top) / rect.height;
      tilt.style.setProperty("--fr-tilt-y", `${(x - 0.5) * 14}deg`);
      tilt.style.setProperty("--fr-tilt-x", `${(0.5 - y) * 12}deg`);
      tilt.style.setProperty("--fr-glare-x", `${x * 100}%`);
      tilt.style.setProperty("--fr-glare-y", `${y * 100}%`);
    }
    const spot = target?.closest<HTMLElement>("[data-spotlight]");
    if (spot) {
      const rect = spot.getBoundingClientRect();
      spot.style.setProperty("--fr-spot-x", `${event.clientX - rect.left}px`);
      spot.style.setProperty("--fr-spot-y", `${event.clientY - rect.top}px`);
    }
  };
  const onOut = (event: PointerEvent) => {
    const tilt = (event.target as Element | null)?.closest<HTMLElement>("[data-tilt]");
    if (tilt && !tilt.contains(event.relatedTarget as Node | null)) {
      tilt.style.setProperty("--fr-tilt-x", "0deg");
      tilt.style.setProperty("--fr-tilt-y", "0deg");
    }
    if (magnetized && !magnetized.contains(event.relatedTarget as Node | null)) release();
  };
  root.addEventListener("pointerdown", onDown);
  root.addEventListener("pointermove", onMove);
  root.addEventListener("pointerout", onOut);
  return {
    destroy() {
      root.removeEventListener("pointerdown", onDown);
      root.removeEventListener("pointermove", onMove);
      root.removeEventListener("pointerout", onOut);
      release();
    },
  };
}

type EnterOptions = { y?: number; blur?: number; duration?: number; delay?: number; scale?: number; stagger?: number };

/** Arrival of a whole view (a page, a settings section, a tab panel): rises and sharpens in. */
export function playEnter(node: Element | null | undefined, { y = 10, blur = 6, duration = 640, delay = 0, scale = 1 }: EnterOptions = {}) {
  if (!node || prefersReducedMotion()) return;
  animate(node, [
    { opacity: 0, transform: `translateY(${y}px) scale(${scale})`, filter: `blur(${blur}px)` },
    { opacity: 1, transform: "none", filter: "blur(0)" },
  ], { duration, delay, easing: SETTLE_EASING, fill: "backwards" });
}

/** Fixed chrome stays put while the content below it arrives. */
const STATIC_CHROME = ".n-topbar, .downloads-topbar-shell, .browseSubtabs, [data-view-static]";

/**
 * Plays the arrival of a page: each content block rises in with a short stagger. The fixed topbar
 * never moves; a wrapper that holds the topbar together with the content is entered one level down.
 */
export function enterView(root: Element | null | undefined, options: EnterOptions = {}) {
  if (!root || prefersReducedMotion()) return;
  let blocks: Element[] = [];
  for (const child of root.children) {
    if (child.matches(STATIC_CHROME)) continue;
    if (child.querySelector(`:scope > :is(${STATIC_CHROME})`)) {
      for (const inner of child.children) if (!inner.matches(STATIC_CHROME)) blocks.push(inner);
    } else {
      blocks.push(child);
    }
  }
  // A page whose content sits in one scroll wrapper cascades through the wrapper's few sections
  // instead (a long list or grid stays one block, so no item is left behind the cascade).
  for (let depth = 0; depth < 3 && blocks.length === 1 && blocks[0].children.length > 0 && blocks[0].children.length <= 8; depth += 1) {
    blocks = [...blocks[0].children].filter((child) => !child.matches(STATIC_CHROME));
  }
  // No scale: on a cover grid a shrunken start reads as the cards resizing in front of the user. No blur
  // either: these blocks are page-sized, and blurring them every frame stalled each page switch.
  const settings = { y: 22, blur: 0, duration: 900, scale: 1, ...options };
  const stagger = options.stagger ?? 90;
  blocks.slice(0, 7).forEach((block, index) => playEnter(block, { ...settings, delay: (settings.delay ?? 0) + index * stagger }));
}

/**
 * Svelte action: plays {@link playEnter} whenever `key` changes (for views that stay mounted, such
 * as a kept-alive page becoming active or a tab panel whose content swaps in place).
 */
export function enterOnChange(node: HTMLElement, key: unknown) {
  let current = key;
  return {
    update(next: unknown) {
      if (Object.is(next, current)) return;
      current = next;
      playEnter(node);
    },
  };
}

/** Svelte action: the node is a view root whose content blocks arrive when it mounts (see {@link enterView}). */
export function enterViewOnMount(node: HTMLElement, options?: EnterOptions) {
  enterView(node, options);
}

/** Svelte action: plays {@link playEnter} once when the node mounts. */
export function enterOnMount(node: HTMLElement, options?: EnterOptions) {
  playEnter(node, options);
}

/** Popovers, menus and dialogs: grow from their anchor with the spring and fade out quickly. */
export function popIn(_node: Element, { y = -6, scale = 0.96, duration = 380 }: { y?: number; scale?: number; duration?: number } = {}): TransitionConfig {
  if (prefersReducedMotion()) return { duration: 0 };
  return {
    duration,
    easing: spring,
    css: (t, u) => `opacity:${Math.min(1, t * 1.6)};transform:translateY(${u * y}px) scale(${scale + (1 - scale) * t})`,
  };
}

export function popOut(_node: Element, { duration = 140 }: { duration?: number } = {}): TransitionConfig {
  if (prefersReducedMotion()) return { duration: 0 };
  return { duration, easing: EASE_IN, css: (t) => `opacity:${t};transform:scale(${0.97 + 0.03 * t})` };
}

/** Svelte animate: keyed rows slide to their new place when a filter removes or reorders rows. */
export function listFlip(node: Element, fromTo: { from: DOMRect; to: DOMRect }): AnimationConfig {
  return flip(node, fromTo, { duration: prefersReducedMotion() ? 0 : 360, easing: cubicOut });
}

/**
 * Svelte action for a box sized by its content (a dialog that grows with its list): each new height
 * is reached with a glide instead of a jump. While it glides the box carries `is-gliding`, so it can
 * hide the overflow it would otherwise scroll for a moment.
 */
export function glideHeight(node: HTMLElement) {
  if (typeof ResizeObserver === "undefined") return;
  let settled = 0;
  let glide: Animation | null = null;
  const run = (from: number, to: number) => {
    const animation = animate(node, [{ height: `${from}px` }, { height: `${to}px` }], { duration: 480, easing: OUT_EASING });
    if (!animation) return;
    glide = animation;
    node.classList.add("is-gliding");
    animation.finished.catch(() => {}).finally(() => {
      if (glide !== animation) return;
      glide = null;
      node.classList.remove("is-gliding");
      // Content that changed during the glide gets its own glide from where this one landed.
      const now = node.offsetHeight;
      const landed = settled;
      settled = now;
      if (Math.abs(now - landed) >= 2 && !prefersReducedMotion()) run(landed, now);
    });
  };
  const observer = new ResizeObserver(() => {
    if (glide) return;
    const next = node.offsetHeight;
    const from = settled;
    settled = next;
    if (!from || Math.abs(next - from) < 2 || prefersReducedMotion()) return;
    run(from, next);
  });
  observer.observe(node);
  return {
    destroy() {
      observer.disconnect();
      const current = glide;
      glide = null;
      current?.cancel();
    },
  };
}

/** Startup handoff: the event the splash dispatches when its exit begins. */
export const SPLASH_EXIT_EVENT = "epigraph:splash-exit";

/**
 * Shared-element flight from the splash mark to the sidebar mark. A detached copy flies above the
 * dissolving splash while the real sidebar mark waits hidden, then takes over where the copy lands.
 * Returns false when there is nothing to fly to (first run, reduced motion).
 */
export function flyBrandMark(source: HTMLElement | null | undefined, target: HTMLElement | null | undefined, duration = 720): boolean {
  if (!source || !target || prefersReducedMotion()) return false;
  const from = source.getBoundingClientRect();
  const to = target.getBoundingClientRect();
  if (!from.width || !to.width) return false;
  const flyer = source.cloneNode(true) as HTMLElement;
  flyer.removeAttribute("class");
  flyer.setAttribute("aria-hidden", "true");
  Object.assign(flyer.style, {
    position: "fixed",
    left: `${from.left}px`,
    top: `${from.top}px`,
    width: `${from.width}px`,
    height: `${from.height}px`,
    margin: "0",
    objectFit: "contain",
    zIndex: "10000",
    pointerEvents: "none",
    transformOrigin: "0 0",
    filter: getComputedStyle(source).filter,
  });
  document.body.append(flyer);
  source.style.visibility = "hidden";
  const dx = to.left - from.left;
  const dy = to.top - from.top;
  const scale = to.width / from.width;
  const flight = animate(flyer, [
    { transform: "translate(0, 0) scale(1)", opacity: 1 },
    { transform: `translate(${dx * 0.55}px, ${dy * 0.35}px) scale(${0.55 + scale * 0.45}) rotate(-4deg)`, opacity: 1, offset: 0.55 },
    { transform: `translate(${dx}px, ${dy}px) scale(${scale})`, opacity: 1 },
  ], { duration, easing: OUT_EASING, fill: "forwards" });
  const landing = animate(target, [{ opacity: 0 }, { opacity: 0, offset: 0.88 }, { opacity: 1 }], { duration: duration + 120 });
  const finish = () => flyer.remove();
  if (flight) flight.onfinish = () => {
    animate(flyer, [{ opacity: 1 }, { opacity: 0 }], { duration: 140, fill: "forwards" })?.finished.then(finish, finish);
  };
  setTimeout(finish, duration + 600);
  return Boolean(landing || flight);
}

/**
 * The app's arrival behind the dissolving splash: the sidebar slides in, the topbar settles and the
 * page content rises block by block.
 */
export function playShellEntrance(root: ParentNode | null | undefined) {
  if (!root || prefersReducedMotion()) return;
  const sidebar = root.querySelector(".n-sidebar");
  if (sidebar) animate(sidebar, [
    { opacity: 0, transform: "translateX(-18px)", filter: "blur(4px)" },
    { opacity: 1, transform: "none", filter: "blur(0)" },
  ], { duration: 760, delay: 60, easing: SPRING_EASING, fill: "backwards" });
  root.querySelectorAll(".n-topbar").forEach((topbar) => {
    // Fixed topbars have no offsetParent; skip the ones inside kept-alive, inert pages instead.
    if (topbar.closest("[inert], [hidden]")) return;
    animate(topbar, [
      { opacity: 0, transform: "translateY(-10px)" },
      { opacity: 1, transform: "none" },
    ], { duration: 620, delay: 120, easing: SPRING_EASING, fill: "backwards" });
  });
  const page = root.querySelector(".main > .page-keepalive.is-front > *, .main > :not(.page-keepalive):not(.detail-layer), .first-run-shell");
  enterView(page, { delay: 180, y: 16, blur: 8 });
}

type ViewTransitionDocument = Document & {
  startViewTransition?: (update: () => void | Promise<void>) => { ready: Promise<void> };
};

/** Applies a theme change as a circle that grows from the pointer; falls back to an instant swap. */
export function revealThemeChange(apply: () => void | Promise<void>, origin?: { x: number; y: number }) {
  const doc = document as ViewTransitionDocument;
  if (!doc.startViewTransition || prefersReducedMotion() || !origin) {
    void apply();
    return;
  }
  try {
    const transition = doc.startViewTransition(() => apply());
    const radius = Math.hypot(Math.max(origin.x, innerWidth - origin.x), Math.max(origin.y, innerHeight - origin.y));
    transition.ready.then(() => {
      document.documentElement.animate(
        { clipPath: [`circle(0 at ${origin.x}px ${origin.y}px)`, `circle(${radius}px at ${origin.x}px ${origin.y}px)`] },
        { duration: 900, easing: OUT_EASING, pseudoElement: "::view-transition-new(root)" },
      );
    }).catch(() => {});
  } catch {
    void apply();
  }
}
