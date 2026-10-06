<script lang="ts">
  import { _ } from "../../lib/i18n/runtime";
  import { onMount } from "svelte";
  import { store } from "../../store/state.svelte";
  import splashMarkUrl from "../../assets/epigraph-splash-mark.png";
  import { flyBrandMark, prefersReducedMotion, SPLASH_EXIT_EVENT } from "../../lib/motion/motion";

  interface Props {
    mode?: "loading" | "idle";
    interactive?: boolean;
    ringFull?: boolean;
    failed?: boolean;
    notConfigured?: boolean;
    failureTitle?: string;
    failureDetail?: string;
    statusText?: string;
    showCards?: boolean;
    showFps?: boolean;
    onReady?: () => void;
    onRetry?: () => void;
    onBypass?: () => void;
    onDismiss?: () => void;
  }

  let {
    mode = "loading",
    interactive = true,
    ringFull = false,
    failed = false,
    notConfigured = false,
    failureTitle,
    failureDetail = "",
    statusText,
    showCards = true,
    showFps = false,
    onReady,
    onRetry,
    onBypass,
    onDismiss,
  }: Props = $props();

  type AmbientBandOptions = {
    size: [number, number];
    peak: [number, number];
    base: [number, number];
    life: [number, number];
    drift: [number, number];
    ray: [number, number];
  };

  type AmbientStarConfig = {
    size: number;
    x: number;
    y: number;
    dx: number;
    dy: number;
    moveDuration: number;
    moveOffset: number;
    life: number;
    offset: number;
    peak: number;
    base: number;
    ray: number;
    spin: number;
    rotation: number;
  };

  type OrbitConfig = {
    size: number;
    rx: number;
    ry: number;
    tilt: number;
    phase: number;
    speed: number;
    depthPhase: number;
    driftX: number;
    driftY: number;
    life: number;
    offset: number;
    peak: number;
    minScale: number;
    maxScale: number;
    ray: number;
  };

  type MountedStar<T> = {
    element: HTMLSpanElement;
    config: T;
  };

  // The exit dissolves the splash while the app arrives beneath it; the splash no longer takes
  // pointer input once the app is ready, so the longer handoff never blocks interaction.
  const EXIT_MS = 620;
  const POST_READY_DWELL_MS = 180;
  const PIN_REVEAL_MS = 400;

  const ORBIT_CONFIGS: OrbitConfig[] = [
    { size: 8.6, rx: 150, ry: 44, tilt: -24, phase: 0.2, speed: 0.00009, depthPhase: 0.6, driftX: 8, driftY: -4, life: 7_800, offset: 500, peak: 0.54, minScale: 0.2, maxScale: 1.02, ray: 0.62 },
    { size: 6.2, rx: 76, ry: 158, tilt: 13, phase: 2.5, speed: -0.000069, depthPhase: -0.3, driftX: -7, driftY: 9, life: 12_500, offset: 4_200, peak: 0.36, minScale: 0.16, maxScale: 0.72, ray: 0.42 },
    { size: 10.8, rx: 174, ry: 52, tilt: -55, phase: 1.15, speed: 0.000058, depthPhase: 1.5, driftX: 12, driftY: 6, life: 9_300, offset: 2_100, peak: 0.48, minScale: 0.22, maxScale: 1.12, ray: 0.72 },
    { size: 7.4, rx: 92, ry: 136, tilt: 38, phase: 4.35, speed: -0.000082, depthPhase: 2.2, driftX: -9, driftY: 5, life: 14_200, offset: 8_200, peak: 0.4, minScale: 0.18, maxScale: 0.82, ray: 0.5 },
    { size: 4.8, rx: 198, ry: 34, tilt: 17, phase: 5.7, speed: 0.000046, depthPhase: -1.15, driftX: 5, driftY: -9, life: 16_000, offset: 9_900, peak: 0.28, minScale: 0.13, maxScale: 0.55, ray: 0.32 },
    { size: 6.8, rx: 61, ry: 176, tilt: -20, phase: 3.25, speed: 0.000078, depthPhase: 2.75, driftX: 12, driftY: 8, life: 10_400, offset: 6_600, peak: 0.35, minScale: 0.16, maxScale: 0.74, ray: 0.46 },
    { size: 9.8, rx: 136, ry: 82, tilt: 63, phase: 4.9, speed: -0.000054, depthPhase: -2.2, driftX: -8, driftY: -5, life: 11_800, offset: 1_700, peak: 0.45, minScale: 0.2, maxScale: 1, ray: 0.66 },
    { size: 4.2, rx: 208, ry: 60, tilt: -8, phase: 2, speed: 0.000036, depthPhase: 0.1, driftX: -4, driftY: 10, life: 18_500, offset: 12_100, peak: 0.24, minScale: 0.1, maxScale: 0.5, ray: 0.3 },
    { size: 6.4, rx: 118, ry: 112, tilt: -68, phase: 5.05, speed: 0.000064, depthPhase: 1.85, driftX: 8, driftY: -12, life: 10_900, offset: 3_400, peak: 0.34, minScale: 0.15, maxScale: 0.7, ray: 0.4 },
    { size: 5.6, rx: 154, ry: 104, tilt: 27, phase: 3.7, speed: -0.000041, depthPhase: -0.9, driftX: -12, driftY: 4, life: 15_300, offset: 10_700, peak: 0.31, minScale: 0.12, maxScale: 0.62, ray: 0.36 },
  ];

  const lockEnabled = $derived(
    store.settings.appLockEnabled && (store.settings.appLockPin?.length ?? 0) >= 4,
  );
  const pinLength = $derived(store.settings.appLockPin?.length ?? 4);
  const canDismissIdle = $derived(mode === "idle" && !!onDismiss && !lockEnabled);

  let splashRoot = $state<HTMLElement | null>(null);
  let starfieldEl = $state<HTMLDivElement | null>(null);
  let orbitBackEl = $state<HTMLDivElement | null>(null);
  let orbitFrontEl = $state<HTMLDivElement | null>(null);
  let pinEntry = $state("");
  let pinShake = $state(false);
  let pinUnlocked = $state(false);
  let pinVisible = $state(false);
  let exiting = $state(false);
  let retryAnnouncement = $state(false);
  let fpsText = $state("");
  let exitLock = false;

  function mulberry32(seed: number) {
    return function next() {
      let t = seed += 0x6d2b79f5;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function clamp(value: number, min: number, max: number) {
    return Math.min(max, Math.max(min, value));
  }

  function easeOutCubic(value: number) {
    return 1 - Math.pow(1 - clamp(value, 0, 1), 3);
  }

  function randomBetween(next: () => number, min: number, max: number) {
    return min + next() * (max - min);
  }

  function sparkleLife(
    timestamp: number,
    duration: number,
    offset: number,
    attack: number,
    hold: number,
    decay: number,
  ) {
    const phase = ((timestamp + offset) % duration) / duration;
    const start = 0.48;
    const local = phase >= start ? phase - start : phase + 1 - start;
    if (local > attack + hold + decay) return 0;
    if (local < attack) return easeOutCubic(local / attack);
    if (local < attack + hold) return 1;
    const release = (local - attack - hold) / decay;
    return Math.pow(1 - release, 1.85);
  }

  function createStarElement(className: "ambient-star" | "orbit-star", size: number) {
    const element = document.createElement("span");
    element.className = className;
    element.style.setProperty("--size", `${size.toFixed(2)}px`);
    element.innerHTML = `
      <span class="star-ray-x"></span>
      <span class="star-ray-y"></span>
      <span class="star-core"></span>
      <span class="star-dust"></span>
    `;
    return element;
  }

  function createAmbientBand(count: number, options: AmbientBandOptions, next: () => number): AmbientStarConfig[] {
    return Array.from({ length: count }, () => {
      const drift = randomBetween(next, options.drift[0], options.drift[1]);
      const direction = randomBetween(next, 0, Math.PI * 2);
      return {
        size: randomBetween(next, options.size[0], options.size[1]),
        x: randomBetween(next, 4, 96),
        y: randomBetween(next, 6, 93),
        dx: Math.cos(direction) * drift,
        dy: Math.sin(direction) * drift,
        moveDuration: randomBetween(next, 90_000, 240_000),
        moveOffset: randomBetween(next, 0, 240_000),
        life: randomBetween(next, options.life[0], options.life[1]),
        offset: randomBetween(next, 0, options.life[1]),
        peak: randomBetween(next, options.peak[0], options.peak[1]),
        base: randomBetween(next, options.base[0], options.base[1]),
        ray: randomBetween(next, options.ray[0], options.ray[1]),
        spin: randomBetween(next, -0.00018, 0.00018),
        rotation: randomBetween(next, -Math.PI, Math.PI),
      };
    });
  }

  function updateAmbientStars(stars: MountedStar<AmbientStarConfig>[], timestamp: number) {
    for (const { element, config } of stars) {
      const move = ((timestamp + config.moveOffset) % config.moveDuration) / config.moveDuration;
      const driftEase = move < 0.82 ? move / 0.82 : 1 - (move - 0.82) / 0.18;
      const x = config.dx * driftEase;
      const y = config.dy * driftEase;
      const life = sparkleLife(timestamp, config.life, config.offset, 0.06, 0.16, 0.42);
      const opacity = config.base + life * config.peak;
      const scale = 0.62 + life * 0.55;
      const rotate = config.rotation + timestamp * config.spin;

      element.style.opacity = opacity.toFixed(3);
      element.style.transform = `translate3d(${x.toFixed(2)}px, ${y.toFixed(2)}px, 0) rotate(${rotate.toFixed(3)}rad) scale3d(${scale.toFixed(3)}, ${scale.toFixed(3)}, 1)`;
      element.style.setProperty("--core", (0.42 + life * 0.58).toFixed(3));
      element.style.setProperty("--ray", (life * config.ray).toFixed(3));
      element.style.setProperty("--dust", (life * 0.1).toFixed(3));
      element.style.setProperty("--ray-x", (0.55 + life * 0.8).toFixed(3));
      element.style.setProperty("--ray-y", (0.65 + life * 1.05).toFixed(3));
    }
  }

  function projectOrbit(config: OrbitConfig, timestamp: number) {
    const angle = config.phase + timestamp * config.speed;
    const tilt = (config.tilt * Math.PI) / 180;
    const rx = config.rx * (1 + Math.sin(angle * 1.73 + config.phase) * 0.045);
    const ry = config.ry * (1 + Math.cos(angle * 1.29 - config.depthPhase) * 0.065);
    const localX = Math.cos(angle) * rx + Math.sin(angle * 0.37 + config.phase) * config.driftX;
    const localY = Math.sin(angle) * ry + Math.cos(angle * 0.61 - config.phase) * config.driftY;
    const x = localX * Math.cos(tilt) - localY * Math.sin(tilt);
    const y = localX * Math.sin(tilt) + localY * Math.cos(tilt);
    const depth = clamp(
      Math.sin(angle + config.depthPhase) * 0.74
        + Math.cos(angle * 1.8 + config.phase) * 0.16
        + Math.sin(timestamp * 0.000044 + config.depthPhase) * 0.1,
      -1,
      1,
    );
    const depth01 = (depth + 1) / 2;
    const front = depth > -0.06;
    const life = sparkleLife(timestamp, config.life, config.offset, 0.08, 0.12, 0.46);
    const presence = front ? 0.34 + depth01 * 0.66 : 0.04 + depth01 * 0.24;
    const opacity = life * config.peak * presence;
    const scale = (config.minScale + depth01 * (config.maxScale - config.minScale)) * (front ? 1 : 0.68);
    const rotate = angle * 0.62 + tilt + Math.sin(timestamp * 0.00024 + config.phase) * 0.22;
    const material = life * (front ? 1 : 0.44);

    return {
      x,
      y,
      front,
      opacity,
      scale,
      rotate,
      core: 0.34 + material * (front ? 0.58 : 0.26),
      ray: material * config.ray * (front ? 0.78 : 0.28),
      dust: material * 0.12,
      rayX: 0.62 + material * 0.7,
      rayY: 0.72 + material * 1.05,
    };
  }

  function updateOrbitStars(
    stars: MountedStar<OrbitConfig>[],
    orbitBack: HTMLDivElement,
    orbitFront: HTMLDivElement,
    timestamp: number,
  ) {
    for (const { element, config } of stars) {
      const projected = projectOrbit(config, timestamp);
      const parent = projected.front ? orbitFront : orbitBack;
      if (element.parentElement !== parent) {
        parent.append(element);
      }

      element.style.opacity = projected.opacity.toFixed(3);
      element.style.transform = `translate3d(calc(-50% + ${projected.x.toFixed(2)}px), calc(-50% + ${projected.y.toFixed(2)}px), 0) rotate(${projected.rotate.toFixed(3)}rad) scale3d(${projected.scale.toFixed(3)}, ${projected.scale.toFixed(3)}, 1)`;
      element.style.setProperty("--core", projected.core.toFixed(3));
      element.style.setProperty("--ray", projected.ray.toFixed(3));
      element.style.setProperty("--dust", projected.dust.toFixed(3));
      element.style.setProperty("--ray-x", projected.rayX.toFixed(3));
      element.style.setProperty("--ray-y", projected.rayY.toFixed(3));
    }
  }

  const visualState = $derived.by(() => {
    if (failed || notConfigured) return "error";
    if (mode === "idle") return lockEnabled && !pinUnlocked ? "pin" : "idle";
    if (ringFull) {
      if (lockEnabled && !pinUnlocked) return pinVisible ? "pin" : "loading";
      return "idle";
    }
    return "loading";
  });

  const loadingLabel = $derived(ringFull ? $_("ui_ready") : (statusText || $_("startup_initializing")));
  const failureLabel = $derived(
    notConfigured
      ? (failureTitle || $_("startup_notConfigured"))
      : (failureTitle || $_("startup_connectionInterrupted")),
  );
  const politeAnnouncement = $derived.by(() => {
    if (retryAnnouncement) return $_("startup_retrying");
    if (failed || notConfigured) return "";
    if (visualState === "pin") return $_("ui_pinRequired");
    if (visualState === "idle") return $_("ui_ready");
    return loadingLabel;
  });
  const assertiveAnnouncement = $derived(
    failed || notConfigured
      ? `${failureLabel}${failureDetail ? `. ${failureDetail}` : ""}`
      : "",
  );

  function triggerExit(callback?: () => void) {
    if (exitLock) return;
    exitLock = true;
    // The mark flies to its place in the sidebar (when the app shell is there) as the rest dissolves.
    flyBrandMark(splashRoot?.querySelector<HTMLElement>(".brand-mark"), document.querySelector<HTMLElement>(".n-sidebar__brand img"));
    exiting = true;
    window.dispatchEvent(new CustomEvent(SPLASH_EXIT_EVENT));
    window.setTimeout(() => callback?.(), EXIT_MS);
  }

  function clearPinShakeLater() {
    window.setTimeout(() => {
      pinShake = false;
    }, 500);
  }

  function submitPin() {
    if (pinEntry === store.settings.appLockPin) {
      pinUnlocked = true;
      pinEntry = "";
      if (mode === "idle") {
        triggerExit(onDismiss);
      } else {
        triggerExit(onReady);
      }
      return;
    }

    pinShake = true;
    pinEntry = "";
    clearPinShakeLater();
  }

  function handlePinKeydown(event: KeyboardEvent) {
    if (event.key === "Enter") {
      submitPin();
      return;
    }
    if (event.key === "Backspace") {
      pinEntry = pinEntry.slice(0, -1);
      return;
    }
    if (/^\d$/.test(event.key)) {
      pinEntry = (pinEntry + event.key).slice(0, 8);
      if (pinEntry.length >= pinLength) {
        submitPin();
      }
    }
  }

  function handleRetry() {
    retryAnnouncement = true;
    onRetry?.();
  }

  function handleBypass() {
    onBypass?.();
  }

  function dismissIdle() {
    if (!canDismissIdle) return;
    triggerExit(onDismiss);
  }

  function handleIdleKeydown(event: KeyboardEvent) {
    if (!canDismissIdle) return;
    if (["Shift", "Control", "Alt", "Meta", "CapsLock", "Tab"].includes(event.key)) return;
    dismissIdle();
  }

  $effect(() => {
    if (!retryAnnouncement) return;
    const timeout = window.setTimeout(() => {
      retryAnnouncement = false;
    }, 1400);
    return () => window.clearTimeout(timeout);
  });

  $effect(() => {
    const needsPin =
      (mode === "idle" && lockEnabled && !pinUnlocked) ||
      (mode === "loading" && lockEnabled && ringFull && !pinUnlocked);

    if (!needsPin) {
      pinVisible = false;
      return;
    }

    if (mode === "idle") {
      pinVisible = true;
      return;
    }

    const timeout = window.setTimeout(() => {
      pinVisible = true;
    }, PIN_REVEAL_MS);

    return () => window.clearTimeout(timeout);
  });

  $effect(() => {
    if (visualState !== "pin") return;
    window.addEventListener("keydown", handlePinKeydown);
    return () => window.removeEventListener("keydown", handlePinKeydown);
  });

  $effect(() => {
    if (mode !== "loading" || !ringFull || failed || notConfigured) return;
    if (lockEnabled && !pinUnlocked) return;

    const timeout = window.setTimeout(() => {
      triggerExit(onReady);
    }, POST_READY_DWELL_MS);

    return () => window.clearTimeout(timeout);
  });

  $effect(() => {
    if (!canDismissIdle) return;

    const timeout = window.setTimeout(() => {
      splashRoot?.focus();
    }, 50);

    window.addEventListener("keydown", handleIdleKeydown);

    return () => {
      window.clearTimeout(timeout);
      window.removeEventListener("keydown", handleIdleKeydown);
    };
  });

  $effect(() => {
    if (!showCards || !starfieldEl || !orbitBackEl || !orbitFrontEl) {
      fpsText = "";
      return;
    }
    const starfield = starfieldEl;
    const orbitBack = orbitBackEl;
    const orbitFront = orbitFrontEl;

    const random = mulberry32(0xa37a0e);
    const ambientConfigs = [
      ...createAmbientBand(56, { size: [1.2, 3.2], peak: [0.08, 0.3], base: [0, 0.035], life: [10_000, 32_000], drift: [3, 16], ray: [0.18, 0.42] }, random),
      ...createAmbientBand(22, { size: [3.4, 6.2], peak: [0.14, 0.46], base: [0, 0.025], life: [18_000, 44_000], drift: [5, 24], ray: [0.28, 0.62] }, random),
      ...createAmbientBand(7, { size: [6.4, 9.4], peak: [0.16, 0.36], base: [0, 0.018], life: [30_000, 62_000], drift: [4, 18], ray: [0.34, 0.72] }, random),
    ];

    const ambientStars: MountedStar<AmbientStarConfig>[] = ambientConfigs.map((config) => {
      const element = createStarElement("ambient-star", config.size);
      element.style.setProperty("--x", `${config.x.toFixed(2)}%`);
      element.style.setProperty("--y", `${config.y.toFixed(2)}%`);
      starfield.append(element);
      return { element, config };
    });

    const orbitStars: MountedStar<OrbitConfig>[] = ORBIT_CONFIGS.map((config) => {
      const element = createStarElement("orbit-star", config.size);
      orbitBack.append(element);
      return { element, config };
    });

    // With animations off (app switch or Windows setting) the stars are placed once and stay still.
    if (prefersReducedMotion()) {
      const now = performance.now();
      updateAmbientStars(ambientStars, now);
      updateOrbitStars(orbitStars, orbitBack, orbitFront, now);
      return () => {
        for (const { element } of ambientStars) {
          element.remove();
        }
        for (const { element } of orbitStars) {
          element.remove();
        }
      };
    }

    let animationFrame = 0;
    let lastFrame = 0;
    let fpsLast = performance.now();
    let fpsFrames = 0;

    const animate = (timestamp: number) => {
      if (timestamp - lastFrame > 32) {
        updateAmbientStars(ambientStars, timestamp);
        updateOrbitStars(orbitStars, orbitBack, orbitFront, timestamp);
        lastFrame = timestamp;

        if (showFps) {
          fpsFrames += 1;
          if (timestamp - fpsLast >= 500) {
            fpsText = `${Math.round(fpsFrames / ((timestamp - fpsLast) / 1000))} fps`;
            fpsFrames = 0;
            fpsLast = timestamp;
          }
        }
      }
      animationFrame = requestAnimationFrame(animate);
    };

    animationFrame = requestAnimationFrame(animate);

    return () => {
      window.cancelAnimationFrame(animationFrame);
      fpsText = "";
      for (const { element } of ambientStars) {
        element.remove();
      }
      for (const { element } of orbitStars) {
        element.remove();
      }
    };
  });

  onMount(() => {
    let mountedRaf = requestAnimationFrame(() => {
      mountedRaf = requestAnimationFrame(() => {
        window.dispatchEvent(new CustomEvent("epigraph:splash-mounted"));
      });
    });

    return () => {
      window.cancelAnimationFrame(mountedRaf);
    };
  });
</script>

{#snippet SplashContent()}
  <div class="epigraph-splash__sr" aria-live="polite" aria-atomic="true">{politeAnnouncement}</div>
  {#if assertiveAnnouncement}
    <div class="epigraph-splash__sr" role="alert">{assertiveAnnouncement}</div>
  {/if}

  {#if showFps && fpsText}
    <span class="epigraph-splash__fps">{fpsText}</span>
  {/if}

  {#if showCards}
    <div class="manual-starfield" bind:this={starfieldEl} aria-hidden="true"></div>
  {/if}

  <i class="corner tl" aria-hidden="true"></i>
  <i class="corner tr" aria-hidden="true"></i>
  <i class="corner br" aria-hidden="true"></i>
  <i class="corner bl" aria-hidden="true"></i>

  <div class="identity" aria-hidden="true">
    {#if showCards}
      <div class="orbit-layer back" bind:this={orbitBackEl}></div>
    {/if}

    <img class="brand-mark" src={splashMarkUrl} alt="" />

    {#if showCards}
      <div class="orbit-layer front" bind:this={orbitFrontEl}></div>
    {/if}
  </div>

  <div class="state-dock" aria-label={$_("ui_splashState")}>
    <div class="state loading">
      <div class="state-value">{loadingLabel}</div>
      <div class="line" aria-hidden="true"><span></span></div>
    </div>

    <div class="state idle">
      <div class="state-value">{$_("ui_ready")}</div>
      <div class="line" aria-hidden="true"></div>
      {#if canDismissIdle}
        <div class="epigraph-splash__hint">{$_("ui_pressAnyKey")}</div>
      {/if}
    </div>

    <div class="state pin">
      <div class="state-value">{$_("ui_pinRequired")}</div>
      <div class="dots pin-dots" class:is-shake={pinShake} aria-hidden="true">
        {#each Array(pinLength) as _, index}
          <i class="pin-dot" class:is-filled={index < pinEntry.length}></i>
        {/each}
      </div>
      <button
        type="button"
        class="epigraph-splash__hidden-submit"
        tabindex="-1"
        aria-label={$_("ui_submitPin")}
        onclick={submitPin}
      >
        {$_("ui_unlock")}
      </button>
    </div>

    <div class="state error">
      <div class="state-value">{failureLabel}</div>
      {#if failureDetail}
        <div>{failureDetail}</div>
      {/if}
      <div class="error-actions">
        <button type="button" class="error-action" onclick={handleRetry}>{$_("downloads_actions_retry")}</button>
        <button type="button" class="error-action error-action--primary" onclick={handleBypass}>{$_("ui_enterApp")}</button>
      </div>
    </div>
  </div>
{/snippet}

{#if canDismissIdle}
  <button
    type="button"
    class="epigraph-port--splash splash-stage"
    data-theme="nocturne"
    class:is-exiting={exiting}
    data-state={visualState}
    style:pointer-events={interactive ? "auto" : "none"}
    bind:this={splashRoot}
    aria-label={$_("ui_dismissSplashScreen")}
    onclick={dismissIdle}
    onkeydown={handleIdleKeydown}
  >
    {@render SplashContent()}
  </button>
{:else}
  <div
    class="epigraph-port--splash splash-stage"
    data-theme="nocturne"
    class:is-exiting={exiting}
    data-state={visualState}
    style:pointer-events={interactive ? "auto" : "none"}
    bind:this={splashRoot}
    aria-label={$_("ui_epigraphSplashScreen")}
  >
    {@render SplashContent()}
  </div>
{/if}
