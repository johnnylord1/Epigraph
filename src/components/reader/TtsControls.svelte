<script lang="ts">
  import { _ } from "../../lib/i18n/runtime";
  import { CaretLeft, CaretRight, Pause, Play, SpeakerHigh, Stop } from "phosphor-svelte";
  import type { createTtsController } from "../../lib/reader/tts";

  type TtsController = ReturnType<typeof createTtsController>;

  type Props = {
    controller: TtsController;
    onback?: () => void;
  };

  let { controller, onback }: Props = $props();
  let stateVersion = $state(0);
  const TTS_PREFERENCES_KEY = "aethon-tts-preferences-v1";

  function readPreferences() {
    try {
      const parsed = JSON.parse(localStorage.getItem(TTS_PREFERENCES_KEY) ?? "{}");
      return {
        rate: typeof parsed.rate === "number" ? parsed.rate : null,
        voice: typeof parsed.voice === "string" ? parsed.voice : null,
      };
    } catch {
      return { rate: null, voice: null };
    }
  }

  function savePreferences(patch: { rate?: number; voice?: string }) {
    const current = readPreferences();
    try {
      localStorage.setItem(TTS_PREFERENCES_KEY, JSON.stringify({
        rate: patch.rate ?? current.rate ?? 1,
        voice: patch.voice ?? current.voice ?? "",
      }));
    } catch {
      // TTS remains usable when storage is unavailable.
    }
  }

  function setPlaybackRate(rate: number) {
    controller.setRate(rate);
    savePreferences({ rate });
  }

  function setSelectedVoice(voice: string) {
    controller.setVoice(voice);
    savePreferences({ voice });
  }

  $effect(() => {
    const unsubscribe = controller.subscribe(() => {
      stateVersion += 1;
    });
    return unsubscribe;
  });

  let preferencesRestored = false;
  $effect(() => {
    if (preferencesRestored) return;
    preferencesRestored = true;
    const preferences = readPreferences();
    if (preferences.rate !== null) controller.setRate(preferences.rate);
    if (preferences.voice !== null) controller.setVoice(preferences.voice);
  });

  const state = $derived.by(() => {
    stateVersion;
    return controller.state;
  });
  const isPlaying = $derived.by(() => {
    stateVersion;
    return controller.state.isPlaying;
  });
  const playbackRate = $derived.by(() => {
    stateVersion;
    return controller.state.playbackRate;
  });
  const selectedVoice = $derived.by(() => {
    stateVersion;
    return controller.state.selectedVoice;
  });
  const voices = $derived.by(() => {
    stateVersion;
    return controller.state.voices;
  });
  const currentSegmentIndex = $derived.by(() => {
    stateVersion;
    return controller.state.currentSegmentIndex;
  });
  const supported = $derived.by(() => {
    stateVersion;
    return controller.state.supported;
  });
  const hasProvider = $derived.by(() => {
    stateVersion;
    return controller.state.hasProvider;
  });
  const segmentCount = $derived.by(() => {
    stateVersion;
    return controller.state.segmentCount;
  });
  const disabled = $derived(!supported || !hasProvider || segmentCount === 0);
  const voiceLabel = $derived(voices.length ? $_("ui_voice") : $_("ui_voicesUnavailable"));
</script>

