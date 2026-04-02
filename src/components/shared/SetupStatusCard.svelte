<script lang="ts">
  import { ArrowsClockwise, GitBranch, Plug, PuzzlePiece, WarningCircle } from "phosphor-svelte";
  import type { SetupActionKind, SetupState, SetupSurface } from "../../lib/setupState";
  import { getSetupStatePresentation } from "../../lib/setupState";

  let {
    state,
    surface,
    actionBusy = false,
    onAddRecommendedRepo = () => {},
    onAddManually = () => {},
    onBrowseAvailableExtensions = () => {},
    onOpenExtensions = () => {},
    onOpenRepoManager = () => {},
    onRetry = () => {},
  }: {
    state: SetupState;
    surface: SetupSurface;
    actionBusy?: boolean;
    onAddRecommendedRepo?: () => void;
    onAddManually?: () => void;
    onBrowseAvailableExtensions?: () => void;
    onOpenExtensions?: () => void;
    onOpenRepoManager?: () => void;
    onRetry?: () => void;
  } = $props();

  const content = $derived(getSetupStatePresentation(state, surface));

  function handleAction(kind: SetupActionKind) {
    if (kind === "add_recommended_repo") onAddRecommendedRepo();
    if (kind === "add_manually") onAddManually();
    if (kind === "browse_available_extensions") onBrowseAvailableExtensions();
    if (kind === "open_extensions") onOpenExtensions();
    if (kind === "open_repo_manager") onOpenRepoManager();
    if (kind === "retry_connection") onRetry();
  }
</script>

<section class="setup-card" data-setup-state={state.kind}>
  <div class="setup-icon">
    {#if state.kind === "server_offline"}
      <Plug size={18} weight="duotone" />
    {:else if state.kind === "no_extension_repos"}
      <GitBranch size={18} weight="duotone" />
    {:else if state.kind === "no_installed_extensions"}
      <PuzzlePiece size={18} weight="duotone" />
    {:else}
      <WarningCircle size={18} weight="duotone" />
    {/if}
  </div>
  <div class="setup-copy">
    <p class="setup-label">Setup Status</p>
    <h2 class="setup-title">{content.title}</h2>
    <p class="setup-body">{content.body}</p>
    {#if state.kind === "server_offline" && state.errorMessage}
      <p class="setup-note">Last error: {state.errorMessage}</p>
    {/if}
    <div class="setup-actions">
      {#each content.actions as action (action.kind)}
        <button
          class:secondary={action.kind === "retry_connection" || action.kind === "add_manually" || action.kind === "open_repo_manager"}
          onclick={() => handleAction(action.kind)}
          disabled={actionBusy}
        >
          {#if action.kind === "retry_connection"}
            <ArrowsClockwise size={12} weight="bold" />
          {:else if action.kind === "add_recommended_repo"}
            <GitBranch size={12} weight="bold" />
          {:else if action.kind === "add_manually"}
            <GitBranch size={12} weight="bold" />
          {:else if action.kind === "open_repo_manager"}
            <GitBranch size={12} weight="bold" />
          {:else if action.kind === "browse_available_extensions"}
            <PuzzlePiece size={12} weight="bold" />
          {:else}
            <PuzzlePiece size={12} weight="bold" />
          {/if}
          {action.label}
        </button>
      {/each}
    </div>
  </div>
</section>

<style>
  .setup-card {
    display: flex;
    gap: var(--sp-3);
    padding: var(--sp-4);
    border-radius: var(--radius-lg);
    border: 1px solid var(--border-dim);
    background: linear-gradient(180deg, color-mix(in srgb, var(--bg-raised) 92%, var(--accent-muted)) 0%, var(--bg-raised) 100%);
  }
  .setup-icon {
    width: 38px;
    height: 38px;
    border-radius: var(--radius-md);
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    color: var(--accent-fg);
    background: var(--accent-muted);
    border: 1px solid var(--accent-dim);
  }
  .setup-copy {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .setup-label {
    font-family: var(--font-ui);
    font-size: var(--text-2xs);
    letter-spacing: var(--tracking-wider);
    text-transform: uppercase;
    color: var(--text-faint);
  }
  .setup-title {
    font-size: var(--text-base);
    font-weight: var(--weight-medium);
    color: var(--text-secondary);
    line-height: var(--leading-tight);
  }
  .setup-body {
    font-size: var(--text-sm);
    color: var(--text-muted);
    line-height: var(--leading-snug);
    max-width: 72ch;
  }
  .setup-note {
    font-family: var(--font-ui);
    font-size: var(--text-2xs);
    color: var(--text-faint);
    letter-spacing: var(--tracking-wide);
  }
  .setup-actions {
    display: flex;
    gap: var(--sp-2);
    flex-wrap: wrap;
    margin-top: 2px;
  }
  .setup-actions button {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-family: var(--font-ui);
    font-size: var(--text-xs);
    letter-spacing: var(--tracking-wide);
    padding: 7px 12px;
    border-radius: var(--radius-md);
    background: var(--accent-muted);
    color: var(--accent-fg);
    border: 1px solid var(--accent-dim);
    cursor: pointer;
    transition: filter var(--t-base), background var(--t-base), color var(--t-base);
  }
  .setup-actions button:hover {
    filter: brightness(1.08);
  }
  .setup-actions button:disabled {
    opacity: 0.55;
    cursor: default;
    filter: none;
  }
  .setup-actions button.secondary {
    background: var(--bg-overlay);
    color: var(--text-muted);
    border-color: var(--border-dim);
  }
  .setup-actions button.secondary:hover {
    color: var(--text-secondary);
    background: var(--bg-subtle);
  }
</style>
