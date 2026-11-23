<script lang="ts">
  import { _ } from "../../lib/i18n/runtime";
  import { invoke } from "@tauri-apps/api/core";
  import { Check, Copy, Image as ImageIcon, X } from "phosphor-svelte";
  import { onMount } from "svelte";
  import { createDialogFocusBoundary } from "../../lib/accessibility/dialogFocus";
  import { glideHeight } from "../../lib/motion/motion";
  import { loadShareCovers, renderShareImage } from "../../lib/library/shareImage";
  import { fetchDesktopShareManifest } from "../../lib/library/shareImport";
  import {
    buildShareManifest,
    buildShareWebUrl,
    chooseShareLinkToken,
    embedShareTokenInPng,
    encodeShareManifest,
    type ShareManifest,
  } from "../../lib/library/shareLink";
  import { buildShareText, shareCollageLayout } from "../../lib/library/sharePayload";
  import type { Manga } from "../../lib/types";
  import "../pages/migrationModal.css";

  type CoverScope = Parameters<typeof loadShareCovers>[1];

  interface Props {
    /** The selected works, in library order. */
    mangas: readonly Manga[];
    coverScope: CoverScope;
    onClose: () => void;
  }

  let { mangas, coverScope, onClose }: Props = $props();

  /** Discord's limit for one message; a longer paste becomes a file. */
  const DISCORD_MESSAGE_LIMIT = 2000;

  let overlayEl = $state<HTMLDivElement | null>(null);
  let modalEl = $state<HTMLDivElement | null>(null);
  let closeButtonEl = $state<HTMLButtonElement | null>(null);
  let imageBlob = $state<Blob | null>(null);
  let imageUrl = $state<string | null>(null);
  let imageFailed = $state(false);
  let copied = $state<"list" | "image" | "all" | null>(null);
  let copyFailed = $state(false);
  let uploading = $state(false);
  let uploadFailed = $state(false);
  let hostedImageUrl = $state<string | null>(null);
  let resolvedShareManifest = $state<ShareManifest | null>(null);
  let copiedTimer: ReturnType<typeof setTimeout> | null = null;
  const controller = new AbortController();
  let manifestReady: Promise<void> | null = null;

  const shareManifest = $derived(
    resolvedShareManifest ?? buildShareManifest(
      mangas.map((manga) => ({
        title: manga.title,
        sourceId: manga.sourceId ?? manga.source?.id ?? null,
        url: manga.url ?? null,
        webUrl: manga.realUrl ?? null,
        coverUrl: manga.thumbnailUrl ?? null,
        sourceName: manga.source?.displayName ?? manga.source?.name ?? null,
        sourceLang: manga.source?.lang ?? null,
        kind: manga.id < 0 ? "book" : "comic",
      })),
    ),
  );
  const inlineShareToken = $derived(shareManifest.works.length ? encodeShareManifest(shareManifest) : null);
  const hasImportableWorks = $derived(shareManifest.works.some((work) => work.sourceId && work.url));

  const shareListText = $derived(buildShareText(shareManifest.works.map((work) => ({ title: work.title, url: work.webUrl }))));
  const importLinkToken = $derived(chooseShareLinkToken(inlineShareToken, hostedImageUrl));
  const importLinkLine = $derived(
    importLinkToken && hasImportableWorks
      ? `[${$_("library.share.openInEpigraph")}](<${buildShareWebUrl(importLinkToken, hostedImageUrl)}>)`
      : "",
  );
  const viewListLine = $derived(
    importLinkToken
      ? `[${$_("library.share.viewList")}](<${buildShareWebUrl(importLinkToken, hostedImageUrl, { viewOnly: true })}>)`
      : "",
  );
  const shareButtonsLine = $derived([importLinkLine, viewListLine].filter(Boolean).join(" · "));
  const combinedText = $derived(
    [shareButtonsLine, hostedImageUrl ? `[Previews](${hostedImageUrl})` : ""]
      .filter(Boolean)
      .join("\n\n"),
  );
  const heading = $derived(mangas.length === 1 ? $_("library.share.titleOne") : $_("library.share.title", { count: mangas.length }));

  function onKey(event: KeyboardEvent) {
    if (event.key === "Escape") onClose();
  }

  $effect(() => {
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  onMount(() => {
    let objectUrl: string | null = null;
    // Only the works the image shows need a cover; the last cell counts the rest.
    const drawn = mangas.slice(0, shareCollageLayout(mangas.length).covers);
    manifestReady = (async () => {
      try {
        const manifest = await fetchDesktopShareManifest(mangas, { profileId: coverScope.profileId, serverUrl: coverScope.serverUrl });
        if (controller.signal.aborted) return;
        if (manifest.works.length > 0) {
          resolvedShareManifest = manifest;
        }
      } catch {
        // Sharing the list and image still works without the import link.
      }
    })();
    void (async () => {
      let covers: (ImageBitmap | null)[] = [];
      try {
        covers = await loadShareCovers(drawn, coverScope, controller.signal);
        if (controller.signal.aborted) return;
        const blob = await renderShareImage(
          mangas.map((manga, index) => ({ title: manga.title, cover: covers[index] ?? null })),
          {
            countLabel: (count) => (count === 1 ? $_("library.share.cardCountOne") : $_("library.share.cardCount", { count })),
            moreLabel: (count) => $_("library.share.more", { count }),
          },
        );
        if (controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(blob);
        imageBlob = blob;
        imageUrl = objectUrl;
      } catch {
        if (!controller.signal.aborted) imageFailed = true;
      } finally {
        covers.forEach((cover) => cover?.close());
      }
    })();

    const releaseFocus = overlayEl && modalEl
      ? createDialogFocusBoundary({ dialog: modalEl, isolationRoot: overlayEl, initialFocus: closeButtonEl })
      : undefined;

    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      if (copiedTimer) clearTimeout(copiedTimer);
      releaseFocus?.();
    };
  });

  function markCopied(kind: "list" | "image" | "all") {
    copyFailed = false;
    copied = kind;
    if (copiedTimer) clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => {
      copied = null;
    }, 1800);
  }

  async function copyList() {
    try {
      await navigator.clipboard.writeText(shareListText);
      markCopied("list");
    } catch {
      copyFailed = true;
    }
  }

  async function copyImage() {
    if (!imageBlob) return;
    try {
      await navigator.clipboard.write([new ClipboardItem({ "image/png": imageBlob })]);
      markCopied("image");
    } catch {
      copyFailed = true;
    }
  }

  async function copyAll() {
    if (!imageBlob || uploading) return;
    copyFailed = false;
    uploadFailed = false;
    if (!hostedImageUrl) {
      uploading = true;
      try {
        await manifestReady;
        if (controller.signal.aborted) return;
        const rawBuffer = await imageBlob.arrayBuffer();
        if (controller.signal.aborted) return;
        const uploadBody = inlineShareToken
          ? embedShareTokenInPng(new Uint8Array(rawBuffer), inlineShareToken).buffer
          : rawBuffer;
        const url = await invoke<string>("plugin:library-share|upload_card", uploadBody);
        if (controller.signal.aborted) return;
        hostedImageUrl = url;
      } catch {
        if (!controller.signal.aborted) uploadFailed = true;
        return;
      } finally {
        uploading = false;
      }
    }
    try {
      await navigator.clipboard.writeText(combinedText);
      if (!controller.signal.aborted) markCopied("all");
    } catch {
      if (!controller.signal.aborted) copyFailed = true;
    }
  }
</script>

<div bind:this={overlayEl} class="mg-overlay" data-library-share>
  <button class="mg-backdrop" type="button" aria-label={$_("common.close")} onclick={onClose}></button>
  <div
    bind:this={modalEl}
    class="mg-modal"
    role="dialog"
    aria-modal="true"
    aria-labelledby="library-share-title"
    tabindex="-1"
    use:glideHeight
  >
    <header class="mg-header">
      <div class="mg-heading">
        <h2 id="library-share-title" class="mg-title">{heading}</h2>
      </div>
      <button bind:this={closeButtonEl} class="mg-close" type="button" onclick={onClose} aria-label={$_("common.close")}><X size={16} weight="bold" /></button>
    </header>

    <div class="mg-body">
      <div class="share-preview" aria-busy={!imageUrl && !imageFailed}>
        {#if imageUrl}
          <img src={imageUrl} alt={$_("library.share.imageAlt")} />
        {:else if imageFailed}
          <p class="mg-note is-warn">{$_("library.share.imageFailed")}</p>
        {:else}
          <p class="mg-note">{$_("library.share.preparing")}</p>
        {/if}
      </div>
      <pre class="share-list">{shareListText}</pre>
      <p id="library-share-upload-note" class="mg-note">{$_("library.share.uploadNote")}</p>
      {#if combinedText.length > DISCORD_MESSAGE_LIMIT}
        <p class="mg-note">{$_("library.share.longList")}</p>
      {/if}
      {#if uploadFailed}
        <p class="mg-note is-warn" role="alert">{$_("library.share.uploadFailed")}</p>
      {/if}
      {#if copyFailed}
        <p class="mg-note is-warn" role="alert">{$_("library.share.copyFailed")}</p>
      {/if}
    </div>

    <footer class="mg-footer share-actions">
      <button type="button" class="mg-btn" onclick={copyList} disabled={!shareListText || uploading}>
        {#if copied === "list"}<Check size={14} weight="bold" />{:else}<Copy size={14} weight="bold" />{/if}
        {copied === "list" ? $_("library.share.copied") : $_("library.share.copyList")}
      </button>
      <button type="button" class="mg-btn" onclick={copyImage} disabled={!imageBlob || uploading}>
        {#if copied === "image"}<Check size={14} weight="bold" />{:else}<ImageIcon size={14} weight="bold" />{/if}
        {copied === "image" ? $_("library.share.copied") : $_("library.share.copyImage")}
      </button>
      <button
        type="button"
        class="mg-btn mg-btn--primary"
        onclick={copyAll}
        disabled={!imageBlob || !shareListText || uploading}
        aria-describedby="library-share-upload-note"
        aria-live="polite"
      >
        {#if copied === "all"}<Check size={14} weight="bold" />{:else}<Copy size={14} weight="bold" />{/if}
        {uploading ? $_("library.share.uploading") : copied === "all" ? $_("library.share.copied") : $_("library.share.copyAll")}
      </button>
    </footer>
  </div>
</div>

<style>
  .share-actions {
    flex-wrap: wrap;
    justify-content: flex-end;
  }

  .share-preview {
    display: grid;
    place-items: center;
    min-height: 160px;
    border-radius: 10px;
    background: var(--bg-void);
    overflow: hidden;
  }
  .share-preview img {
    display: block;
    width: 100%;
    max-height: 46vh;
    object-fit: contain;
  }
  .share-list {
    margin: 0;
    max-height: 96px;
    overflow: auto;
    padding: 10px 12px;
    border-radius: 8px;
    background: var(--bg-surface);
    color: var(--text-secondary);
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: var(--text-xs);
    line-height: 1.6;
    white-space: pre-wrap;
    word-break: break-word;
  }
</style>
