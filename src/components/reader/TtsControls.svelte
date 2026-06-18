<script lang="ts">
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
  const voiceLabel = $derived(voices.length ? "Voice" : "Voices unavailable");
</script>

<div class="tts-panel" aria-label="Text to speech controls">
  <!-- Header with back button -->
  {#if onback}
    <div class="tts-header">
      <button class="tts-back-btn" onclick={onback} title="Back to settings">
        <CaretLeft size={14} weight="bold" />
        <span>Back</span>
      </button>
      <span class="tts-title">Text to Speech</span>
    </div>
  {/if}

  <!-- Playback Button Row -->
  <div class="tts-row tts-playback-row">
    <button
      class="tts-btn tts-btn--primary"
      type="button"
      onclick={() => isPlaying ? controller.pause() : controller.play()}
      disabled={disabled}
      aria-label={isPlaying ? "Pause reading aloud" : "Play reading aloud"}
      title={isPlaying ? "Pause" : "Play"}
    >
      {#if isPlaying}
        <Pause size={15} weight="fill" />
      {:else}
        <Play size={15} weight="fill" />
      {/if}
    </button>
    <button class="tts-btn" type="button" onclick={controller.stop} disabled={disabled} aria-label="Stop reading" title="Stop">
      <Stop size={15} weight="fill" />
    </button>
    <button class="tts-btn" type="button" onclick={controller.previous} disabled={disabled} aria-label="Previous paragraph" title="Previous">
      <CaretLeft size={15} weight="bold" />
    </button>
    <button class="tts-btn" type="button" onclick={controller.next} disabled={disabled} aria-label="Next paragraph" title="Next">
      <CaretRight size={15} weight="bold" />
    </button>
  </div>

  <!-- Settings rows -->
  <div class="tts-settings-list">
    <div class="tts-settings-row">
      <span class="tts-settings-label">Speed</span>
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
          aria-label="Playback speed"
        />
      </div>
    </div>

    <div class="tts-settings-row">
      <span class="tts-settings-label">Voice</span>
      <div class="tts-voice-control">
        <SpeakerHigh size={14} weight="regular" style="margin-right: 2px;" />
        <select
          class="tts-select"
          value={selectedVoice}
          onchange={(event) => setSelectedVoice(event.currentTarget.value)}
          disabled={!supported || voices.length === 0}
          aria-label="Speech voice"
        >
          <option value="">System voice</option>
          {#each voices as voice}
            <option value={voice.name}>{voice.name}</option>
          {/each}
        </select>
      </div>
    </div>

    <div class="tts-settings-row">
      <span class="tts-settings-label">Status</span>
      {#if !supported}
        <span class="tts-status-val">Unavailable</span>
      {:else if !hasProvider || segmentCount === 0}
        <span class="tts-status-val">No text</span>
      {:else}
        <span class="tts-status-val">{Math.min(currentSegmentIndex + 1, segmentCount)} / {segmentCount}</span>
      {/if}
    </div>
  </div>
</div>

<style>
  .tts-panel {
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
    border-bottom: 1px solid rgba(255, 255, 255, 0.05);
  }

  .tts-back-btn {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    background: transparent;
    border: 0;
    color: var(--reader-accent-bright);
    font-size: 11px;
    font-weight: 600;
    cursor: pointer;
    padding: 0;
    transition: opacity 120ms;
  }

  .tts-back-btn:hover {
    opacity: 0.8;
  }

  .tts-title {
    font-size: 11px;
    font-weight: 600;
    color: var(--reader-muted);
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
    border: 1px solid rgba(255, 255, 255, 0.05);
    border-radius: 9999px;
    background: rgba(255, 255, 255, 0.03);
    color: var(--reader-muted);
    cursor: pointer;
    transition: all 120ms;
  }

  .tts-btn:hover:not(:disabled) {
    color: var(--reader-text);
    border-color: rgba(255, 255, 255, 0.15);
    background: rgba(255, 255, 255, 0.06);
  }

  .tts-btn:disabled {
    opacity: 0.3;
    cursor: default;
  }

  .tts-btn--primary {
    color: var(--reader-text);
    background: rgba(143, 130, 230, 0.2);
    border-color: rgba(171, 159, 255, 0.2);
  }

  .tts-btn--primary:hover:not(:disabled) {
    background: rgba(143, 130, 230, 0.3);
    border-color: rgba(171, 159, 255, 0.3);
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
    border-top: 1px solid rgba(255, 255, 255, 0.025);
    padding-top: 8px;
  }

  .tts-settings-label {
    font-size: 12px;
    font-weight: 500;
    color: var(--reader-muted);
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
    color: var(--reader-text);
    min-width: 28px;
  }

  .tts-range-input {
    flex: 1;
    height: 4px;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.15);
    outline: none;
    -webkit-appearance: none;
    cursor: pointer;
  }

  .tts-range-input:disabled {
    opacity: 0.3;
  }

  .tts-range-input::-webkit-slider-thumb {
    -webkit-appearance: none;
    width: 10px;
    height: 10px;
    border-radius: 999px;
    background: var(--reader-text);
  }

  .tts-voice-control {
    display: flex;
    align-items: center;
    gap: 6px;
    max-width: 180px;
  }

  .tts-select {
    width: 140px;
    border: 1px solid rgba(255, 255, 255, 0.05);
    border-radius: 4px;
    background: rgba(0, 0, 0, 0.45);
    color: var(--reader-text);
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
    color: var(--reader-text);
  }
</style>
