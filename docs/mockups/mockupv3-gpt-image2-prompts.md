# Mockup V3 GPT Image 2 Prompt Pack

## Scope

This prompt pack translates the `mockupv3` Aethon Nocturne screens into a consistent GPT Image workflow.

Primary visual sources:

- `docs/mockups/stitch-nocturne-isolated/home-v3.html`
- `docs/mockups/stitch-nocturne-isolated/library-archive-v3.html`
- `docs/mockups/stitch-nocturne-isolated/browse-v3.html`
- `docs/mockups/stitch-nocturne-isolated/series-detail-v3.html`
- `docs/mockups/stitch-nocturne-isolated/reader-v3.html`
- `docs/mockups/stitch-nocturne-isolated/downloads-v3.html`
- `docs/mockups/stitch-nocturne-isolated/settings-v3.html`
- `docs/mockups/penpot-import/README.md`

## Shared Visual Bible

Use this as the invariant prefix for every image generation prompt.

- Product: Aethon Nocturne, a premium desktop manga and novel reader app.
- Use case: `ui-mockup`
- Canvas: desktop application window, ultra-clean product mockup, 16:10 ratio.
- Visual direction: moody editorial sci-fi interface, dark graphite shell, soft obsidian surfaces, restrained lavender accent glow.
- Layout language: left icon sidebar, slim topbar, large rounded cards, soft separators, translucent glass panels, precise spacing, low-noise hierarchy.
- Typography feel: modern geometric grotesk with high legibility, bold section titles, compact labels, subtle uppercase metadata.
- Surface treatment: matte charcoal, deep black, muted plum haze, very soft lavender highlights, no neon overload.
- Shadows: shallow depth, controlled ambient shadow, no heavy bloom.
- Corners: large rounded outer shell, medium rounded cards, pill controls.
- Interaction cues: one active route at a time, one active toolbar mode at a time, coherent button sizes across all screens.
- Content continuity: reuse the same sample universe across screens when possible.
- Recurring titles: Vagabond, Berserk, Monster, Vinland Saga, 20th Century Boys.
- Recurring status language: In Progress, Recently Added, Downloading, Queued, Synced, Local.
- Do not change the product identity between screens.
- Avoid mobile framing, browser tabs, hand-held devices, photoreal environments, or futuristic hologram gimmicks.
- Avoid random text blocks, broken typography, extra floating panels, or inconsistent iconography.

## Shared Prompt Base

```text
Use case: ui-mockup
Asset type: desktop app product mockup
Primary request: create a polished high-fidelity UI mockup for Aethon Nocturne, keeping strict continuity with the same visual system across every screen in the set
Scene/backdrop: isolated desktop product shot on a very dark neutral backdrop with a subtle plum haze and faint vignette
Subject: a premium manga and novel reader desktop interface
Style/medium: cinematic product UI render, crisp interface typography, realistic app-window lighting, not a website screenshot
Composition/framing: straight-on desktop app window, centered, full interface visible, minimal perspective distortion
Lighting/mood: nocturnal, calm, premium, focused, understated lavender glow
Color palette: graphite black, charcoal, smoke gray, muted lavender, pale lilac, warm ivory text
Materials/textures: matte shell, satin glass panels, gentle blur, precise separators
Constraints: keep the same sidebar, topbar proportions, spacing language, corner radii, and accent color logic across all screens; keep text clean and readable; preserve continuity of titles and content references between screens
Avoid: mobile UI, bright cyberpunk neon, heavy blue tint, clutter, messy text, random widgets, futuristic holograms, game HUD styling
```

## Screen Set

### 01 Home

```text
Use case: ui-mockup
Asset type: desktop app home screen
Primary request: create the Home screen for Aethon Nocturne with a left icon sidebar, centered search in the topbar, continue reading cards, quick actions, recent updates, and a calm premium dashboard feel
Scene/backdrop: isolated desktop app mockup on a nearly black backdrop
Subject: the Aethon Nocturne home dashboard
Style/medium: high-fidelity desktop UI mockup
Composition/framing: straight-on full app window, content balanced in a spacious editorial grid
Lighting/mood: calm nocturnal interface with soft lavender highlights
Color palette: dark graphite surfaces, muted lavender accents, warm off-white text
Materials/textures: matte cards, faint glass blur, low-contrast dividers
Text (verbatim): "Aethon Nocturne", "Continue Reading", "View Archive", "Browse Sources", "Downloads", "Check Updates", "Plan to Read", "Vagabond", "Berserk", "Monster"
Constraints: show three continue reading cards with cover art and progress bars; include quick action pills; keep the same sidebar icons used across the rest of the app; make this the visual anchor for the rest of the set
Avoid: oversized hero banners, bright gradients, empty dashboard areas
```

