# Search System Audit

## Scope

This milestone consolidates the app's contextual search entry points without changing the underlying library, Browse, Settings, or Downloads data contracts. It adds a shared local-first palette and keeps the existing inline filters as synchronized fallbacks.

The following surfaces are covered:

- Home: global search across local comics, imported books, hydrated source novels, settings, downloads, and navigation actions.
- Library: only the active Comics or Books collection, including source novels and matching collections/categories.
- Browse: remote keyword results for the active Comics or Books content type, without Library results.
- Settings: settings sections and their existing DOM search fallback.
- Downloads: the current local download queue only.

Reader, trackers, Hardcover, Syncd, GraphQL contracts, and persistence remain outside this change. Existing source runtimes are called only through their current read/search APIs.

## Previous Architecture

Search was implemented independently by each surface. Home submitted a query and navigated to `Search.svelte`, which only rendered `BrowseV3`. Browse queried remote sources, Library filtered the loaded collection, Downloads filtered its component-local queue, and Settings searched rendered text and keywords. These paths had separate dim/focus lifecycles and could retain stale state after navigation.

## Current Architecture

The shared pipeline is:

```text
store.navPage + store.librarySection
        |
        v
SearchPalette -> SearchController -> local providers
        |                 |
        |                 +-- normalization, ranking, deduplication, cancellation, bounded cache
        v
typed SearchResultAction -> existing navigation/detail/setting/download actions
        |
        +-- explicit "Search in Browse" -> in-modal installed-source subview
```

`src/lib/search/types.ts` defines the discriminated result and action contracts. `normalize.ts` removes case, accent, punctuation, and spacing differences. `ranking.ts` gives deterministic priority to exact, prefix, partial, keyword, description, and context matches. `providers.ts` keeps each domain's data boundary explicit. `controller.ts` runs synchronous local providers immediately and cancels stale remote work with `AbortController`, request IDs, and a bounded cache.

`SearchPalette.svelte` remains in a separate chunk but is preloaded asynchronously as soon as the app shell is ready, avoiding a dev-time transform on the first normal interaction without increasing the main bundle. It renders no dialog and performs no search until a non-empty query exists. Focusing an empty topbar input expands it, applies its tokenized neon focus treatment, and activates the shared dim. Once the user types a query, the same topbar input remains the only combobox and the palette adds its `listbox`/`option` results, keyboard navigation, loading/error/empty states, and responsive sizing above the same dim. The palette consumes existing semantic/component tokens and does not access `--n-*` values or direct colors.

Work results use the current Library visual hierarchy: compact cover-first cards in one responsive horizontal strip per group, with title and source/status metadata below the cover. Additional works remain in the same strip and are reached by horizontal scrolling. Settings, navigation, collection, and download commands remain compact rows because they are actions rather than inspectable works.

The audit also found and corrected lifecycle defects that the original static contract tests did not expose:

- context boosts ranked unrelated entries with no textual match;
- reopening the same persisted query could return no results;
- a duplicate reactive pass invalidated the active request and left loading stuck;
- restoring focus could reactivate a page-local dim without reopening the palette;
- `Escape` could propagate to Settings and close the whole surface;
- remote insertion could change the item selected by `Enter`;
- grouped visual order differed from keyboard order;
- Book detail navigation was cleared by the old action order;
- cached catalog snapshots omitted hydrated novels, categories, and paused downloads;
- raw Suwayomi thumbnail paths produced broken images in the palette.
- the initial palette duplicated the topbar field and transferred focus into the result panel, producing two incompatible search inputs.

Results are now reranked and deduplicated once after local and remote phases merge. The active option is tracked by result id rather than array index, and media URLs use the same manga/book resolvers as the current Library and Browse surfaces.

## Provider Map

| Context | Local provider data | Remote provider | Selection behavior |
| --- | --- | --- | --- |
| Home | Comics, imported Books, hydrated source novels, collections, Settings, Downloads, page actions | None; remote work starts only after `Search in Browse` | Typed action opens the current detail/page |
| Library | Active Comics or Books section, source novels, and matching collections/categories | None | Current detail/section navigation |
| Browse | No Library results | Manga GraphQL or installed novel-source keyword search for the active type | Current SeriesDetail or NovelDetail |
| Settings | Shared settings section catalog | None | Existing Settings tab activation and fallback search |
| Downloads | Current merged queue snapshot, including locally paused rows | None | Matching Downloads row is focused |

