import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { JSDOM } from "jsdom";

import {
  addBackup,
  addLibraryWork,
  addRepository,
  chooseEntryPath,
  completeBackupRestore,
  completeSync,
  completeTrackerConnection,
  continueFromTrackers,
  continueFromSources,
  continueFromTheme,
  createFirstRunState,
  deferFirstRun,
  installExtension,
  loadRepositoryCatalog,
  getFirstRunMotionDirection,
  getVisibleExtensions,
  installVisibleExtensions,
  startTrackerConnection,
  removeBackup,
  recoverInterruptedTrackerConnection,
  restartFirstRun,
  resumeFirstRun,
  reviewBackups,
  selectTheme,
  summarizeBackups,
} from "./epigraph-first-run-state.mjs";
import { FIRST_RUN_STEPS, TRACKER_PROVIDERS } from "./epigraph-first-run-catalog.mjs";

test("first-run catalogs are the single extension point for steps and trackers", () => {
  assert.deepEqual(FIRST_RUN_STEPS.map((step) => step.id), ["theme", "entry", "configure", "trackers", "library"]);
  assert.ok(TRACKER_PROVIDERS.some((provider) => provider.id === "anilist"));
  assert.ok(TRACKER_PROVIDERS.some((provider) => provider.id === "hardcover"));
  assert.equal(new Set(TRACKER_PROVIDERS.map((provider) => provider.id)).size, TRACKER_PROVIDERS.length);
});

test("every setup path offers optional tracker connections before the library", () => {
  const synced = completeSync(chooseEntryPath(continueFromTheme(createFirstRunState()), "sync"), { hasLibrary: true });
  assert.equal(synced.page, "trackers");
  assert.equal(synced.trackerNextPage, "complete");

  let connected = startTrackerConnection(synced, "anilist");
  assert.equal(connected.connectingTrackerId, "anilist");
  assert.equal(startTrackerConnection(connected, "kitsu").connectingTrackerId, "anilist");
  connected = completeTrackerConnection(connected, "anilist");
  assert.deepEqual(connected.connectedTrackerIds, ["anilist"]);
  assert.equal(continueFromTrackers(connected).page, "complete");

  const fresh = continueFromSources({
    ...createFirstRunState(),
    page: "sources",
    repositories: [{ id: "repo", kind: "manga", status: "ready", extensions: [{ id: "ext" }] }],
    installedExtensionIds: ["ext"],
  });
  assert.equal(fresh.page, "trackers");
  assert.equal(fresh.trackerNextPage, "discover");
  assert.equal(continueFromTrackers(fresh).page, "discover");
});

test("an interrupted tracker login recovers to a retryable state", () => {
  const trackers = completeSync(chooseEntryPath(continueFromTheme(createFirstRunState()), "sync"), { hasLibrary: true });
  const connecting = startTrackerConnection(trackers, "anilist");
  const recovered = recoverInterruptedTrackerConnection(connecting);
  assert.equal(recovered.connectingTrackerId, null);
  assert.match(recovered.trackerError, /interrompido/i);
  assert.equal(startTrackerConnection(recovered, "anilist").connectingTrackerId, "anilist");
});

test("motion follows the direction of the first-run journey", () => {
  assert.equal(getFirstRunMotionDirection("theme", "entry"), "forward");
  assert.equal(getFirstRunMotionDirection("entry", "theme"), "back");
  assert.equal(getFirstRunMotionDirection("backups", "backup-review"), "forward");
  assert.equal(getFirstRunMotionDirection("backup-review", "sources"), "forward");
  assert.equal(getFirstRunMotionDirection("deferred", "sources"), "forward");
  assert.equal(getFirstRunMotionDirection("complete", "theme"), "back");
  assert.equal(getFirstRunMotionDirection("sources", "sources"), "none");
});