### 02 Library

```text
Use case: ui-mockup
Asset type: desktop app library screen
Primary request: create the Library screen for Aethon Nocturne showing a dense archive wall of covers, segmented Comics and Books control, centered search, and a right-side toolbar cluster for density, sort, filter, and layout
Scene/backdrop: isolated desktop app mockup on a very dark neutral backdrop
Subject: the Aethon Nocturne library archive view
Style/medium: high-fidelity desktop UI mockup
Composition/framing: straight-on app window with a strong cover-grid focus and elegant negative space
Lighting/mood: quiet, curated, premium archive atmosphere
Color palette: charcoal, soft black, muted lavender, desaturated plum
Materials/textures: matte cover wall, satin glass popover panels, subtle separators
Text (verbatim): "Comics", "Books", "Search comics...", "Sort", "Filter", "Layout", "Items per row"
Constraints: keep the same sidebar and topbar proportions as the Home screen; show the Library route as active; include one visible floating popover panel for layout or density; reuse some of the same titles from Home in the grid
Avoid: bookstore realism, shelf illustrations, overdecorated backgrounds
```

### 03 Browse

```text
Use case: ui-mockup
Asset type: desktop app browse screen
Primary request: create the Browse screen for Aethon Nocturne with source discovery, category chips, search filters, and a curated results layout that feels consistent with the Home and Library screens
Scene/backdrop: isolated desktop app mockup on a nearly black backdrop
Subject: the Aethon Nocturne browse and discovery interface
Style/medium: high-fidelity desktop UI mockup
Composition/framing: straight-on desktop window with a filter-rich discovery layout
Lighting/mood: investigative, sleek, premium, calm
Color palette: graphite, smoked plum, muted lavender, pale text
Materials/textures: matte interface shell, softly elevated filter cards
Text (verbatim): "Browse", "Keyword", "Browse", "Source", "Featured", "Tag", "Languages", "Popular", "Latest", "Advanced"
Constraints: maintain the same sidebar, topbar, search style, and card treatment from the previous screens; include discovery source cards and search filter controls; keep the content density between Home and Library
Avoid: marketplace gimmicks, loud banners, noisy source logos
```

### 04 Series Detail

```text
Use case: ui-mockup
Asset type: desktop app series detail screen
Primary request: create the Series Detail screen for Aethon Nocturne with a strong hero header, large cover, metadata, primary read action, tracking and library actions, and a chapter list with sort and filter controls
Scene/backdrop: isolated desktop app mockup on a very dark background
Subject: a manga series detail page inside Aethon Nocturne
Style/medium: high-fidelity desktop UI mockup
Composition/framing: straight-on window with a cinematic hero panel above a dense chapter list
Lighting/mood: dramatic but restrained, premium archival mood
Color palette: obsidian, charcoal, muted lavender, pale ivory text, faint gold metadata accents
Materials/textures: matte hero panel, soft glass action chips, crisp chapter rows
Text (verbatim): "Vagabond", "Continue", "In Library", "Tracking", "Refresh", "Chapters", "Sort", "Filter"
Constraints: keep content continuity with the Home and Library screens by using the same series names and progress cues; preserve the same sidebar and topbar language; chapter list should feel functional and information-rich without visual clutter
Avoid: poster-style fantasy lighting, oversized synopsis blocks, random anime motifs
```

### 05 Reader

```text
Use case: ui-mockup
Asset type: desktop app reader screen
Primary request: create the Reader screen for Aethon Nocturne as an immersive manga reading canvas with hidden chrome style, a slim top overlay, a bottom progress and controls bar, and a focused reading experience
Scene/backdrop: isolated desktop app mockup on a near-black backdrop with the app window filling most of the frame
Subject: the Aethon Nocturne manga reader interface
Style/medium: high-fidelity desktop UI mockup
Composition/framing: straight-on desktop app window, manga page centered, immersive composition, no sidebar visible in reading mode
Lighting/mood: dark, quiet, concentrated, elegant
Color palette: black, graphite, smoke gray, muted lavender highlights, warm text
Materials/textures: matte canvas, translucent chrome overlays, subtle glow on active controls
Text (verbatim): "Vagabond", "Chapter 327", "Bookmark", "Fit", "Zoom", "Page Style"
Constraints: keep the same design language as the shell screens even though the sidebar is absent; controls must feel like the same product family; show a centered manga page, top overlay, bottom progress slider, and compact action controls
Avoid: comic speech balloons, browser chrome, fake hand interaction, visible mouse cursor
```