The Library provider receives `store.librarySection`; it does not mix Comics and Books when the user is inside one section. Home intentionally combines domains but keeps them grouped and typed. No installed source is queried while the user types globally. Remote work starts only after the explicit `Search in Browse` action changes the palette to its Browse subview, preserving the query, modal, dim, and active Comics/Books domain without changing `navPage`.

Browse's shared palette is intentionally limited to the **Search** subtab. **Discover** keeps its genre/tag filter and **Sources** keeps its extension/source filter; neither opens the palette nor activates the global dim.

The shared palette does not call the raw GraphQL client. Manga source discovery uses the managed `SourceRuntime.listSources()` contract, while existing source-search helpers remain behind the explicit Browse action. The GraphQL boundary gate rejects `SearchPalette.svelte` as a direct client consumer. Visible group labels, breadcrumbs, common work statuses, source fallbacks, and challenge guidance resolve through the current locale instead of embedded English copy.

## Accessibility And Overlay Contract

- `Escape` closes the palette, blocks other window-level handlers for the same key event, and releases the active search focus.
- Arrow keys move the active option; `Enter` selects it.
- Each active topbar input exposes `role="combobox"`, `aria-expanded`, `aria-controls`, and the current `aria-activedescendant`.
- Results expose `role="listbox"` and `role="option"`.
- One global dim layer is used. It stays below the palette and existing modal/popover layers.
- Existing topbar/sidebar z-index tokens keep the search field visible while the dim is active. Page-entry animations do not retain their final frame after completion, preventing a permanent stacking context without restarting the animation when search closes. Settings isolation is released only during search; Downloads promotes its sticky topbar host for the same reason.
- Native `:focus-within` expands the empty opener and shows its neon border while the shared engaged state displays the dim without a dialog. The topbar field retains focus while the result panel opens; every close path releases opener focus and returns it to its normal width and border.
- Tab and Shift+Tab cycle through the palette controls while it is open.
- `prefers-reduced-motion` disables non-essential palette transitions.
- Route navigation calls the existing store lifecycle, which closes the palette and clears all search body classes.
- Focus restoration is guarded so page input handlers cannot reactivate a stale dim.

