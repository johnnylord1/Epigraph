<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { CheckCircle, GitBranch, WarningCircle } from "phosphor-svelte";
  import { _ } from "../../lib/i18n/runtime";
  import { applyServiceIconFallback, resolveServiceIconUrl } from "../../lib/assets/serviceIconResolver";
  import { createProductionMangaDependencySession, type MangaDependencyPlan, type MangaRestoreChoices } from "../../lib/backup/mangaRestoreDependencies";
  import { createProductionNovelDependencySession, type NovelDependencyPlan } from "../../lib/backup/restoreDependencies";
  import type { BackupWorkflowFile } from "../../lib/backup/backupWorkflow";
  import { fetchRepoEntries } from "../../lib/extensionSourceMap";
  import { extensionStoreBaseUrl, extensionStoreKey } from "../../lib/manga/runtime/storeUrl";
  import { parseNovelCatalogEntries } from "../../lib/novels/repositories";
  import { repositoryAvatar, repositoryLabel } from "../../lib/repositoryIdentity";

  // First Run informs instead of asking: everything listed here is installed by "Restore all".
  type ItemState = "pending" | "working" | "done" | "failed";
  // Icons in the order to try: a repository can name an icon it no longer hosts.
  // A failed row says why (a message key), so "not installed" is never left unexplained.
  type Item = { key: string; name: string; detail: string; icons: string[]; state: ItemState; reason?: string };
  type MangaSession = Awaited<ReturnType<typeof createProductionMangaDependencySession>>;
  type NovelSession = Awaited<ReturnType<typeof createProductionNovelDependencySession>>;
  type NovelPlugin = NovelDependencyPlan["plugins"][number];

  let { entries, disabled = false, choices = {}, onChoices = () => {}, onCounts = () => {} }: {
    entries: BackupWorkflowFile[];
    disabled?: boolean;
    choices?: Record<string, MangaRestoreChoices>;
    onChoices?: (key: string, choices: MangaRestoreChoices) => void;
    /** What this list shows, so the review totals count the same rows. */
    onCounts?: (counts: { repositories: number; extensions: number }) => void;
  } = $props();

  let repositories = $state<Item[]>([]);
  let extensions = $state<Item[]>([]);
  let plugins = $state<Item[]>([]);
  let mangaPlans = $state<Record<string, MangaDependencyPlan>>({});
  let checking = $state(true);
  const mangaSessions = new Map<string, MangaSession>();
  const novelSessions = new Map<string, { session: NovelSession; plan: NovelDependencyPlan }>();
  let preparing: Promise<void> | null = null;
  let detached = false;
  onDestroy(() => { detached = true; });
  onMount(() => { void prepare().then(describe).catch(() => {}); });

  const total = $derived(repositories.length + extensions.length + plugins.length);
  $effect(() => {
    if (!checking) onCounts({ repositories: repositories.length, extensions: extensions.length + plugins.length });
  });
  const choosable = $derived(Object.entries(mangaPlans).flatMap(([key, plan]) => plan.sources
    .filter(source => source.candidates.some(candidate => candidate.sourceId !== source.orphanSourceId))
    .map(source => ({ key, source }))));

  const extensionName = (name: string) => name.replace(/^Tachiyomi:\s*/i, "").trim();
  const languageLabel = (lang: string | null | undefined) => lang && lang !== "all" ? lang.toUpperCase() : "";
  const icons = (...urls: (string | null | undefined)[]) => urls.filter((url): url is string => Boolean(url));
  // v2 catalogs give each source its language; an extension with several is multilingual.
  const catalogLanguage = (extension: { lang?: string; sources?: { lang?: string }[] }) =>
    new Set(extension.sources?.map(source => source.lang).filter(Boolean)).size > 1 ? "all" : extension.lang;

  function missingRepositories(plan: MangaDependencyPlan) {
    return plan.requiredRepositories.filter(url => !plan.repositories.some(repo => extensionStoreKey(repo.indexUrl) === extensionStoreKey(url)));
  }
  function installableExtensions(plan: MangaDependencyPlan) {
    return plan.extensions.filter(extension => !extension.isInstalled && extension.storeId);
  }
  // A plugin offered by exactly one repository needs no decision; with several, a trusted one wins.
  function novelRepository(plugin: NovelPlugin) {
    return plugin.selectedRepositoryUrl
      ?? plugin.candidates.find(candidate => candidate.trusted && candidate.enabled)?.repositoryUrl
      ?? plugin.candidates[0]?.repositoryUrl ?? "";
  }
  const pendingPlugins = (plan: NovelDependencyPlan) => plan.plugins.filter(plugin => plugin.status === "needs-selection" && novelRepository(plugin));

  function upsert(list: Item[], item: Omit<Item, "state">) {
    const existing = list.find(entry => entry.key === item.key);
    if (existing) {
      for (const url of item.icons) if (!existing.icons.includes(url)) existing.icons.push(url);
      return;
    }
    list.push({ ...item, state: "pending" });
  }
  function mark(list: Item[], key: string, state: ItemState, reason?: string) {
    const item = list.find(entry => entry.key === key);
    if (!item) return;
    item.state = state;
    item.reason = state === "failed" ? reason : undefined;
  }

  async function prepare() {
    preparing ??= (async () => {
      for (const entry of entries) {
        if (detached) return;
        if (entry.libraryKinds.includes("manga")) {
          try {
            const session = await createProductionMangaDependencySession(entry.file, entry.plan ? "epigraph" : "native");
            const plan = await session.inspect();
            if (detached) return;
            mangaSessions.set(entry.key, session);
            mangaPlans[entry.key] = plan;
            for (const url of missingRepositories(plan)) {
              upsert(repositories, { key: extensionStoreKey(url), name: plan.repositoryNames?.[url] ?? repositoryLabel(url), detail: repositoryLabel(url), icons: icons(repositoryAvatar(url)) });
            }
            for (const extension of installableExtensions(plan)) {
              upsert(extensions, { key: extension.packageName, name: extensionName(extension.name ?? extension.packageName), detail: languageLabel(extension.language), icons: icons(extension.iconUrl) });
            }
          } catch (error) { console.warn("[first-run] manga dependencies unavailable", error); }
        }
        if (entry.libraryKinds.includes("novels")) {
          try {
            const session = await createProductionNovelDependencySession(entry.file, entry.kind === "novels-lnreader" ? "lnreader" : "epigraph");
            const plan = await session.inspect();
            if (detached) return;
            novelSessions.set(entry.key, { session, plan });
            for (const plugin of pendingPlugins(plan)) {
              const url = novelRepository(plugin);
              if (!plugin.candidates.some(candidate => candidate.repositoryUrl === url && candidate.repositoryId)) {
                upsert(repositories, { key: url, name: repositoryLabel(url), detail: repositoryLabel(url), icons: icons(repositoryAvatar(url)) });
              }
              upsert(plugins, { key: plugin.pluginId, name: plugin.pluginId, detail: repositoryLabel(url), icons: [] });
            }
          } catch (error) { console.warn("[first-run] novel dependencies unavailable", error); }
        }
      }
      checking = false;
    })();
    return preparing;
  }

  // Names and icons of what comes from repositories that are not added yet, read from their public catalogs.
  async function describe() {
    const backupSources = new Set(Object.values(mangaPlans).flatMap(plan => plan.sources.map(source => source.orphanSourceId)));
    const installed = new Set(Object.values(mangaPlans).flatMap(plan => plan.extensions.filter(extension => extension.isInstalled).map(extension => extension.packageName)));
    const mangaRepos = [...new Set(Object.values(mangaPlans).flatMap(missingRepositories))];
    const novelRepos = [...new Set([...novelSessions.values()].flatMap(({ plan }) => pendingPlugins(plan).map(novelRepository)))];
    await Promise.all([
      ...mangaRepos.map(async url => {
        const { entries: catalog } = await fetchRepoEntries([url]);
        if (detached) return;
        for (const extension of catalog) {
          if (installed.has(extension.pkg) || !extension.sources?.some(source => backupSources.has(String(source.id)))) continue;
          upsert(extensions, { key: extension.pkg, name: extensionName(extension.name), detail: languageLabel(catalogLanguage(extension)),
            icons: icons(extension.icon ?? `${extensionStoreBaseUrl(url)}/icon/${extension.pkg}.png`) });
        }
      }),
      ...novelRepos.map(async url => {
        try {
          const response = await fetch(url);
          if (!response.ok) return;
          const catalog = parseNovelCatalogEntries(await response.json(), { repositoryId: url });
          if (detached) return;
          for (const item of plugins) {
            const match = catalog.find(entry => entry.pluginId === item.key);
            if (!match) continue;
            item.name = match.name;
            if (match.iconUrl && !item.icons.includes(match.iconUrl)) item.icons.push(match.iconUrl);
            item.detail = languageLabel(match.lang) || item.detail;
          }
        } catch { /* names stay as plugin ids */ }
      }),
    ]);
  }

  async function installManga(session: MangaSession, key: string) {
    let plan = mangaPlans[key];
    const missing = missingRepositories(plan);
    if (missing.length) {
      missing.forEach(url => mark(repositories, extensionStoreKey(url), "working"));
      try {
        const added = await session.addRepositories(missing);
        plan = added.plan;
        missing.forEach(url => mark(repositories, extensionStoreKey(url), added.failed.includes(url) ? "failed" : "done", "firstRun.backup.repositoryUnavailable"));
      } catch (error) {
        console.warn("[first-run] repositories not added", error);
        missing.forEach(url => mark(repositories, extensionStoreKey(url), "failed", "firstRun.backup.repositoryUnavailable"));
      }
    }
    // Catalog previews the added repositories cannot install stay listed, with the reason, so the
    // totals shown before the restore still add up afterwards.
    const installable = installableExtensions(plan);
    const keep = new Set(installable.map(extension => extension.packageName));
    for (const item of extensions) {
      if (item.state !== "pending" || keep.has(item.key)) continue;
      const installed = plan.extensions.some(extension => extension.packageName === item.key && extension.isInstalled);
      mark(extensions, item.key, installed ? "done" : "failed", "firstRun.backup.extensionUnavailable");
    }
    for (const extension of installable) {
      upsert(extensions, { key: extension.packageName, name: extensionName(extension.name ?? extension.packageName), detail: languageLabel(extension.language), icons: icons(extension.iconUrl) });
      mark(extensions, extension.packageName, "working");
    }
    if (installable.length) {
      const approvals = installable.map(extension => ({ packageName: extension.packageName, storeId: extension.storeId! }));
      try {
        plan = await session.installMany(approvals);
      } catch {
        // One broken extension must not hold back the others.
        for (const approval of approvals) {
          try { plan = await session.install(approval); } catch (error) { console.warn("[first-run] extension not installed", approval.packageName, error); }
        }
      }
      for (const extension of installable) {
        const now = plan.extensions.find(candidate => candidate.packageName === extension.packageName);
        mark(extensions, extension.packageName, now?.isInstalled ? "done" : "failed", "firstRun.backup.installFailed");
      }
    }
    mangaPlans[key] = plan;
  }

  async function installNovels(session: NovelSession, plan: NovelDependencyPlan) {
    const pending = pendingPlugins(plan);
    if (!pending.length) return;
    const approvals = Object.fromEntries(pending.map(plugin => [plugin.pluginId, novelRepository(plugin)]));
    const urls = [...new Set(Object.values(approvals))];
    urls.forEach(url => mark(repositories, url, "working"));
    pending.forEach(plugin => mark(plugins, plugin.pluginId, "working"));
    try {
      const result = await session.apply({ repositoryUrls: urls, plugins: approvals });
      for (const plugin of pending) {
        const ready = result.plan.plugins.find(candidate => candidate.pluginId === plugin.pluginId)?.status === "ready";
        mark(plugins, plugin.pluginId, ready ? "done" : "failed", "firstRun.backup.installFailed");
      }
      urls.forEach(url => mark(repositories, url, "done"));
    } catch (error) {
      console.warn("[first-run] novel plugins not installed", error);
      pending.forEach(plugin => mark(plugins, plugin.pluginId, "failed", "firstRun.backup.installFailed"));
      urls.forEach(url => mark(repositories, url, "failed", "firstRun.backup.repositoryUnavailable"));
    }
  }

  /** Installs every listed dependency. Failures are shown on their rows and never stop the restore. */
  export async function installAll() {
    await prepare();
    for (const [key, session] of mangaSessions) {
      if (detached) return;
      await installManga(session, key);
    }
    for (const { session, plan } of novelSessions.values()) {
      if (detached) return;
      await installNovels(session, plan);
    }
  }

  function choose(key: string, sourceId: string, value: string) {
    const plan = mangaPlans[key];
    const candidate = plan?.sources.find(source => source.orphanSourceId === sourceId)?.candidates.find(candidate => `map:${candidate.sourceId}` === value);
    onChoices(key, { ...(choices[key] ?? {}), [sourceId]: candidate
      ? { mode: "map", sourceId: candidate.sourceId, name: candidate.sourceName, lang: candidate.sourceLang }
      : { mode: value === "skip" ? "skip" : "preserve" } });
  }
  // Moves to the next known icon before showing the placeholder.
  function nextIcon(event: Event, item: Item, kind: "repository" | "extension") {
    const image = event.currentTarget as HTMLImageElement;
    const index = Number(image.dataset.iconIndex ?? 0) + 1;
    if (index < item.icons.length) {
      image.dataset.iconIndex = String(index);
      image.src = resolveServiceIconUrl(item.icons[index], { kind: "extension" });
      return;
    }
    if (kind === "repository") item.icons = [];
    else applyServiceIconFallback(event, "extension");
  }
  function choiceValue(key: string, sourceId: string) {
    const choice = choices[key]?.[sourceId];
    return choice?.mode === "map" ? `map:${choice.sourceId}` : choice?.mode ?? "preserve";
  }