### 06 Novel Detail

```text
Use case: ui-mockup
Asset type: desktop app novel detail screen
Primary request: create the Novel Detail screen for Aethon Nocturne using the same visual system as the manga detail page but adapted for prose and chapter-based reading
Scene/backdrop: isolated desktop app mockup on a dark neutral backdrop
Subject: a novel detail page inside Aethon Nocturne
Style/medium: high-fidelity desktop UI mockup
Composition/framing: straight-on desktop app window, hero panel plus chapter list with a more literary rhythm
Lighting/mood: premium, contemplative, nocturnal
Color palette: charcoal, obsidian, muted lavender, parchment-toned text accents
Materials/textures: matte hero shell, soft list rows, subtle glass chips
Text (verbatim): "Novel Detail", "Continue", "Chapters", "Synopsis", "Tracking", "Local"
Constraints: preserve the exact same app shell, spacing, corner radii, and action hierarchy from Series Detail; use a lighter emphasis on cover art and a stronger emphasis on textual metadata and chapter structure
Avoid: ebook skeuomorphism, paper textures, sepia overload
```

### 07 Downloads

```text
Use case: ui-mockup
Asset type: desktop app downloads screen
Primary request: create the Downloads screen for Aethon Nocturne with active downloads, queued items, progress bars, pause and resume states, and a premium task-management feel consistent with the rest of the app
Scene/backdrop: isolated desktop app mockup on a nearly black backdrop
Subject: the Aethon Nocturne downloads manager
Style/medium: high-fidelity desktop UI mockup
Composition/framing: straight-on desktop app window with a stacked queue layout and clear progress states
Lighting/mood: operational, focused, restrained, premium
Color palette: charcoal, dark graphite, muted lavender, subtle status tints
Materials/textures: matte rows, pill controls, low-contrast separators
Text (verbatim): "Downloads", "Pause", "Resume", "Clear Queue", "Downloading", "Queued", "Synced"
Constraints: keep the same sidebar and topbar language as the shell screens; reuse series names already seen on Home and Series Detail; emphasize progress hierarchy and queue clarity
Avoid: industrial admin dashboard look, bright warning colors, generic file manager styling
```

### 08 Settings

```text
Use case: ui-mockup
Asset type: desktop app settings screen
Primary request: create the Settings screen for Aethon Nocturne with a grouped left rail, contextual sub-navigation, clean preference rows, toggles, selectors, and a polished workstation feel
Scene/backdrop: isolated desktop app mockup on a very dark neutral backdrop
Subject: the Aethon Nocturne settings interface
Style/medium: high-fidelity desktop UI mockup
Composition/framing: straight-on desktop app window with a split workbench layout and dense but elegant preference content
Lighting/mood: calm, premium, engineering-focused, nocturnal
Color palette: charcoal, black, muted lavender, pale warm text
Materials/textures: matte preference surfaces, soft hover states, restrained glass highlights
Text (verbatim): "Settings", "General", "Library", "Reader", "Appearance", "Tracking", "Performance", "Security"
Constraints: preserve the same sidebar and topbar proportions as Home and Library; make the settings route active; show one group active and one sub-navigation item active; use polished toggles and selectors with the same rounded geometry found elsewhere in the app
Avoid: mobile settings patterns, oversized forms, sterile enterprise styling
```

## Recommended Generation Order

1. Home
2. Library
3. Browse
4. Series Detail
5. Reader
6. Novel Detail
7. Downloads
8. Settings

## Continuity Notes

- Keep the app shell visually identical between Home, Library, Browse, Series Detail, Downloads, and Settings.
- The Reader can hide the sidebar, but the button language, corner radii, colors, and overlay treatment must still feel like the same product.
- Reuse the same title names and progress states across screens.
- Keep the accent color restrained; the mockups should feel premium, not neon.
- Prefer clean legible UI text over decorative noise.
