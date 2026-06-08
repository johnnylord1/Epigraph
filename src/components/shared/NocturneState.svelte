<script lang="ts">
  import {
    ArrowsClockwise,
    Books,
    FolderOpen,
    Info,
    MagnifyingGlass,
    Plug,
    WarningCircle,
  } from "phosphor-svelte";

  type Tone = "neutral" | "info" | "warning" | "danger" | "success";
  type IconName = "info" | "warning" | "plug" | "retry" | "search" | "books" | "folder";
  type Layout = "panel" | "compact" | "center";

  let {
    eyebrow = "Status",
    title,
    body = "",
    detail = "",
    tone = "neutral",
    icon = "info",
    layout = "panel",
    actions = [],
  }: {
    eyebrow?: string;
    title: string;
    body?: string;
    detail?: string;
    tone?: Tone;
    icon?: IconName;
    layout?: Layout;
    actions?: Array<{
      label: string;
      kind?: "primary" | "secondary" | "danger";
      disabled?: boolean;
      icon?: IconName;
      onClick: () => void;
    }>;
  } = $props();

  function iconFor(name: IconName) {
    if (name === "warning") return WarningCircle;
    if (name === "plug") return Plug;
    if (name === "retry") return ArrowsClockwise;
    if (name === "search") return MagnifyingGlass;
    if (name === "books") return Books;
    if (name === "folder") return FolderOpen;
    return Info;
  }

  const StateIcon = $derived(iconFor(icon));
</script>

