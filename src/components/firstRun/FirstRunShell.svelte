<script lang="ts">
  import type { Component, Snippet } from "svelte";
  import { getCurrentWindow } from "@tauri-apps/api/window";
  import { Check } from "phosphor-svelte";
  import epigraphMark from "../../assets/epigraph-splash-mark.png";
  import { pointerEffects, prefersReducedMotion } from "../../lib/motion/firstRunMotion";
  import WindowControlsInline from "../layout/WindowControlsInline.svelte";
  import "./firstRun.css";

  type ProgressItem = {
    label: string;
    icon: Component<{ size?: number; weight?: "regular" }>;
  };

  interface Props {
    progress: readonly ProgressItem[];
    activeProgressIndex: number;
    /** True on the final page: every step shows as done and the travelling highlight fades out. */
    complete?: boolean;
    subtitle: string;
    progressLabel: string;
    children: Snippet;
  }

  let { progress, activeProgressIndex, complete = false, subtitle, progressLabel, children }: Props = $props();

  let nav = $state<HTMLElement>();
  let list = $state<HTMLOListElement>();
  let sky = $state<HTMLCanvasElement>();
  let highlight = $state({ left: 0, width: 0, visible: false });

  function handleTitlebarPointerDown(event: PointerEvent) {
    if (event.button !== 0) return;
    const target = event.target;
    if (!(target instanceof Element) || target.closest("button, [data-no-window-drag]")) return;
    getCurrentWindow().startDragging().catch(() => {});
  }

  function placeHighlight() {
    const current = list?.querySelector<HTMLElement>('li[aria-current="step"]');
    if (!nav || !current) {
      highlight = { ...highlight, visible: false };
      return;
    }
    const label = current.querySelector<HTMLElement>(".first-run-progress-label");
    const icon = current.querySelector<HTMLElement>(".first-run-progress-icon");
    const end = label && getComputedStyle(label).position !== "absolute" ? label : icon;
    const navRect = nav.getBoundingClientRect();
    const start = current.getBoundingClientRect().left;
    const right = (end?.getBoundingClientRect().right ?? start) + 12;
    highlight = { left: start - navRect.left - 4, width: right - start + 4, visible: true };
  }

  $effect(() => {
    activeProgressIndex;
    complete;
    progress;
    queueMicrotask(placeHighlight);
  });

  $effect(() => {
    if (!list || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => placeHighlight());
    observer.observe(list);
    return () => observer.disconnect();
  });

  /* Quiet ambient light behind the steps, tinted by the theme accent. It stops when the app idles,
     the window hides or reduced motion is requested. */
  $effect(() => {
    const canvas = sky;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    let frame = 0;
    let running = false;
    let width = 0;
    let height = 0;
    // The accent is read from the theme at runtime; opacity is applied through globalAlpha.
    let tint = "";
    let light = false;
    let stars: { x: number; y: number; r: number; phase: number; speed: number }[] = [];
    const started = performance.now();
    const target = { x: 0.8, y: 0.1 };
    const position = { x: 0.8, y: 0.1 };

    const readTheme = () => {
      tint = getComputedStyle(canvas).color;
      // The page brightness comes from the shell: the canvas itself stays transparent.
      const surface = getComputedStyle(canvas.parentElement ?? document.body).backgroundColor;
      // Computed colors come back as sRGB channels in 0-255, or in 0-1 for the color(srgb ...) form.
      const scale = surface.startsWith("color(") ? 255 : 1;
      const background = (surface.match(/\d+(\.\d+)?/g) ?? ["0", "0", "0"]).slice(0, 3).map((channel) => Number(channel) * scale);
      light = (background[0] * 299 + background[1] * 587 + background[2] * 114) / 1000 > 140;
    };
    const resize = () => {
      const ratio = Math.min(devicePixelRatio || 1, 2);
      width = canvas.clientWidth;
      height = canvas.clientHeight;
      canvas.width = Math.max(1, Math.round(width * ratio));
      canvas.height = Math.max(1, Math.round(height * ratio));
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      stars = Array.from({ length: Math.round((width * height) / 12000) }, () => ({
        x: Math.random() * width,
        y: Math.random() * height,
        r: Math.random() * 0.9 + 0.2,
        phase: Math.random() * 6.28,
        speed: 0.3 + Math.random() * 0.9,
      }));
    };
    const draw = (now: number) => {
      const t = (now - started) / 1000;
      const step = Math.max(0, Math.min(activeProgressIndex, 4));
      target.x = 0.12 + step * 0.19;
      target.y = 0.08 + (step % 2) * 0.1;
      position.x += (target.x - position.x) * 0.025;
      position.y += (target.y - position.y) * 0.025;
      context.clearRect(0, 0, width, height);
      const strength = light ? 0.45 : 1;
      const glows: [number, number, number, number][] = [
        [position.x + Math.sin(t * 0.12) * 0.04, position.y + Math.cos(t * 0.1) * 0.03, 0.5, 0.055],
        [1 - position.x * 0.7 + Math.cos(t * 0.08) * 0.04, 0.95 - position.y * 0.3, 0.42, 0.03],
      ];
      for (const [x, y, radius, alpha] of glows) {
        const gradient = context.createRadialGradient(x * width, y * height, 0, x * width, y * height, radius * Math.max(width, height));
        gradient.addColorStop(0, tint);
        gradient.addColorStop(1, "transparent");
        context.globalAlpha = alpha * strength;
        context.fillStyle = gradient;
        context.fillRect(0, 0, width, height);
      }
      context.fillStyle = tint;
      if (!light) {
        for (const star of stars) {
          const twinkle = 0.3 + 0.7 * Math.abs(Math.sin(t * star.speed + star.phase));
          context.globalAlpha = 0.03 + twinkle * 0.11;
          context.beginPath();
          context.arc(star.x, star.y, star.r, 0, Math.PI * 2);
          context.fill();
        }
      }
      context.globalAlpha = 1;
      if (running) frame = requestAnimationFrame(draw);
    };
    const shouldRun = () => !prefersReducedMotion()
      && document.visibilityState === "visible"
      && document.documentElement.dataset.epigraphMotion !== "idle";
    const sync = () => {
      const next = shouldRun();
      if (next === running) return;
      running = next;
      cancelAnimationFrame(frame);
      if (running) {
        readTheme();
        frame = requestAnimationFrame(draw);
      }
    };
    resize();
    readTheme();
    draw(performance.now());
    sync();
    const resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => { resize(); draw(performance.now()); });
    resizeObserver?.observe(canvas);
    const themeObserver = new MutationObserver(() => { readTheme(); sync(); });
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-custom-theme", "style", "data-epigraph-motion"] });
    document.addEventListener("visibilitychange", sync);
    return () => {
      running = false;
      cancelAnimationFrame(frame);
      resizeObserver?.disconnect();
      themeObserver.disconnect();
      document.removeEventListener("visibilitychange", sync);
    };
  });