The interaction model follows the progressive disclosure and keyboard conventions documented by [VS Code's Command Palette guidelines](https://code.visualstudio.com/api/ux-guidelines/command-palette), [default keyboard shortcuts](https://code.visualstudio.com/docs/reference/default-keybindings), and [Settings Editor guidance](https://code.visualstudio.com/docs/configure/settings).

## Direct Visual Values

The new shared palette contains no hex, `rgb`/`rgba`, `hsl`/`hsla`, `oklch`, `color-mix`, gradient, numeric shadow, numeric blur, numeric z-index, or `--n-*` declarations. Existing per-page styles remain owned by their respective surfaces; this milestone only adds the shared semantic/tokenized palette and the existing dim hook.

## Validation

Automated coverage added:

- normalization of accents, case, punctuation, and whitespace;
- deterministic ranking and duplicate removal;
- local/remote separation and stale-request cancellation;
- contextual provider isolation and Library section filtering;
- palette accessibility roles, keyboard contract, direct-color prohibition, and token usage;
- same-query reopen, Escape/focus restoration, current Comic/Book/Novel details, and content isolation;
- specialized Settings terms, collection ownership, and cache separation by Browse content type.
- empty-focus versus non-empty palette activation, expanded neon opener, and Library-style work-card presentation contracts.

Checks to record for this milestone:

- `npx svelte-check --tsconfig ./tsconfig.json`
- `pnpm test:unit -- src/lib/search`
- focused shell tests for SearchPalette, LibraryToolbar, BrowseV3, Downloads, and Settings;
- `pnpm test:browser`;
- `pnpm build`;
- `git diff --check`.

Final results:

- search unit suite: 5 files, 17 tests passed;
- focused Browse scope suite: 3 files, 54 tests passed;
- complete unit/jsdom suite: 169 files passed, 1 file skipped; 976 tests passed, 1 live test skipped;
- navigation store suite: 1 file, 12 tests passed;
- browser component suite: 10 files, 48 tests passed;
- `svelte-check`: 0 errors and 0 warnings;
- production build: passed;
- builtin theme generation check: passed;
- `git diff --check`: passed.

## Real-App Screenshots

Validation completed with managed Epigraph desktop/WebView2 sessions in Nocturne. The palette was opened and controlled through the visible topbar input. The managed sessions confirmed:

- Home query `Lorde`: one hydrated source novel plus separately grouped remote comic results;
- Library Comics query `Osananajimi`: one local comic with a resolved Suwayomi thumbnail;
- Library Books query `Lorde dos Misterios`: one persisted source novel opening the current NovelDetail;
- Browse Comics query `moon`: 18 deduplicated remote results with resolved thumbnails;
- Browse Books query `lord`: the installed-source request completed without stale Manga results or indefinite loading;
- Settings query `hardcover`: one typed Tracking destination, while Escape kept Settings open;
- Downloads query `theme`: no cross-domain results in the naturally empty queue;
- Discover and Sources focus/input: no palette, no dim, and Sources filtered to the matching current source;
- sidebar route change while open: palette and all body classes cleared;
- twenty open/close cycles: no residual interactive overlay or body class after the transition settled.

The empty Downloads queue and the absence of a naturally matching installed novel-source result are runtime limitations, not synthetic fixtures.

Visual review found no apparent regression in the dim layer, topbar search field, sidebar hierarchy, palette bounds, focus ring, result grouping, resolved covers, or route surfaces at 1280x800 and 800x600. The final committed evidence is limited to the current single-input implementation: `docs/screenshots/browse-search-modal/01-global-results-with-browse-action-1280x800.png` plus the before/after card matrix under `docs/screenshots/search-browse-cards/`. Earlier full-surface captures were excluded because they showed the superseded duplicate-input implementation. Home, Library Comics/Books, Settings, and Downloads remain covered by the real native navigation smoke and deterministic component tests without retaining misleading visual artifacts.

No synthetic user records were created. The empty Downloads queue, offline data states, and unavailable installed-novel result remain deterministic-test coverage rather than fabricated screenshots. Automation locators must ignore hidden keep-alive surfaces; locator timeouts caused by those duplicate DOM nodes are not product failures.

The opener measured approximately 267 px before activation and 348 px after the first empty click at 1280x800. At that point the palette remained absent while dim opacity changed to `1`; the focus border resolved to 68% neon-purple alpha with two accent glow layers. Entering a query opened the palette above the existing dim and preserved the same border/glow while focus moved internally. Closing returned the opener to approximately 267 px, its default 8% border and no shadow, with dim opacity `0`. Hit testing confirmed both the search input and dialog above the dim in Home, Library, Browse, Downloads, and Settings. Five repeated empty-query cycles engaged in 20-65 ms and closed in 21-34 ms; three repeated query cycles opened consistently in about 150 ms after the controlled-input and debounce fixes. Work groups render a single strip of 88-104 px cards at that viewport; a 17-item group measured 883 px visible width and 1902 px scroll width, with every card sharing the same vertical position.

Closing performance was revalidated on 2026-07-26 after a dev/HMR renderer had accumulated 4.78 GB and started producing unrelated major-GC pauses. That managed session was stopped and replaced before collecting release evidence. In the clean WebView2 session, the palette retained at most 40 bounded result nodes, reused its catalog controller while source references remained unchanged, and cached ranking/grouping as derived values. Five Downloads closes by Escape, closes by the empty-query dim, palette backdrop, and close button, plus three Home closes with 40 cards produced no long tasks. The close event took 0.1-0.4 ms, page opacity remained `1`, the dim reached `0`, the query cleared, and no route or overlay state remained. JavaScript heap measured 126 MB before the stress pass and 132 MB after retaining the bounded 40-card result tree.

The single-input layout was revalidated in the managed WebView2 session on 2026-07-26. The open palette contained zero inputs while the topbar combobox retained focus, its expanded state, result ownership, and active-descendant reference. A populated Comics query rendered 40 bounded work cards with source and work status below each title; the strip measured 883 px visible width and 4,466 px scroll width. A Books query rendered the current imported PDF as `PDF / COMPLETED`, matching the Library card hierarchy. No duplicate field or description/author substitution remained in the result panel.

## Remaining Risks

- The existing Settings DOM search remains as a fallback; the shared catalog currently targets page-level sections and does not replace every control-level keyword.
- Installed novel-source operations do not currently accept `AbortSignal`. The palette confines that work to explicit Browse Books keyword search, applies a bounded wrapper, and invalidates abandoned results, but the underlying operation may finish after the UI request is abandoned.
- Browse remote search depends on the current Suwayomi/source readiness and can legitimately produce no remote results while the local shell remains usable.
- Search results use live in-memory snapshots. A cold-start profile may show navigation/settings actions before library or queue state hydrates.
- The captured matrix covers the stable Nocturne runtime states available in the managed profile. Empty Downloads and cold/offline data states remain covered by deterministic tests rather than synthetic runtime data.

## Browse Installed-Source Search

### Architecture decision

The explicit action changes `SearchPalette.svelte` to a Browse subview while keeping the modal, topbar combobox, dim, query, and current page intact. The subview reuses the existing installed-source APIs, visibility/language rules, cover resolvers, typed detail actions, concurrency policy, and current Library card hierarchy. It does not render a second input and does not navigate to `BrowseV3`.

The transfer contract is:

```text
SearchPalette action
  -> paletteView = "browse"
  -> preserve trimmed query and Comics/Books type
  -> load visible manga sources or trusted novel sources
  -> render one progressive horizontal result row per source
  -> back restores the previous global result set in the same modal
```

Closing the palette aborts or invalidates source work and restores the opener normally. Selecting a work closes the palette and invokes the current `openMangaDetail` or `setActiveNovelDetail` path. Opening the shared palette from Browse Search starts directly in this subview, while Discover and Sources remain outside the global palette.

### Requirement status

| Requirement | Result | Implementation and residual risk |
| --- | --- | --- |
| BROWSE-SEARCH-01 | Complete | A compact, translated scope action appears after local groups, including no-local-result states, and is absent in Browse. |
| BROWSE-SEARCH-02 | Complete | Trimmed Unicode query and Comics/Books type are transferred once; empty queries create no action. |
| BROWSE-SEARCH-03 | Complete | The current page and URL remain unchanged; only the modal content changes to source-search state. |
| BROWSE-SEARCH-04 | Complete | Existing trusted novel-source and visible Suwayomi-source loaders are reused; no source names or IDs are hardcoded. |
| BROWSE-SEARCH-05 | Complete | Sources remain vertical sections and each result set remains one current Library-style horizontal row. |
| BROWSE-SEARCH-06 | Complete | Rows keep independent native `scrollLeft`; keyboard visibility changes only the active row. |
| BROWSE-SEARCH-07 | Complete | Waiting/loading/results/empty/error remain scoped to each source and render progressively. Provider error normalization remains a separate risk. |
| BROWSE-SEARCH-08 | Complete | Existing debounce, `AbortController`, request epoch, concurrency limit of six, filtering, and pagination policy are unchanged. Novel source calls still lack native `AbortSignal`. |
| BROWSE-SEARCH-09 | Complete | Left/right stay in-row; up/down use the nearest index in adjacent result rows; non-results are skipped. |
| BROWSE-SEARCH-10 | Complete | Manga cards reuse `openMangaDetail`; novels resolve the selected installed source/path and reuse `setActiveNovelDetail`. |
| BROWSE-SEARCH-11 | Complete | Manga keys use `source.id:manga.id`; novels use `sourceId:path`; source identity is retained through detail loading. |
| BROWSE-SEARCH-12 | Complete | The explicit Comics/Books domain and existing discriminated Browse result paths decide the detail surface; no title heuristic was added. |
| BROWSE-SEARCH-13 | Complete | Existing source APIs, payloads, resolvers, and current detail actions are reused; no legacy detail route is introduced. |
| BROWSE-SEARCH-14 | Complete | Opening a detail aborts the active subview controller before closing the palette. |
| BROWSE-SEARCH-15 | Complete | A translated back action restores the preserved global groups, query, keyboard target, and opener focus without closing the modal. |
| BROWSE-SEARCH-16 | Complete | Existing `n-library-card` hierarchy, title truncation, source/status metadata, hover, and focus-visible styles remain in use. |

### Requests and performance

- Global typing performs local provider work only. No remote source request is issued before entering the Browse subview.
- The Browse subview starts source work only after the scope action receives a valid query.
- Manga search uses the current visible installed sources and the existing concurrency limit of six.
- Novel search uses trusted, enabled installed novel sources with at most six concurrent requests.
- New queries abort or invalidate older manga work; stale results cannot replace the active query.
- Source responses update their own section as they resolve; one slow or failed source does not block successful sections.
- Opening manga or novel details aborts the current subview controller before closing the palette.
- Pagination, caches, repository state, installation state, and source preferences were not changed.

### Automated validation

- `SearchPalette.test.ts`: action placement, semantic shape, i18n, local-only remote gate, modal subview structure, stable keys, and geometry-aware keyboard contract.
- `SearchPalette.behavior.test.ts`: action with/without local results, mouse/keyboard activation, Unicode query preservation, Comics/Books subview activation, current Series/Novel detail actions, and back restoration.
- `BrowseV3.test.ts`: installed-source rows, per-source no-results, no-source state, stable compound IDs, independent scrolling, geometry-aware arrows, Series detail routing, and Novel detail routing with exact source/path identity.
- Controlled tests cover multiple result rows and the no-installed-source state because the active user profile cannot be modified for screenshots.
- Five obsolete `--component-home-search-*` definitions were removed after global reference and inventory checks proved that the shared palette host replaced their only visual owner. The exhaustive inventory now reports 2,670 component tokens: 2,667 Active and three Legacy. The Legacy entries are the retained `--component-tracking-record-tracker-icon-text-*` compatibility tokens whose former `HC` text host was replaced by the real Hardcover asset; they remain defined and are not removed in this milestone.

### Real WebView2 evidence

The final in-modal evidence uses the real Nocturne application and installed providers:

| File | Evidence |
| --- | --- |
| `01-global-results-with-browse-action-1280x800.png` | Global results and the explicit action before changing the modal page. |
| `../search-browse-cards/after/01-browse-cards-aa-1280x800.png` | Same modal after the action, with current source-scoped horizontal result cards. |
| `../search-browse-cards/after/02-browse-cards-aa-800x600.png` | Current responsive subview contained within an 800x600 window, with no page-level horizontal overflow. |

Runtime confirmed that `navPage` and the URL remain unchanged while the modal switches pages, the topbar stays above the shared dim, the query remains in the single combobox, the back action restores global results, and source sections update progressively. Selecting the first real Comics result closed the modal, cleared `epigraph-search-engaged`, and opened the current SeriesDetail with the exact source identity. For the real Books run, Central Novel remained pending and Illusia required FlareSolverr, so no genuine novel result was available to open. NovelDetail selection is therefore validated deterministically with a trusted installed-source payload rather than fabricated runtime data.

Only one installed provider returned a populated row for the stable `naruto` capture. Independent scrolling across two populated rows is consequently covered by the component test, not a synthetic screenshot. Some Suwayomi errors still expose provider-internal class/member names; normalizing those messages belongs to the source bridge and is outside this search-routing change.

The captures from the superseded page-navigation experiment were excluded from the final evidence set and from version control.

## Browse Card Visual Refinement

### Scope and strategy

This refinement changes only the presentation of installed-source results inside the
Browse Search modal. `LibraryCard.svelte` was used as the visual reference, but was
not reused directly because its selection, drag-and-drop, progress, context-menu,
badge, and mutation contracts do not belong to remote search results. The modal uses
a compact local adaptation of the same cover geometry, title hierarchy, source/status
metadata, tokens, hover, and focus treatment. Search providers, source calls, ranking,
deduplication, pagination, routing, and detail actions are unchanged.

### Findings and corrections

| Finding | Before | Correction |
| --- | --- | --- |
| Cards were visually compressed | 88-104 px cards, small cover radius, and source/status forced into one split row | 116-128 px fixed-width cards, 2:3 covers, Library cover tokens, two-line title, and stacked source/status metadata |
| Keyboard selection was ambiguous | Active state emphasized only the lower edge | Focus and active state now outline the complete card without changing geometry |
| Source headers repeated language | Labels such as `Comick (EN) EN` | A separate language marker is omitted only when the official label already ends with the same parenthetical marker |
| Loading shifted the result rail | Cover-only placeholders did not reserve final copy geometry | Five complete card skeletons reserve cover, title, source, and status space |
| Empty/error groups consumed excess vertical space | Large body states appeared below each source | Empty, loading, count, and error status are summarized in the source row; errors retain one compact diagnostic line |
| Local scrolling was visually heavy | Result rails competed with card content | Six-pixel tokenized scrollbars remain local to modal results and horizontal rails |
| Reduced-motion coverage was incomplete | Card transitions remained enabled | Result transitions are disabled with the existing palette animation under `prefers-reduced-motion: reduce` |

### Runtime measurements

Real Nocturne WebView2 measurements:

- at 1280x800, a result card is 128x249.7 px and a source rail is 873.1 px wide;
- at 800x600, a result card is 116 px wide and approximately 229-232 px high
  across the persisted density states exercised; the rail is 686.9 px wide;
- the document remained exactly viewport-width at both sizes, with no global
  horizontal overflow;
- keyboard navigation reached the twentieth card, moved only its source rail to
  `scrollLeft=1860`, and kept the active card completely visible;
- 110% zoom preserved viewport containment;
- the reduced-motion media query resolves the palette and result animation to none;
- selecting a real Comics source result closed the palette and opened the current
  Series Detail with the selected source identity.

### Requirement status

`BROWSE-CARD-01` through `BROWSE-CARD-12` are complete. Source groups remain vertical,
each source retains one independently scrollable horizontal result row, official names
are not rewritten, image fallback remains active, and no visual literals or new
dependencies were introduced. Raw provider error normalization remains outside this
visual scope.

### Real WebView2 evidence

The comparison set is stored under `docs/screenshots/search-browse-cards/`:

- `before/01-library-card-reference-800x600.png`;
- `before/02-library-card-reference-1280x800.png`;
- `before/03-browse-cards-aa-1280x800.png`;
- `before/04-browse-cards-aa-800x600.png`;
- `before/05-browse-loading-1280x800.png`;
- `after/01-browse-cards-aa-1280x800.png`;
- `after/02-browse-cards-aa-800x600.png`;
- `after/03-browse-loading-800x600.png`;
- `after/04-browse-cards-110-percent-800x600.png`;
- `after/05-browse-reduced-motion-800x600.png`;
- `after/06-browse-last-card-keyboard-800x600.png`;
- `after/07-series-detail-opened-800x600.png`;
- `after/08-books-browse-results-800x600.png`;
- `after/09-books-browse-final-800x600.png`.

The Comics profile naturally exposed a 20-result source, a 2-result source, a broken
cover fallback, source errors, loading, empty groups, horizontal overflow, keyboard
selection, and Series Detail routing. The Books profile naturally exposed loading and
no-results states but no selectable installed-source novel, so Novel Detail routing
remains covered by the deterministic behavior test rather than fabricated runtime
data. No naturally available disabled card exists in this modal.

### Closed opener presentation

Real WebView2 validation found that focus restoration left the topbar search visually
expanded after the modal and dim had closed. The state store was already clearing
`searchOpen`, `searchEngaged`, the query, active result, and body classes correctly.
The residual presentation came from the generic `.n-search:focus-within` rule reacting
to the programmatically restored input focus.

The opener now marks that restored-focus state as visually neutral while retaining
the focused element for keyboard and assistive-technology continuity. A subsequent
click, input activation, or focus engagement removes the marker before reapplying the
normal neon focus treatment. In the real 1248x800 Nocturne window, close by X, Escape,
and outside click returned the search from approximately 339 px to 260 px, removed
its shadow and engaged body class, and cleared the query without reopening the
palette.