<section class="n-state n-state--{layout} n-state--{tone}" role={tone === "danger" ? "alert" : "status"}>
  <div class="n-state__icon" aria-hidden="true">
    <StateIcon size={layout === "compact" ? 15 : 18} weight="duotone" />
  </div>

  <div class="n-state__content">
    {#if eyebrow}
      <p class="n-state__eyebrow">{eyebrow}</p>
    {/if}
    <h2 class="n-state__title">{title}</h2>
    {#if body}
      <p class="n-state__body">{body}</p>
    {/if}
    {#if detail}
      <p class="n-state__detail">{detail}</p>
    {/if}
    {#if actions.length > 0}
      <div class="n-state__actions">
        {#each actions as action (action.label)}
          {@const ActionIcon = action.icon ? iconFor(action.icon) : null}
          <button
            type="button"
            class="n-state__action n-state__action--{action.kind ?? 'secondary'}"
            disabled={action.disabled}
            onclick={action.onClick}
          >
            {#if ActionIcon}
              <ActionIcon size={13} weight="bold" />
            {/if}
            <span>{action.label}</span>
          </button>
        {/each}
      </div>
    {/if}
  </div>
</section>

<style>
  .n-state {
    --state-accent: var(--accent-fg);
    --state-accent-soft: color-mix(in srgb, var(--accent-muted) 80%, transparent);
    --state-accent-border: var(--accent-dim);
    --state-glow: color-mix(in srgb, var(--state-accent) 8%, transparent);

    display: flex;
    gap: 13px;
    min-width: 0;
    color: var(--text-muted);
    position: relative;
    overflow: hidden;
  }

  .n-state--panel,
  .n-state--center {
    padding: 18px 20px;
    border: 1px solid color-mix(in srgb, var(--border-dim) 58%, transparent);
    border-radius: 14px;
    background:
      linear-gradient(90deg, var(--state-glow), transparent 38%),
      linear-gradient(180deg, rgba(24, 23, 30, 0.62), rgba(13, 13, 17, 0.54));
    box-shadow: inset 0 1px 0 rgba(255,255,255,0.035), 0 18px 44px rgba(0,0,0,0.16);
  }

  .n-state--compact {
    align-items: center;
    padding: 15px 17px;
    border: 1px solid color-mix(in srgb, var(--border-dim) 52%, transparent);
    border-radius: 12px;
    background:
      linear-gradient(90deg, var(--state-glow), transparent 42%),
      linear-gradient(180deg, rgba(18, 17, 22, 0.58), rgba(11, 11, 14, 0.5));
  }

  .n-state::before {
    content: "";
    position: absolute;
    inset: 12px auto 12px 0;
    width: 2px;
    border-radius: 99px;
    background: color-mix(in srgb, var(--state-accent) 72%, transparent);
    opacity: 0.72;
  }

  .n-state--center {
    width: min(620px, calc(100% - 48px));
    margin: auto;
    align-items: flex-start;
  }

  .n-state--info { --state-accent: #c9b5ff; }
  .n-state--warning { --state-accent: #d6c09a; }
  .n-state--danger { --state-accent: #d8b4ff; }
  .n-state--success { --state-accent: #b8dfbe; }

  .n-state__icon {
    flex: 0 0 auto;
    width: 34px;
    height: 34px;
    border-radius: 11px;
    display: grid;
    place-items: center;
    color: var(--state-accent);
    background: color-mix(in srgb, var(--state-accent) 10%, rgba(18, 17, 24, 0.72));
    border: 1px solid color-mix(in srgb, var(--state-accent) 22%, transparent);
    box-shadow: inset 0 1px 0 rgba(255,255,255,0.04);
  }

  .n-state--compact .n-state__icon {
    width: 30px;
    height: 30px;
    border-radius: 10px;
  }

  .n-state__content {
    min-width: 0;
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 5px;
  }

  .n-state__eyebrow {
    margin: 0;
    font-family: var(--font-ui);
    font-size: var(--text-2xs);
    line-height: 1;
    letter-spacing: var(--tracking-wider);
    text-transform: uppercase;
    color: color-mix(in srgb, var(--state-accent) 48%, var(--text-faint));
  }

  .n-state__title {
    margin: 0;
    font-size: var(--text-base);
    line-height: var(--leading-tight);
    font-weight: var(--weight-semibold);
    color: var(--text-secondary);
    letter-spacing: 0;
  }

  .n-state--compact .n-state__title {
    font-size: var(--text-sm);
  }

  .n-state__body,
  .n-state__detail {
    margin: 0;
    max-width: 76ch;
    color: var(--text-muted);
    font-size: var(--text-sm);
    line-height: var(--leading-snug);
  }

  .n-state__detail {
    max-width: 100%;
    color: var(--text-faint);
    font-family: var(--font-ui);
    font-size: var(--text-2xs);
    letter-spacing: var(--tracking-wide);
    word-break: break-word;
    white-space: pre-wrap;
  }

  .n-state__actions {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    margin-top: 5px;
  }

  .n-state__action {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 7px;
    min-height: 32px;
    padding: 0 13px;
    border-radius: 10px;
    border: 1px solid color-mix(in srgb, var(--border-dim) 62%, transparent);
    background: rgba(20, 19, 25, 0.58);
    color: var(--text-muted);
    font-family: var(--font-ui);
    font-size: var(--text-xs);
    font-weight: var(--weight-semibold);
    letter-spacing: var(--tracking-wide);
    cursor: pointer;
    transition: transform 140ms ease, color 140ms ease, border-color 140ms ease, background 140ms ease;
  }

  .n-state__action:hover {
    transform: translateY(-1px);
    color: var(--text-secondary);
    border-color: color-mix(in srgb, var(--state-accent) 28%, var(--border-dim));
    background: color-mix(in srgb, var(--state-accent) 9%, var(--bg-overlay));
  }

  .n-state__action:active {
    transform: translateY(0) scale(0.98);
  }

  .n-state__action:disabled {
    opacity: 0.5;
    cursor: default;
    transform: none;
  }

  .n-state__action--primary {
    color: color-mix(in srgb, var(--state-accent) 78%, white);
    border-color: color-mix(in srgb, var(--state-accent) 34%, transparent);
    background: color-mix(in srgb, var(--state-accent) 13%, var(--bg-overlay));
  }

  .n-state__action--danger {
    color: #ef9aa8;
    border-color: color-mix(in srgb, #ef9aa8 26%, transparent);
    background: color-mix(in srgb, #ef9aa8 9%, var(--bg-overlay));
  }
</style>
