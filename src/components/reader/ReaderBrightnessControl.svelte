<script lang="ts">
  import { store, updateSettings } from "../../store/state.svelte";

  const MIN_BRIGHTNESS = 0.2;
  const MAX_BRIGHTNESS = 1;
  const BRIGHTNESS_STEP = 0.1;

  const brightness = $derived(store.settings.readerBrightness ?? MAX_BRIGHTNESS);
  const brightnessLabel = $derived(`${Math.round(brightness * 100)}%`);

  function setBrightness(next: number) {
    updateSettings({
      readerBrightness: Math.max(MIN_BRIGHTNESS, Math.min(MAX_BRIGHTNESS, Number(next.toFixed(2)))),
    });
  }
</script>

<div>
  <dt>Brightness</dt>
  <dd>
    <div class="popover-stepper">
      <button
        class="popover-step-btn"
        type="button"
        aria-label="Decrease reader brightness"
        title="Decrease brightness"
        onclick={() => setBrightness(brightness - BRIGHTNESS_STEP)}
        disabled={brightness <= MIN_BRIGHTNESS + 0.01}
      >-</button>
      <span class="popover-step-val">{brightnessLabel}</span>
      <button
        class="popover-step-btn"
        type="button"
        aria-label="Increase reader brightness"
        title="Increase brightness"
        onclick={() => setBrightness(brightness + BRIGHTNESS_STEP)}
        disabled={brightness >= MAX_BRIGHTNESS - 0.01}
      >+</button>
    </div>
  </dd>
</div>