<div class="tts-panel" aria-label={$_("ui_textToSpeechControls")}>
  <!-- Header with back button -->
  {#if onback}
    <div class="tts-header">
      <button class="tts-back-btn" onclick={onback} title={$_("ui_backToSettings")}>
        <CaretLeft size={14} weight="bold" />
        <span>{$_("ui_back")}</span>
      </button>
      <span class="tts-title">{$_("ui_textToSpeech")}</span>
    </div>
  {/if}

  <!-- Playback Button Row -->
  <div class="tts-row tts-playback-row">
    <button
      class="tts-btn tts-btn--primary"
      type="button"
      onclick={() => isPlaying ? controller.pause() : controller.play()}
      disabled={disabled}
      aria-label={isPlaying ? $_("ui_pauseReadingAloud") : $_("ui_playReadingAloud")}
      title={isPlaying ? $_("ui_pause") : $_("ui_play")}
    >
      {#if isPlaying}
        <Pause size={15} weight="fill" />
      {:else}
        <Play size={15} weight="fill" />
      {/if}
    </button>
    <button class="tts-btn" type="button" onclick={controller.stop} disabled={disabled} aria-label={$_("ui_stopReading")} title={$_("ui_stop")}>
      <Stop size={15} weight="fill" />
    </button>
    <button class="tts-btn" type="button" onclick={controller.previous} disabled={disabled} aria-label={$_("ui_previousParagraph")} title={$_("ui_previous")}>
      <CaretLeft size={15} weight="bold" />
    </button>
    <button class="tts-btn" type="button" onclick={controller.next} disabled={disabled} aria-label={$_("ui_nextParagraph")} title={$_("library_pagination_next")}>
      <CaretRight size={15} weight="bold" />
    </button>
  </div>

  <!-- Settings rows -->
  <div class="tts-settings-list">
    <div class="tts-settings-row">
      <span class="tts-settings-label">{$_("downloads_summary_speed")}</span>
      <div class="tts-speed-control">
        <span class="tts-speed-val">{playbackRate.toFixed(1)}x</span>
        <input
          type="range"
          class="tts-range-input"
          min={0.5}
          max={2.5}
          step={0.1}
          value={playbackRate}
          oninput={(event) => setPlaybackRate(Number(event.currentTarget.value))}
          disabled={!supported}
          aria-label={$_("ui_playbackSpeed")}
        />
      </div>
    </div>

    <div class="tts-settings-row">
      <span class="tts-settings-label">{$_("ui_voice")}</span>
      <div class="tts-voice-control">
        <SpeakerHigh size={14} weight="regular" style="margin-right: 2px;" />
        <select
          class="tts-select"
          value={selectedVoice}
          onchange={(event) => setSelectedVoice(event.currentTarget.value)}
          disabled={!supported || voices.length === 0}
          aria-label={$_("ui_speechVoice")}
        >
          <option value="">{$_("ui_systemVoice")}</option>
          {#each voices as voice}
            <option value={voice.name}>{voice.name}</option>
          {/each}
        </select>
      </div>
    </div>

    <div class="tts-settings-row">
      <span class="tts-settings-label">{$_("downloads_summary_status")}</span>
      {#if !supported}
        <span class="tts-status-val">{$_("ui_unavailable")}</span>
      {:else if !hasProvider || segmentCount === 0}
        <span class="tts-status-val">{$_("ui_noText")}</span>
      {:else}
        <span class="tts-status-val">{Math.min(currentSegmentIndex + 1, segmentCount)} / {segmentCount}</span>
      {/if}
    </div>
  </div>
</div>

<style>
  .tts-panel {
    --tts-reader-text: var(--reader-text, var(--component-reader-fg));
    --tts-reader-muted: var(--reader-muted, var(--component-reader-muted-fg));
    --tts-reader-accent: var(--reader-accent, var(--component-reader-accent-fg));
    --tts-reader-accent-dim: var(--reader-accent-dim, var(--component-reader-accent-muted-bg));
    --tts-reader-accent-bright: var(--reader-accent-bright, var(--component-reader-accent-strong-fg));
    --tts-reader-line: var(--reader-line, var(--component-reader-border));
    --tts-reader-line-hover: var(--reader-line-hover, var(--component-reader-border-hover));
    --tts-reader-divider: var(--reader-divider, var(--component-reader-divider));
    --tts-reader-control-bg: var(--reader-control-bg, var(--component-reader-control-bg));
    --tts-reader-control-hover-bg: var(--reader-control-hover-bg, var(--component-reader-control-hover-bg));
    --tts-reader-control-active-bg: var(--reader-control-active-bg, var(--component-reader-control-active-bg));
    --tts-reader-track-bg: var(--reader-track-bg, var(--component-reader-control-track-bg));
    --tts-reader-focus-ring: var(--reader-focus-ring, var(--component-reader-focus-ring));
    display: flex;
    flex-direction: column;
    gap: 12px;
    width: 100%;
  }

  .tts-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding-bottom: 8px;
    border-bottom: 1px solid var(--tts-reader-line);
  }

  .tts-back-btn {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    background: transparent;
    border: 0;
    color: var(--tts-reader-accent-bright);
    font-size: 11px;
    font-weight: 600;
    cursor: pointer;
    padding: 0;
    transition: opacity var(--component-reader-transition-fast);
  }

  .tts-back-btn:hover {
    opacity: 0.8;
  }

  .tts-back-btn:focus-visible,
  .tts-btn:focus-visible,
  .tts-range-input:focus-visible,
  .tts-select:focus-visible {
    outline: 0;
    box-shadow: var(--tts-reader-focus-ring);
  }

  .tts-title {
    font-size: 11px;
    font-weight: 600;
    color: var(--tts-reader-muted);
  }

  .tts-playback-row {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
    padding: 6px 0;
  }

  .tts-btn {
    display: grid;
    place-items: center;
    width: 32px;
    height: 32px;
    border: 1px solid var(--tts-reader-line);
    border-radius: var(--component-reader-control-radius);
    background: var(--tts-reader-control-bg);
    color: var(--tts-reader-muted);
    cursor: pointer;
    transition:
      color var(--component-reader-transition-fast),
      border-color var(--component-reader-transition-fast),
      background var(--component-reader-transition-fast);
  }

  .tts-btn:hover:not(:disabled) {
    color: var(--tts-reader-text);
    border-color: var(--tts-reader-line-hover);
    background: var(--tts-reader-control-hover-bg);
  }

  .tts-btn:disabled {
    opacity: 0.3;
    cursor: default;
  }

  .tts-btn--primary {
    color: var(--tts-reader-text);
    background: var(--tts-reader-accent-dim);
    border-color: var(--tts-reader-accent);
  }

  .tts-btn--primary:hover:not(:disabled) {
    background: var(--tts-reader-control-active-bg);
    border-color: var(--tts-reader-accent-bright);
  }

  .tts-settings-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .tts-settings-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    min-height: 28px;
    border-top: 1px solid var(--tts-reader-divider);
    padding-top: 8px;
  }

  .tts-settings-label {
    font-size: 12px;
    font-weight: 500;
    color: var(--tts-reader-muted);
  }

  .tts-speed-control {
    display: flex;
    align-items: center;
    gap: 8px;
    flex: 1;
    max-width: 160px;
    justify-content: flex-end;
  }

  .tts-speed-val {
    font-size: 11px;
    font-weight: 600;
    color: var(--tts-reader-text);
    min-width: 28px;
  }

  .tts-range-input {
    flex: 1;
    height: var(--component-reader-range-track-height);
    border-radius: var(--component-reader-pill-radius);
    background: var(--tts-reader-track-bg);
    outline: none;
    appearance: none;
    -webkit-appearance: none;
    cursor: pointer;
  }

  .tts-range-input:disabled {
    opacity: 0.3;
  }

  .tts-range-input::-webkit-slider-thumb {
    -webkit-appearance: none;
    width: var(--component-reader-range-thumb-size);
    height: var(--component-reader-range-thumb-size);
    border-radius: var(--component-reader-control-radius);
    background: var(--tts-reader-text);
  }

  .tts-voice-control {
    display: flex;
    align-items: center;
    gap: 6px;
    max-width: 180px;
  }

  .tts-select {
    width: 140px;
    border: 1px solid var(--tts-reader-line);
    border-radius: var(--component-reader-toggle-radius);
    background: var(--tts-reader-control-bg);
    color: var(--tts-reader-text);
    font-size: 11px;
    font-weight: 500;
    padding: 4px 6px;
    outline: none;
  }

  .tts-select:disabled {
    opacity: 0.3;
  }

  .tts-status-val {
    font-size: 11px;
    font-weight: 600;
    color: var(--tts-reader-text);
  }
</style>