test("starts with theme selection before migration choices", () => {
  assert.deepEqual(createFirstRunState(), {
    page: "theme",
    theme: "light",
    entryPath: null,
    syncStatus: "idle",
    syncError: null,
    backupFiles: [],
    backupStatus: "idle",
    backupError: null,
    repositories: [],
    installedExtensionIds: [],
    libraryWorkIds: [],
    connectedTrackerIds: [],
    connectingTrackerId: null,
    trackerError: null,
    trackerNextPage: null,
    trackerPreviousPage: null,
    pendingRepositoryKinds: [],
    pendingExtensionIds: [],
    restoredLibraryCount: 0,
    deferredFrom: null,
  });
});

test("applies a built-in theme and advances to entry choice", () => {
  const themed = selectTheme(createFirstRunState(), "light");
  assert.equal(continueFromTheme(themed).page, "entry");
  assert.equal(themed.theme, "light");
  assert.throws(() => selectTheme(themed, "unknown"), /Unknown theme/);
});

test("offers exclusive sync, backup, and clean setup paths", () => {
  const entry = continueFromTheme(createFirstRunState());
  assert.equal(chooseEntryPath(entry, "sync").page, "sync");
  assert.equal(chooseEntryPath(entry, "backup").page, "backups");
  assert.equal(chooseEntryPath(entry, "fresh").page, "sources");
});

test("sync skips source setup when it brings a library", () => {
  const sync = chooseEntryPath(continueFromTheme(createFirstRunState()), "sync");
  assert.equal(completeSync(sync, { hasLibrary: true }).trackerNextPage, "complete");
  assert.equal(completeSync(sync, { hasLibrary: false }).trackerNextPage, "discover");
});

test("accepts multiple supported backup families and removes individual files", () => {
  let backups = chooseEntryPath(continueFromTheme(createFirstRunState()), "backup");
  backups = addBackup(backups, { id: "m1", name: "mihon.tachibk", kind: "manga", workCount: 42 });
  backups = addBackup(backups, { id: "n1", name: "lnreader.zip", kind: "novels-lnreader", workCount: 8 });
  assert.deepEqual(backups.backupFiles.map((file) => file.kind), ["manga", "novels-lnreader"]);
  assert.deepEqual(removeBackup(backups, "m1").backupFiles.map((file) => file.id), ["n1"]);
});

test("backup review requires a file and never routes through manual repositories", () => {
  let backups = chooseEntryPath(continueFromTheme(createFirstRunState()), "backup");
  assert.equal(reviewBackups(backups).page, "backups");
  backups = addBackup(backups, { id: "e1", name: "library.epigraphbk", kind: "epigraph", workCount: 14 });
  const review = reviewBackups(backups);
  assert.equal(review.page, "backup-review");
  assert.equal(completeBackupRestore(review, { hasLibrary: true }).trackerNextPage, "complete");
  assert.equal(completeBackupRestore(review, { hasLibrary: false }).trackerNextPage, "discover");
});

test("backup review summary is derived from the selected files", () => {
  let backups = chooseEntryPath(continueFromTheme(createFirstRunState()), "backup");
  backups = addBackup(backups, { id: "m", name: "mihon.tachibk", kind: "manga", workCount: 42, repositoryCount: 2, extensionCount: 3, conflictCount: 2, libraryKinds: ["quadrinhos"] });
  backups = addBackup(backups, { id: "n", name: "lnreader.zip", kind: "novels-lnreader", workCount: 8, repositoryCount: 1, extensionCount: 2, conflictCount: 0, libraryKinds: ["novels"] });
  assert.deepEqual(summarizeBackups(backups), { workCount: 50, repositoryCount: 3, extensionCount: 5, conflictCount: 2, kinds: ["quadrinhos", "novels"] });
  assert.equal(summarizeBackups(removeBackup(backups, "m")).workCount, 8);
});

test("backup restore provisions reviewed repositories and extensions", () => {
  let backups = chooseEntryPath(continueFromTheme(createFirstRunState()), "backup");
  backups = addBackup(backups, { id: "m", name: "mihon.tachibk", kind: "manga", workCount: 42, repositoryCount: 2, extensionCount: 3 });
  const restored = completeBackupRestore(reviewBackups(backups), { hasLibrary: true });
  assert.equal(restored.repositories.length, 2);
  assert.equal(restored.installedExtensionIds.length, 3);
  assert.equal(restored.page, "trackers");
  assert.equal(restored.trackerNextPage, "complete");
});

