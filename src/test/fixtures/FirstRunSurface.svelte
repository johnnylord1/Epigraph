<script lang="ts">
  import type { FirstRunBackupReadiness } from "../../lib/firstRun";
  let {
    profileId = null,
    scopeLabel = null,
    firstRunPane = null,
    contentType = "manga",
    onReadyChange = () => {},
    onFirstRunBackupReadyChange = () => {},
    onOpenFirstRunSources = () => {},
    onSetupReadinessChange = () => {},
  }: {
    profileId?: string | null;
    scopeLabel?: string | null;
    firstRunPane?: "backup" | "tracking" | null;
    contentType?: "manga" | "novels";
    onReadyChange?: (ready: boolean) => void;
    onFirstRunBackupReadyChange?: (readiness: FirstRunBackupReadiness) => void;
    onOpenFirstRunSources?: () => void;
    onSetupReadinessChange?: (state: { contentType: "manga" | "novels"; repositoryCount: number; installedCount: number; ready: boolean }) => void;
  } = $props();
  let selectedBackup = $state(false);
</script>

<div data-testid="first-run-surface" data-profile-id={profileId ?? ""}>
  {#if scopeLabel}
    <button type="button" onclick={() => onReadyChange(true)}>Connect test device</button>
  {:else if firstRunPane === "backup"}
    <button type="button" onclick={() => (selectedBackup = true)}>Choose test backup</button>
    <button type="button" onclick={onOpenFirstRunSources}>Open test repositories</button>
    {#if selectedBackup}<span>Test backup selected</span>{/if}
    <button type="button" onclick={() => onFirstRunBackupReadyChange({ ready: true, hasSelection: true, contentType: "manga" })}>Complete test restore</button>
  {:else if firstRunPane !== "tracking"}
    <button type="button" onclick={() => onSetupReadinessChange({ contentType, repositoryCount: 1, installedCount: 1, ready: true })}>Install test extension</button>
  {/if}
</div>
