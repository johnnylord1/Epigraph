<script lang="ts">
  import { _ } from "../../lib/i18n/runtime";
  import { store, updateSettings } from "../../store/state.svelte";
  import { READER_BRIGHTNESS_SETTING_KEY, type ReaderKind } from "../../lib/reader/readerSettingsScope";

  let { readerKind = "manga" }: { readerKind?: ReaderKind } = $props();

  const MIN_BRIGHTNESS = 0.2;
  const MAX_BRIGHTNESS = 1;
  const BRIGHTNESS_STEP = 0.1;

  const brightnessKey = $derived(READER_BRIGHTNESS_SETTING_KEY[readerKind]);
  const brightness = $derived(store.settings[brightnessKey] ?? MAX_BRIGHTNESS);
  const brightnessLabel = $derived(`${Math.round(brightness * 100)}%`);

  function setBrightness(next: number) {
    updateSettings({
      [brightnessKey]: Math.max(MIN_BRIGHTNESS, Math.min(MAX_BRIGHTNESS, Number(next.toFixed(2)))),
    });
  }
</script>

<div>
  <dt>{$_("ui_brightness")}</dt>
  <dd>
    <div class="popover-stepper">
      <button
        class="popover-step-btn"
        type="button"
        aria-label={$_("ui_decreaseReaderBrightness")}
        title={$_("ui_decreaseBrightness")}
        onclick={() => setBrightness(brightness - BRIGHTNESS_STEP)}
        disabled={brightness <= MIN_BRIGHTNESS + 0.01}
      >-</button>
      <span class="popover-step-val">{brightnessLabel}</span>
      <button
        class="popover-step-btn"
        type="button"
        aria-label={$_("ui_increaseReaderBrightness")}
        title={$_("ui_increaseBrightness")}
        onclick={() => setBrightness(brightness + BRIGHTNESS_STEP)}
        disabled={brightness >= MAX_BRIGHTNESS - 0.01}
      >+</button>
    </div>
  </dd>
</div>