</script>

<main class="first-run-shell" use:pointerEffects>
  <canvas class="first-run-sky" bind:this={sky} aria-hidden="true"></canvas>
  <!-- svelte-ignore a11y_no_static_element_interactions: dragging an empty desktop titlebar is a native window interaction. -->
  <header
    class="first-run-titlebar"
    aria-label="Epigraph"
    data-tauri-drag-region
    onpointerdown={handleTitlebarPointerDown}
  >
    <div class="first-run-identity">
      <img class="first-run-mark" src={epigraphMark} alt="" />
      <strong>Epigraph</strong>
      <small>{subtitle}</small>
    </div>
    <WindowControlsInline variant="titlebar" />
  </header>

  <div class="first-run-body">
    <nav class="first-run-progress" aria-label={progressLabel} bind:this={nav}>
      <span
        class="first-run-progress-highlight"
        aria-hidden="true"
        style:left={`${highlight.left}px`}
        style:width={`${highlight.width}px`}
        style:opacity={highlight.visible && !complete ? 1 : 0}
      ></span>
      <ol bind:this={list}>
        {#each progress as item, index}
          {@const done = complete || index < activeProgressIndex}
          <li aria-current={!complete && index === activeProgressIndex ? "step" : undefined} class:is-complete={done}>
            <span class="first-run-progress-icon" aria-hidden="true">
              <span class="first-run-progress-symbol"><item.icon size={16} weight="regular" /></span>
              <span class="first-run-progress-check"><Check size={15} weight="bold" /></span>
            </span>
            <span class="first-run-progress-label">{item.label}</span>
            {#if index < progress.length - 1}<span class="first-run-progress-line" aria-hidden="true"><i></i></span>{/if}
          </li>
        {/each}
      </ol>
    </nav>

    <section class="first-run-workspace" aria-live="polite">
      {@render children()}
    </section>
  </div>
</main>

<style>
  .first-run-shell {
    --first-run-gutter: var(--app-shell-inline-pad, 32px);
    position: relative;
    isolation: isolate;
    container-type: inline-size;
    width: 100%;
    height: 100dvh;
    min-height: 0;
    display: grid;
    grid-template-rows: 56px minmax(0, 1fr);
    overflow: hidden;
    color: var(--text-primary);
    background: var(--component-app-bg);
    font-family: var(--font-ui, inherit);
  }

  .first-run-sky {
    position: absolute;
    inset: 0;
    z-index: 0;
    width: 100%;
    height: 100%;
    pointer-events: none;
    /* The canvas reads its tint from here. It must stay transparent: WebView2 composites a canvas
       with an opaque background above the content that follows it. */
    color: var(--accent);
  }

  .first-run-titlebar {
    position: relative;
    z-index: 2;
    min-width: 0;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 20px;
    padding: 0 8px 0 var(--first-run-gutter);
    background: var(--component-topbar-bg);
    border-bottom: 1px solid var(--component-topbar-border);
  }

  .first-run-identity {
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: var(--text-md);
    font-weight: 750;
  }

  .first-run-mark {
    width: 26px;
    height: 26px;
    object-fit: contain;
  }

  .first-run-identity small {
    color: var(--text-secondary);
    font-size: var(--text-base);
    font-weight: 500;
  }

  .first-run-body {
    position: relative;
    z-index: 1;
    min-height: 0;
    display: grid;
    grid-template-rows: auto minmax(0, 1fr);
    overflow: hidden;
  }

  .first-run-progress {
    position: relative;
    width: calc(100% - 2 * var(--first-run-gutter));
    margin: 0 auto;
    padding: 12px 0;
  }

  /* Steps sit at both edges of the content gutter with connectors between them, so the bar is
     symmetric at any width instead of five left-aligned columns. */
  .first-run-progress ol {
    position: relative;
    display: flex;
    align-items: center;
    gap: 12px;
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .first-run-progress-highlight {
    position: absolute;
    top: 50%;
    z-index: 0;
    height: 34px;
    margin-top: -17px;
    border-radius: 999px;
    background: var(--accent-muted);
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 20%, transparent);
    transition: left .7s var(--fr-spring), width .7s var(--fr-spring), opacity .4s;
    pointer-events: none;
  }

  .first-run-progress li {
    position: relative;
    z-index: 1;
    min-width: 0;
    min-height: 32px;
    flex: 1 1 0;
    display: flex;
    align-items: center;
    gap: 8px;
    color: var(--text-secondary);
    font-size: var(--text-base);
    font-weight: 600;
    white-space: nowrap;
    transition: color .4s;
  }

  .first-run-progress li:last-child { flex: 0 0 auto; }
  .first-run-progress li[aria-current="step"] { color: var(--text-primary); }

  .first-run-progress-line {
    flex: 1 1 auto;
    min-width: 16px;
    height: 2px;
    margin-left: 4px;
    overflow: hidden;
    border-radius: 2px;
    background: var(--border-base);
  }

  .first-run-progress-line i {
    display: block;
    height: 100%;
    background: linear-gradient(90deg, color-mix(in srgb, var(--color-success) 30%, transparent), var(--color-success));
    transform: scaleX(0);
    transform-origin: left;
    transition: transform .8s var(--fr-out);
  }

  .first-run-progress li.is-complete .first-run-progress-line i { transform: scaleX(1); }

  .first-run-progress-icon {
    position: relative;
    width: 28px;
    height: 28px;
    flex: 0 0 auto;
    display: grid;
    place-items: center;
    border-radius: 50%;
    color: inherit;
    transition: color .4s;
  }

  .first-run-progress-icon > span {
    position: absolute;
    display: grid;
    place-items: center;
    transition: opacity .3s, transform .6s var(--fr-bounce);
  }

  .first-run-progress-check { opacity: 0; transform: scale(.3) rotate(-30deg); }
  .first-run-progress li[aria-current="step"] .first-run-progress-icon { color: var(--accent-fg); }
  .first-run-progress li.is-complete .first-run-progress-icon { color: var(--color-success); }
  .first-run-progress li.is-complete .first-run-progress-check { opacity: 1; transform: none; }
  .first-run-progress li.is-complete .first-run-progress-symbol { opacity: 0; transform: scale(.3) rotate(30deg); }

  .first-run-workspace {
    min-height: 0;
    position: relative;
    overflow: hidden;
  }

  @media (max-width: 900px) {
    .first-run-progress ol { gap: 6px; }
    .first-run-progress li,
    .first-run-progress li:last-child { flex: 1 1 0; display: grid; grid-template-columns: 1fr; justify-items: center; gap: 4px; }
    .first-run-progress-line { display: none; }
    .first-run-progress-icon { width: 34px; }
    .first-run-progress-highlight { display: none; }
  }

  @media (max-width: 560px) {
    .first-run-titlebar { padding-left: 16px; }
    .first-run-identity small { display: none; }
    .first-run-progress-label {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip-path: inset(50%);
      white-space: nowrap;
    }
  }
</style>
