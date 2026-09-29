<script module lang="ts">
  export interface MenuItem {
    label:      string;
    icon?:      any;
    onClick:    () => void;
    danger?:    boolean;
    disabled?:  boolean;
    separator?: never;
  }
  export interface MenuSeparator { separator: true }
  export type MenuEntry = MenuItem | MenuSeparator;
</script>

<script lang="ts">
  interface Props {
    x:       number;
    y:       number;
    items:   MenuEntry[];
    onClose: () => void;
  }

  let { x, y, items, onClose }: Props = $props();

  let focused = $state(-1);
  let el      = $state<HTMLDivElement | undefined>(undefined);

  const actionable = $derived(
    items
      .map((_, i) => i)
      .filter((i) => !("separator" in items[i]) && !(items[i] as MenuItem).disabled)
  );

  $effect(() => { if (actionable.length && focused === -1) focused = actionable[0]; });

  const pos = $derived.by(() => {
    const zoom  = parseFloat(document.documentElement.style.zoom || "100") / 100 || 1;
    const menuW = 200, menuH = items.length * 34;
    const vw = window.innerWidth / zoom, vh = window.innerHeight / zoom;
    const sx = x / zoom, sy = y / zoom;
    return {
      left: Math.max(4, sx + menuW > vw ? sx - menuW : sx),
      top:  Math.max(4, sy + menuH > vh ? sy - menuH : sy),
    };
  });

  function onMouseDown(e: MouseEvent) {
    if (el && !el.contains(e.target as Node)) onClose();
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape") { e.stopPropagation(); onClose(); return; }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      const cur = actionable.indexOf(focused);
      focused = actionable[(cur + 1) % actionable.length] ?? actionable[0];
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      const cur = actionable.indexOf(focused);
      focused = actionable[(cur - 1 + actionable.length) % actionable.length] ?? actionable[0];
      return;
    }
    if (e.key === "Enter" && focused >= 0) {
      e.preventDefault();
      const item = items[focused] as MenuItem;
      if (item && !item.disabled) { item.onClick(); onClose(); }
    }
  }

  $effect(() => {
    document.addEventListener("mousedown", onMouseDown, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onMouseDown, true);
      document.removeEventListener("keydown", onKey, true);
    };
  });
</script>

<div bind:this={el} class="menu" role="menu" tabindex="-1" style="left:{pos.left}px;top:{pos.top}px"
  oncontextmenu={(e) => e.preventDefault()}>
  {#each items as item, i}
    {#if "separator" in item}
      <div class="sep"></div>
    {:else}
      {@const mi = item as MenuItem}
      <button
        class="item"
        class:danger={mi.danger}
        class:disabled={mi.disabled}
        class:focused={focused === i}
        disabled={mi.disabled}
        onclick={() => { if (!mi.disabled) { mi.onClick(); onClose(); } }}
        onmouseenter={() => { if (!mi.disabled) focused = i; }}
        onmouseleave={() => focused = -1}
      >
        <span class="icon" class:icon-danger={mi.danger}>
          {#if mi.icon}<mi.icon size={13} weight="light" />{/if}
        </span>
        <span class="label">{mi.label}</span>
      </button>
    {/if}
  {/each}
</div>

<style>
  .menu {
    position: fixed;
    z-index: var(--component-menu-z-index);
    min-width: 204px;
    padding: 7px;
    border: 1px solid var(--component-menu-border);
    border-radius: var(--component-menu-radius);
    background: var(--component-menu-bg);
    box-shadow: var(--component-menu-shadow);
    backdrop-filter: var(--blur-backdrop) saturate(120%);
    animation: scaleIn 320ms var(--ui-spring) both;
    transform-origin: top left;
  }
  .item {
    display: flex; align-items: center; gap: 9px;
    width: 100%; min-height: 34px; padding: 0 10px;
    border-radius: var(--component-menu-item-radius);
    color: var(--component-menu-item-fg);
    font: var(--weight-bold) 11px/1 "Manrope", var(--font-sans);
    letter-spacing: 0.03em;
    text-align: left; cursor: pointer;
    transition: background 140ms ease, color 140ms ease, transform 140ms ease;
    background: none; border: none; outline: none;
  }
  .item:hover:not(.disabled), .item.focused:not(.disabled) { background: var(--component-menu-item-hover-bg); color: var(--component-menu-item-hover-fg); }
  .item:active:not(.disabled) { transform: scale(0.985); }
  .item.danger { color: var(--component-menu-item-danger-fg); }
  .item.danger:hover:not(.disabled), .item.danger.focused:not(.disabled) { background: var(--component-menu-item-danger-hover-bg); }
  .item.disabled { opacity: 0.3; cursor: default; pointer-events: none; }
  .icon {
    display: flex; align-items: center; justify-content: center;
    width: 18px; height: 18px; flex-shrink: 0;
    color: var(--component-menu-icon-fg); border-radius: var(--component-menu-icon-radius);
  }
  .icon-danger { color: var(--component-menu-item-danger-fg); opacity: 0.78; }
  .label { flex: 1; line-height: 1.3; }
  .sep { height: 1px; background: var(--component-menu-divider); margin: 6px 2px; }
</style>