test("Mihon and Tachiyomi backups require a comics repository after restore", () => {
  let backups = chooseEntryPath(continueFromTheme(createFirstRunState()), "backup");
  backups = addBackup(backups, {
    id: "mihon",
    name: "mihon.tachibk",
    kind: "manga",
    workCount: 42,
    repositoryCount: 0,
    extensionCount: 0,
    requiredRepositoryKinds: ["manga"],
    requiredExtensionIds: ["manga-source"],
  });

  let restored = completeBackupRestore(reviewBackups(backups), { hasLibrary: true });
  assert.equal(restored.page, "sources");
  assert.deepEqual(restored.pendingRepositoryKinds, ["manga"]);

  restored = addRepository(restored, { id: "repo-manga", url: "https://example.com/index.min.json", kind: "manga" });
  restored = loadRepositoryCatalog(restored, "repo-manga", [{ id: "manga-source", name: "Manga source", language: "pt-BR" }]);
  restored = installExtension(restored, "manga-source");

  assert.equal(continueFromSources(restored).trackerNextPage, "complete");
  assert.deepEqual(continueFromSources(restored).pendingRepositoryKinds, []);
});

test("backup setup shows and installs only extensions referenced by the backup", () => {
  let backups = chooseEntryPath(continueFromTheme(createFirstRunState()), "backup");
  backups = addBackup(backups, {
    id: "mihon",
    name: "mihon.tachibk",
    kind: "manga",
    workCount: 42,
    requiredRepositoryKinds: ["manga"],
    requiredExtensionIds: ["used-a", "used-b"],
  });
  let sources = completeBackupRestore(reviewBackups(backups), { hasLibrary: true });
  sources = addRepository(sources, { id: "repo", url: "https://example.com/index.min.json", kind: "manga" });
  sources = loadRepositoryCatalog(sources, "repo", [
    { id: "used-a", name: "Fonte usada A" },
    { id: "used-b", name: "Fonte usada B" },
    { id: "irrelevant", name: "Fonte não usada" },
  ]);

  assert.deepEqual(getVisibleExtensions(sources).map((extension) => extension.id), ["used-a", "used-b"]);
  assert.equal(continueFromSources(installExtension(sources, "used-a")).page, "sources");

  const installed = installVisibleExtensions(sources);
  assert.deepEqual(installed.installedExtensionIds, ["used-a", "used-b"]);
  assert.equal(continueFromSources(installed).page, "trackers");
  assert.ok(!installed.installedExtensionIds.includes("irrelevant"));
});

test("manual setup loads extensions beside each repository and requires an install", () => {
  let sources = chooseEntryPath(continueFromTheme(createFirstRunState()), "fresh");
  sources = addRepository(sources, { id: "repo-1", url: "https://example.com/index.min.json", kind: "manga" });
  sources = loadRepositoryCatalog(sources, "repo-1", [
    { id: "ext-pt", name: "Fonte PT-BR", language: "pt-BR" },
    { id: "ext-en", name: "Source EN", language: "en" },
  ]);
  assert.equal(sources.repositories[0].extensions.length, 2);
  assert.equal(continueFromSources(sources).page, "sources");
  sources = installExtension(sources, "ext-pt");
  assert.equal(continueFromSources(sources).trackerNextPage, "discover");
});

test("discovery can add works before completion", () => {
  let state = chooseEntryPath(continueFromTheme(createFirstRunState()), "fresh");
  state = addRepository(state, { id: "repo", url: "https://example.com/plugins.min.json", kind: "novels" });
  state = loadRepositoryCatalog(state, "repo", [{ id: "novel-source", name: "Novel Source", language: "en" }]);
  state = continueFromTrackers(continueFromSources(installExtension(state, "novel-source")));
  state = addLibraryWork(state, "work-1");
  assert.deepEqual(state.libraryWorkIds, ["work-1"]);
});

test("defer and resume preserve the exact useful task", () => {
  const sources = chooseEntryPath(continueFromTheme(createFirstRunState()), "fresh");
  const deferred = deferFirstRun(sources);
  assert.equal(deferred.page, "deferred");
  assert.equal(resumeFirstRun(deferred).page, "sources");
});