</script>

{#snippet group(label: string, items: Item[], kind: "repository" | "extension")}
  {#if items.length}
    <div class="dep-group">
      <p class="dep-label"><span>{label}</span><b>{items.length}</b></p>
      <ul class="dep-grid">
        {#each items as item (item.key)}
          <li class="dep-item" class:is-working={item.state === "working"} class:is-failed={item.state === "failed"} title={item.state === "failed" ? `${$_("firstRun.backup.notInstalled")}: ${$_(item.reason ?? "firstRun.backup.installFailed")}` : item.name}>
            {#if kind === "repository" && !item.icons.length}
              <span class="dep-icon dep-icon--glyph"><GitBranch size={16} /></span>
            {:else}
              <img class="dep-icon" src={resolveServiceIconUrl(item.icons[0], { kind: "extension" })} alt="" loading="lazy" decoding="async"
                onerror={event => nextIcon(event, item, kind)} />
            {/if}
            <span class="dep-copy"><strong>{item.name}</strong>{#if item.state === "failed"}<small class="dep-reason">{$_(item.reason ?? "firstRun.backup.installFailed")}</small>{:else if item.detail}<small>{item.detail}</small>{/if}</span>
            {#if item.state === "done"}<CheckCircle class="dep-state dep-state--done" size={16} weight="fill" />
            {:else if item.state === "failed"}<WarningCircle class="dep-state dep-state--failed" size={16} weight="fill" />{/if}
          </li>
        {/each}
      </ul>
    </div>
  {/if}
{/snippet}

<section class="first-run-dependencies" aria-label={$_("firstRun.backup.installsTitle")}>
  {#if checking && total === 0}
    <p class="dep-note" role="status">{$_("restoreDeps.checking")}</p>
  {:else if total === 0}
    <p class="dep-note">{$_("restoreDeps.nothingToInstall")}</p>
  {:else}
    <p class="dep-heading">{$_("firstRun.backup.installsTitle")}</p>
    {@render group($_("firstRun.backup.repositories"), repositories, "repository")}
    {@render group($_("firstRun.backup.extensions"), extensions, "extension")}
    {@render group($_("firstRun.backup.plugins"), plugins, "extension")}
  {/if}

  {#if choosable.length}
    <div class="dep-group">
      <p class="dep-label"><span>{$_("restoreDeps.replacements")}</span><b>{choosable.length}</b></p>
      {#each choosable as { key, source } (`${key}:${source.orphanSourceId}`)}
        <label class="dep-choice">
          <strong>{source.sourceName}</strong>
          <select {disabled} value={choiceValue(key, source.orphanSourceId)} onchange={event => choose(key, source.orphanSourceId, event.currentTarget.value)}>
            <option value="preserve">{$_("restoreDeps.preserve")}</option>
            <option value="skip">{$_("ui_exclude")}</option>
            {#each source.candidates as candidate}<option value={`map:${candidate.sourceId}`}>{candidate.displayName} ({candidate.sourceId})</option>{/each}
          </select>
        </label>
      {/each}
    </div>
  {/if}
</section>

<style>
  .first-run-dependencies { display: grid; gap: 12px; margin-top: 14px; }
  .dep-heading { margin: 0; color: var(--text-secondary); font-size: var(--text-base); font-weight: 700; }
  .dep-note { margin: 0; padding: 4px 8px; color: var(--text-muted); font-size: var(--text-base); }
  .dep-group { display: grid; gap: 8px; }
  .dep-label { display: flex; align-items: center; gap: 8px; margin: 0; color: var(--text-muted); font-size: 11px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; }
  .dep-label b { min-width: 20px; padding: 1px 7px; border-radius: 999px; color: var(--text-secondary); background: var(--fr-surface-strong); font-size: 11px; text-align: center; font-variant-numeric: tabular-nums; }
  .dep-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 6px; max-height: 196px; margin: 0; padding: 0; overflow-y: auto; list-style: none; scrollbar-width: thin; }
  .dep-item { display: flex; align-items: center; gap: 10px; min-width: 0; padding: 8px 10px; border-radius: 12px; background: var(--fr-surface); transition: background .3s, opacity .3s; }
  .dep-item.is-working { animation: dep-pulse 1.2s ease-in-out infinite; }
  .dep-item.is-failed { opacity: .6; }
  .dep-icon { flex: none; width: 30px; height: 30px; border-radius: 8px; object-fit: cover; background: var(--fr-surface-strong); }
  .dep-icon--glyph { display: grid; place-items: center; color: var(--accent-fg); }
  .dep-copy { display: grid; flex: 1; min-width: 0; line-height: 1.25; }
  .dep-copy strong, .dep-copy small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .dep-copy strong { color: var(--text-primary); font-size: 13px; font-weight: 600; }
  .dep-copy small { color: var(--text-muted); font-size: 11px; }
  .dep-copy .dep-reason { color: var(--color-warning, var(--color-danger)); }
  .dep-item :global(.dep-state) { flex: none; }
  .dep-item :global(.dep-state--done) { color: var(--color-success); }
  .dep-item :global(.dep-state--failed) { color: var(--color-warning, var(--color-danger)); }
  .dep-choice { display: flex; align-items: center; gap: 12px; min-width: 0; padding: 6px 10px; border-radius: 12px; background: var(--fr-surface); font-size: 13px; }
  .dep-choice strong { flex: 1; min-width: 0; overflow: hidden; color: var(--text-primary); font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
  .dep-choice select { flex-shrink: 0; max-width: 50%; min-height: 32px; padding: 6px 10px; border: 0; border-radius: 8px; color: var(--text-primary); background: var(--fr-surface-strong); font: inherit; }
  @keyframes dep-pulse { 50% { background: var(--fr-surface-strong); } }
  @media (prefers-reduced-motion: reduce) { .dep-item.is-working { animation: none; } }
</style>
