import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

const source = readFileSync(resolve(process.cwd(), "src/components/search/SearchPalette.svelte"), "utf8");
const stateSource = readFileSync(resolve(process.cwd(), "src/store/state.svelte.ts"), "utf8");
const portSource = readFileSync(resolve(process.cwd(), "src/styles/nocturne-port.css"), "utf8");
const appSource = readFileSync(resolve(process.cwd(), "src/App.svelte"), "utf8");
const homeSource = readFileSync(resolve(process.cwd(), "src/components/pages/Home.svelte"), "utf8");
const browseSource = readFileSync(resolve(process.cwd(), "src/components/pages/BrowseV3.svelte"), "utf8");
const downloadsSource = readFileSync(resolve(process.cwd(), "src/components/pages/Downloads.svelte"), "utf8");
const settingsSource = readFileSync(resolve(process.cwd(), "src/components/settings/Settings.svelte"), "utf8");
const libraryToolbarSource = readFileSync(resolve(process.cwd(), "src/components/library/LibraryToolbar.svelte"), "utf8");
const topbarSearchSources = [homeSource, browseSource, downloadsSource, settingsSource, libraryToolbarSource];

describe("SearchPalette contract", () => {
  test("exposes the keyboard and screen-reader search contract", () => {
    for (const topbarSource of topbarSearchSources) {
      expect(topbarSource).toContain('role="combobox"');
      expect(topbarSource).toContain('aria-expanded={store.searchOpen}');
      expect(topbarSource).toContain('aria-controls="aethon-search-results"');
      expect(topbarSource).toContain("aria-activedescendant={store.searchOpen ? store.searchActiveResultId ?? undefined : undefined}");
    }
    expect(source).toContain('role="listbox"');
    expect(source).toContain('role="option"');
    expect(source).toContain('event.key === "ArrowDown"');
    expect(source).toContain('event.key === "ArrowUp"');
    expect(source).toContain('event.key === "Enter"');
    expect(source).toContain('event.key === "Escape"');
    expect(source).toContain("event.stopImmediatePropagation()");
    expect(source).toContain("event.stopPropagation()");
  });

  test("keeps the shared palette free of direct colors and Nocturne internals", () => {
    expect(source).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|oklch\(|color-mix\(|linear-gradient\(|radial-gradient\(/i);
    expect(source).not.toContain("--n-");
    expect(source).toContain("var(--component-search-border)");
    expect(source).toContain("var(--component-popover-bg)");
  });

  test("restores only a connected opener in the original search context", () => {
    expect(source).toContain("function dismissSearchPalette()");
    expect(source).toContain("store.closeSearchPalette(true)");
    expect(source).toContain("store.closeSearchPalette(false)");
    expect(source).toContain("canRestoreSearchFocus(previousFocus)");
    expect(source).toContain("focusOriginNavPage !== store.navPage");
    expect(source).toContain("focusOriginLibrarySection !== store.librarySection");
    expect(stateSource).toContain("this.closeSearchPalette(false)");
    expect(stateSource).toContain("if (this.searchFocusRestoreInProgress) return");
    expect(stateSource).toContain("restoreSearchFocus(target: HTMLElement)");
    expect(source.indexOf('setNavPage("library")')).toBeLessThan(source.indexOf("setActiveBookId(result.action.bookId)"));
    expect(source.indexOf('setNavPage("library")')).toBeLessThan(source.indexOf("setLibraryFilter(result.action.collectionId)"));
  });

  test("keeps keyboard selection inside internal result scrollers", () => {
    expect(source).toContain("function keepWithinContainer");
    expect(source).toContain("function moveActiveResult");
    expect(source).toContain("container.scrollLeft");
    expect(source).toContain("container.scrollTop");
    expect(source).toContain('".search-palette__results"');
    expect(source).toContain('".search-palette__group-results.is-work-grid"');
    expect(source).not.toContain("activeItem.scrollIntoView");
  });

  test("uses one stable polite region for empty, no-results, and error feedback", () => {
    expect(source).toContain("const liveStatusMessage = $derived.by");
    expect(source).toContain('class="search-palette__live-status"');
    expect(source).toContain('role="status"');
    expect(source).toContain('aria-live="polite"');
    expect(source).toContain('aria-atomic="true"');
    expect(source.match(/role="status"/g)).toHaveLength(1);
  });

  test("does not repeat duplicate global queries or publish stale Browse responses", () => {
    const runQuery = source.slice(
      source.indexOf("function runQuery(value: string)"),
      source.indexOf("function keepWithinContainer"),
    );
    expect(runQuery.indexOf("if (queryKey === lastQueryKey) return")).toBeLessThan(
      runQuery.indexOf("activeController?.cancel()"),
    );
    expect(source).toContain("requestId !== browseRequestId");
    expect(source).toContain("browseAbortController?.abort()");
  });

  test("bounds remote work and keeps novel source search in its explicit domain", () => {
    expect(source).toContain("Math.min(6, items.length)");
    expect(source).toContain("8000");
    expect(source).toContain("}, 250)");
    expect(source).toContain("loaded.filter((source) => source.enabled)");
    expect(source).toContain("preferredLanguageSources");
  });

  test("keeps remote source search behind the explicit Browse scope action", () => {
    expect(source).toContain("const browseSearchAction: SearchResult | null = $derived.by");
    expect(source).toContain('id: "action:search-in-browse"');
    expect(source).toContain('if (!query || renderedContext === "browse" || paletteView === "browse") return null');
    expect(source).toContain('paletteView = "browse"');
    expect(source).toContain("void runBrowseSubviewSearch(result.action.query)");
    expect(source).toContain('paletteView === "browse" ? browseDisplayResults : globalDisplayResults');
    expect(source).not.toContain("openSearchKeyword()");
    expect(source).not.toContain("setSearchPrefill(result.action.query)");
    expect(source).not.toContain('from "../../lib/client"');
    expect(source).not.toContain("GET_SOURCES");
    expect(source).toContain("getManagedSourceRuntime");
    expect(source).toContain("runtime.listSources(controller.signal)");
  });

  test("keeps Browse source results in a modal subview with a reversible local state", () => {
    expect(source).toContain('type PaletteView = "global" | "browse"');
    expect(source).toContain("function returnToGlobalSearch()");
    expect(source).toContain('data-browse-source={group.id}');
    expect(source).toContain('data-browse-source-row={group.id}');
    expect(source).toContain('data-browse-result-key={result.id}');
    expect(source).toContain('$_("browse.search.backToGlobal")');
    expect(source).toContain('$_("browse.search.resultsTitle")');
    expect(source).toContain('key === "ArrowLeft"');
    expect(source).toContain('key === "ArrowRight"');
  });

  test("keeps the opener expanded while the palette owns search focus", () => {
    expect(portSource).toContain("body.aethon-search-engaged .n-topbar .n-search");
    expect(portSource).toContain("width: var(--shell-search-width-focus)");
    expect(portSource).toContain("box-shadow: var(--component-search-shadow-focus)");
    expect(portSource).toContain(".n-search:focus-within");
    expect(portSource).toContain(".n-search:focus-within:not(.is-search-focus-restored)");
    expect(portSource).toContain(".n-search.is-search-focus-restored .n-search__input:focus-visible");
    expect(portSource).toMatch(/is-search-focus-restored[\s\S]*outline: none/);
  });

  test("requires a non-empty query before rendering the palette", () => {
    expect(stateSource).toContain("if (!query.trim()) return");
    expect(stateSource).toContain("searchEngaged:");
    expect(stateSource).toContain("engageSearch()");
    expect(source).toContain("if (!value.trim())");
    expect(source).toContain("dismissSearchPalette()");
    expect(appSource).toContain('ensureLazyComponent("searchPalette")');
    expect(appSource).toContain("shellReady || store.searchEngaged");
    expect(appSource).toContain('.aethon-app-shell .search-palette');
    expect(appSource).toContain(":not(.search-palette)");
    expect(appSource).toContain("animation-play-state: running !important");
  });

  test("keeps the topbar inputs controlled without a bind-value race", () => {
    expect(homeSource).toContain("value={homeSearch}");
    expect(browseSource).toContain("value={searchQuery}");
    expect(downloadsSource).toContain("value={searchQuery}");
    expect(settingsSource).toContain("value={settingsSearchQuery}");
    expect(homeSource).not.toContain("bind:value={homeSearch}");
    expect(browseSource).not.toContain("bind:value={searchQuery}");
    expect(downloadsSource).not.toContain("bind:value={searchQuery}");
    expect(settingsSource).not.toContain("bind:value={settingsSearchQuery}");
  });

  test("renders work results as a single responsive Library-style card row", () => {
    expect(source).toContain("function isWorkResult");
    expect(source).toContain("class:is-work-grid={group.entries.every(isWorkResult)}");
    expect(source).toContain("class:is-work-card={isWorkResult(result)}");
    expect(source).toContain("overflow-x: auto");
    expect(source).toContain("--search-work-card-width: clamp(116px, 10vw, 128px)");
    expect(source).toContain("--search-work-card-width: clamp(108px, 18vw, 116px)");
    expect(source).toContain("flex: 0 0 var(--search-work-card-width)");
    expect(source).toContain("min-width: var(--search-work-card-width)");
    expect(source).toContain("var(--component-library-card-cover-border)");
    expect(source).toContain("var(--component-library-card-cover-shadow)");
    expect(source).toContain("border-radius: var(--radius-xl)");
    expect(source).toContain("resultWorkSource(result)");
    expect(source).toContain("resultWorkStatus(result)");
    expect(source).toContain("search-palette__result-work-meta");
    expect(source).toContain("font-size: var(--text-xs)");
    expect(source).toContain("font-size: var(--text-2xs)");
    expect(source).toContain("min-height: calc(var(--leading-tight) * 2em)");
    expect(source).toContain('title={resultWorkSource(result)}');
    expect(source).toContain('title={resultWorkStatus(result)}');
    expect(source).toContain("var(--component-library-card-meta-strong-fg)");
    expect(source).toContain(".search-palette__group-label span { color: var(--text-tertiary); }");
  });

  test("keeps source states compact and avoids duplicate structured language labels", () => {
    expect(source).toContain("function sourceLabelAlreadyIncludesLanguage");
    expect(source).toContain("lastIndexOf(\"(\")");
    expect(source).toContain("!sourceLabelAlreadyIncludesLanguage(group.label, group.lang)");
    expect(source).toContain("class:is-compact={groupIsCompact}");
    expect(source).toContain("search-palette__source-state is-empty");
    expect(source).toContain("search-palette__compact-state");
    expect(source).not.toContain("{:else if group.results.length === 0}");
    expect(source).toContain("border-top: 1px solid var(--divider)");
  });

  test("matches loading geometry to the final compact work card", () => {
    expect(source).toContain("search-palette__skeleton-card");
    expect(source).toContain("search-palette__skeleton-cover");
    expect(source).toContain("search-palette__skeleton-copy");
    expect(source).toContain("search-palette__skeleton-title");
    expect(source).toContain("search-palette__skeleton-meta");
    expect(source).toContain("{#each Array(5)");
    expect(source).toContain("width: var(--search-work-card-width)");
    expect(source).toContain("aspect-ratio: 2 / 3");
    expect(source).toContain("border: 1px solid transparent");
    expect(source).toContain("min-height: calc(var(--leading-snug) * 2em)");
    expect(source).toContain("min-height: calc((var(--leading-tight) * 2em) + 1px)");
  });

  test("separates implicit Enter selection from keyboard-visible card selection", () => {
    expect(source).toContain("let keyboardNavigationStarted = $state(false)");
    expect(source).toContain("keyboardNavigationStarted = true");
    expect(source).toContain("class:is-active={keyboardNavigationStarted && result.id === activeResult()?.id}");
    expect(source).toContain("border-color: var(--component-search-border-focus)");
    expect(source).toContain("box-shadow: inset 0 0 0 1px var(--component-search-border-focus)");
  });

  test("keeps hover subordinate to the active keyboard result", () => {
    expect(source).toContain(".search-palette__result:hover {");
    expect(source).toContain("background: var(--component-popover-item-hover-bg)");
    expect(source).toContain(".search-palette__result.is-active:hover");
    expect(source).toContain("border-color: var(--component-search-border-focus)");
    expect(source).toContain("background: var(--component-menu-item-hover-bg)");
  });

  test("uses the search accent for the Browse scope action", () => {
    expect(source).toContain(
      ".search-palette__scope-action .search-palette__result-copy strong",
    );
    expect(source).toContain("color: var(--component-search-icon-focus-fg)");
  });

  test("keeps the modal geometry stable while opening Browse results", () => {
    expect(source).toContain("browseStartHeight = paletteRoot?.getBoundingClientRect().height ?? 0");
    expect(source).toContain("class:is-browse-view={paletteView === \"browse\"}");
    expect(source).toContain("class:is-browse-expanded={browseViewExpanded}");
    expect(source).toContain("height: var(--search-palette-start-height)");
    expect(source).toContain("transition: height var(--duration-normal) var(--easing-emphasized)");
    expect(source).toContain("height: var(--search-palette-max-height)");
    expect(source).toContain("paletteRoot?.getBoundingClientRect()");
    expect(source).toContain("requestAnimationFrame(() => {");
  });

  test("keeps local modal scrollbars visible but visually subordinate", () => {
    expect(source).toContain(".search-palette__results::-webkit-scrollbar");
    expect(source).toContain(".search-palette__group-results.is-work-grid::-webkit-scrollbar");
    expect(source).toContain("scrollbar-color: var(--component-popover-scrollbar-thumb-bg) transparent");
    expect(source).toContain("background: var(--component-popover-scrollbar-thumb-bg)");
    expect(source).toContain("background: var(--component-popover-scrollbar-color)");
    expect(source).not.toContain("*::-webkit-scrollbar");
  });

  test("reserves the narrow viewport for the shell sidebar and honors reduced motion", () => {
    expect(source).toContain("@media (max-width: 980px)");
    expect(source).toContain("left: calc(var(--shell-sidebar-width) + var(--sp-2))");
    expect(source).toContain("right: var(--sp-3)");
    expect(source).toContain(".search-palette.is-open {");
    expect(source).toContain("@media (prefers-reduced-motion: reduce)");
    expect(source).toMatch(/prefers-reduced-motion:[\s\S]*\.search-palette\.is-open[\s\S]*animation: none/);
    expect(source).toMatch(/prefers-reduced-motion:[\s\S]*\.search-palette__result\.is-work-card[\s\S]*transition: none/);
  });

  test("uses the topbar as the only search field while the result panel is open", () => {
    expect(source).not.toContain("search-palette__input");
    expect(source).not.toContain("paletteInput");
    expect(source).not.toMatch(/<input\b/);
    expect(source).toContain("search-palette__actions");
  });

  test("keeps the topbar search above the dim even inside isolated Settings", () => {
    expect(portSource).toContain("body.aethon-search-engaged .aethon-search-dim-layer");
    expect(portSource).toContain("pointer-events: auto");
    expect(portSource).toContain(".main > .root");
    expect(portSource).toContain("animation-fill-mode: none !important");
    expect(portSource).toContain("body.aethon-search-engaged .main--settings");
    expect(portSource).toContain("body.aethon-search-engaged .settings-page");
    expect(portSource).toContain("isolation: auto !important");
    expect(portSource).toContain("body.aethon-search-engaged .downloads-topbar-shell");
    expect(portSource).toContain("z-index: var(--component-topbar-search-z-index) !important");
  });

  test("closes without tearing down results or invalidating the whole palette tree", () => {
    expect(source).toContain("class:is-open={store.searchOpen}");
    expect(source).toContain("inert={!store.searchOpen}");
    expect(source).toContain("contain: layout paint style");
    expect(source).not.toContain("{#if store.searchOpen}");
    expect(source).not.toContain("visibility: hidden");
    expect(source).not.toContain("localResults = [];\n      remoteResults = [];");
    expect(source).toContain("catalogUnchanged");
    expect(source).toContain("controllerCatalogDependencies");
  });
});