test("restart returns a completed demonstration to the first page", () => {
  const completed = { ...createFirstRunState(), page: "complete", theme: "nocturne", libraryWorkIds: ["work-1"] };
  assert.deepEqual(restartFirstRun(completed), createFirstRunState());
});

test("transitions are immutable and duplicate additions are idempotent", () => {
  const initial = createFirstRunState();
  const original = structuredClone(initial);
  const themed = selectTheme(initial, "amoled");
  assert.notEqual(themed, initial);
  assert.deepEqual(initial, original);

  let sources = chooseEntryPath(continueFromTheme(initial), "fresh");
  sources = addRepository(sources, { id: "repo", url: "https://example.com/index.min.json", kind: "manga" });
  sources = loadRepositoryCatalog(sources, "repo", [{ id: "same", name: "Same", language: "pt-BR" }]);
  sources = installExtension(installExtension(sources, "same"), "same");
  sources = installExtension(sources, "not-in-catalog");
  sources = addLibraryWork(addLibraryWork(sources, "same-work"), "same-work");
  assert.deepEqual(sources.installedExtensionIds, ["same"]);
  assert.deepEqual(sources.libraryWorkIds, ["same-work"]);
});

test("mockup names the real Epigraph flows and uses its theme token contract", async () => {
  const html = await readFile(new URL("./epigraph-first-run.html", import.meta.url), "utf8");
  const visualCss = await readFile(new URL("./epigraph-first-run-visual.css", import.meta.url), "utf8");
  assert.match(html, /src\/styles\/tokens\.css/);
  assert.match(html, /builtin-themes\.generated\.css/);
  assert.match(html, /epigraph-first-run-visual\.css\?v=9/);
  assert.match(html, /Mihon|Tachiyomi/);
  assert.match(html, /LNReader/);
  assert.match(html, /Sincronizar dispositivo/);
  assert.match(html, /data-action="add-repository"/);
  assert.match(html, /data-action="install-all-extensions"/);
  assert.match(html, /class="button bulk-install"/);
  assert.match(html, /getVisibleExtensions\(state\)/);
  assert.match(html, /As extensões usadas neste backup não foram encontradas neste repositório/);
  assert.match(html, /data-page="discover"/);
  assert.match(html, /data-page="trackers"/);
  assert.match(html, /data-tracker-list/);
  assert.match(html, /FIRST_RUN_STEPS/);
  assert.match(html, /TRACKER_PROVIDERS/);
  assert.match(html, /localStorage\.setItem\(storageKey/);
  assert.match(html, /data-backup-conflict-list/);
  assert.match(html, /Backups Mihon\/Tachiyomi não incluem repositórios/);
  assert.match(html, /<html lang="pt-BR" data-theme="light">/);
  assert.match(html, /document\.startViewTransition/);
  assert.match(html, /dataset\.motionDirection/);
  assert.match(html, /page === "deferred" \? \(state\.deferredFrom/);
  assert.match(html, /class="step-icon" aria-hidden="true"/);
  assert.match(html, /step\.setAttribute\("aria-label"/);
  assert.doesNotMatch(html, /grid-template-columns:\s*236px/);
  assert.doesNotMatch(html, /class="lede"/);
  assert.doesNotMatch(html, /A alteração é aplicada agora|Escolha a origem principal|Use o fluxo de pareamento|Você pode combinar arquivos|Cole um ou mais links|Pesquise pelo nome ou escolha|Um checklist discreto/);
  assert.doesNotMatch(html, /class="extension-details" open/);
  assert.match(html, /class="notice" data-source-context hidden/);
  assert.match(html, /restoreState\.hidden = !\["restoring", "error"\]\.includes\(state\.backupStatus\)/);
  assert.match(visualCss, /\.eyebrow,[\s\S]*color: var\(--accent\)/);
  assert.match(visualCss, /\.backup-row small,[\s\S]*color: var\(--text-secondary\)/);
  assert.match(visualCss, /\.supports-view-transitions \.page\.is-active/);
  assert.match(visualCss, /html\[data-motion-direction="back"\]::view-transition-new\(setup-page\)/);
  assert.match(visualCss, /\.button:not\(:disabled\):not\(\[aria-disabled="true"\]\):hover \.ph-arrow-right/);
  assert.match(visualCss, /\.button\.bulk-install \{[\s\S]*min-height: calc\(28px \* var\(--app-resolution-scale\)\)[\s\S]*background: transparent/);
  assert.match(visualCss, /animation: item-settle var\(--duration-relaxed\) var\(--easing-emphasized\) backwards/);
  assert.doesNotMatch(visualCss, /animation: item-settle[^;]*\bboth\b/);
  assert.match(visualCss, /prefers-reduced-motion: reduce/);
  assert.match(visualCss, /@media \(max-width: 360px\)[\s\S]*\.checklist/);
  assert.match(visualCss, /@media \(max-width: 560px\)[\s\S]*h1 \{\s*font-size: 32px/);
  assert.match(visualCss, /\.rail \{[\s\S]*width: min\(100%, 760px\)/);
  assert.match(visualCss, /\.page-inner \{[\s\S]*width: min\(100%, 760px\)/);
  assert.match(visualCss, /h1 \{[\s\S]*font-size: clamp\(30px, 3\.4vw, 42px\)/);
  assert.match(visualCss, /\.footer-actions \{[\s\S]*position: static/);
  assert.match(visualCss, /\.two-column \{[\s\S]*max-width: 640px/);
  assert.match(visualCss, /\.complete-layout \{[\s\S]*width: min\(100%, 760px\)/);
  assert.match(visualCss, /\.complete-mark i \{[\s\S]*line-height: 1/);
  assert.match(visualCss, /\.check-row \{[\s\S]*align-items: center[\s\S]*font-size: var\(--text-md\)/);
  assert.match(visualCss, /\.check-row i \{[\s\S]*line-height: 1/);
  assert.doesNotMatch(visualCss, /scrollbar-gutter: stable/);
  assert.doesNotMatch(visualCss, /@supports \(view-transition-name/);
});

test("rendered component styles center icons and keep metadata below primary content", async () => {
  const html = await readFile(new URL("./epigraph-first-run.html", import.meta.url), "utf8");
  const tokensCss = await readFile(new URL("../../src/styles/tokens.css", import.meta.url), "utf8");
  const visualCss = await readFile(new URL("./epigraph-first-run-visual.css", import.meta.url), "utf8");
  const baseCss = html.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? "";
  const dom = new JSDOM(`<!doctype html><style>${tokensCss}\n${baseCss}\n${visualCss}</style>
    <div class="backup-row"><i class="ph ph-image-square"></i><span><strong>mihon.tachibk</strong><small>42 obras encontradas</small></span><span class="tag">Mihon / Tachiyomi</span><button class="icon-button"><i class="ph ph-x"></i></button></div>
    <button class="button primary">Concluir restauração</button><button class="button small">Adicionar</button>`);
  const { getComputedStyle } = dom.window;
  const icon = dom.window.document.querySelector(".backup-row > i");
  const primary = dom.window.document.querySelector(".backup-row strong");
  const metadata = dom.window.document.querySelector(".backup-row small");
  const tag = dom.window.document.querySelector(".tag");
  const button = dom.window.document.querySelector(".button.primary");
  const smallButton = dom.window.document.querySelector(".button.small");

  assert.equal(getComputedStyle(icon).display, "grid");
  assert.equal(getComputedStyle(icon).placeItems, "center");
  assert.equal(getComputedStyle(primary).fontSize, "var(--text-md)");
  assert.equal(getComputedStyle(metadata).fontSize, "var(--text-sm)");
  assert.equal(getComputedStyle(tag).fontSize, "var(--text-xs)");
  assert.equal(getComputedStyle(button).minHeight, "calc(36px * var(--app-resolution-scale))");
  assert.equal(getComputedStyle(smallButton).minHeight, "calc(32px * var(--app-resolution-scale))");
  assert.equal(getComputedStyle(button).fontFamily, "var(--font-ui)");
});
