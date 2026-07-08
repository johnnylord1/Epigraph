# Aethon Theme System Audit

Status: Marco 1 - infraestrutura.

Este relatório acompanha a migração incremental do sistema de temas. O contrato deste marco é preparar a base sem criar temas novos, sem remover tokens e sem migrar componentes visuais em massa.

## Arquitetura Atual

- `src/styles/global.css` importa, nesta ordem, `tokens.css`, `nocturne-theme.css`, `animations.css` e `nocturne-port.css`.
- `src/styles/tokens.css` define os tokens base e temas antigos por `data-theme`.
- `src/styles/nocturne-theme.css` define a identidade Nocturne e tokens `--n-*` usados pela UI portada.
- `src/styles/nocturne-port.css` concentra grande parte do CSS visual da shell Nocturne e ainda contém muitos valores diretos.
- `src/App.svelte` aplica `data-theme` no elemento raiz e injeta CSS para temas customizados.
- `src/store/state.svelte.ts` mantém `ThemeTokens`, `HudThemeTokens`, defaults e presets.
- `src/components/settings/ThemeEditor.svelte` edita tokens de temas customizados e presets HUD.

## Arquitetura Nova

Marco 1 adiciona uma camada explícita em `tokens.css`:

- Primitive tokens: aliases de base para backgrounds, bordas e accent.
- Semantic tokens: background, surface, elevated, card, modal, popover, menu, overlay, border, outline, divider, accent, success, warning, danger, info e texto.
- Component tokens: card, modal, popover, menu, overlay, button, input, tab, toast, sidebar, topbar e focus.

Nocturne passa a declarar valores canônicos para os novos tokens em `nocturne-theme.css`.

Temas customizados antigos agora são aplicados em `App.svelte` por merge com `NOCTURNE_THEME_TOKENS` e `NOCTURNE_HUD_THEME_TOKENS`, evitando tokens novos ausentes no runtime.

## Auditoria Automatizada Inicial

Comandos usados:

```powershell
rg -n "#[0-9A-Fa-f]{3,8}\b|rgba?\(|hsla?\(|oklch\(|color-mix\(" src --glob '!src/test/browser/__screenshots__/**' --glob '!src/components/**/__screenshots__/**'
rg -n "#[0-9A-Fa-f]{3,8}\b|rgba?\(|hsla?\(|oklch\(|color-mix\(" src --glob '!src/styles/tokens.css' --glob '!src/styles/nocturne-theme.css' --glob '!src/test/browser/__screenshots__/**' --glob '!src/components/**/__screenshots__/**' --count-matches
rg -n "style\.setProperty|custom\.tokens|ThemeEditor|NOCTURNE_THEME_TOKENS|DEFAULT_THEME_TOKENS|HudThemeTokens|ThemeTokens|THEME_MOTION_VARS|data-theme" src\App.svelte src\store src\components src\styles
```

Resultados do Marco 1:

- Ocorrencias diretas em `src`, antes de allowlist: 2179.
- Ocorrencias diretas fora de `tokens.css` e `nocturne-theme.css`: 1924.
- Variaveis CSS declaradas em `tokens.css` e `nocturne-theme.css`: 461.

Principais concentradores de valores diretos fora dos arquivos de tema:

| Arquivo | Ocorrencias |
| --- | ---: |
| `src/styles/nocturne-port.css` | 398 |
| `src/components/pages/BrowseV3.svelte` | 180 |
| `src/components/pages/MassMigrateModal.svelte` | 113 |
| `src/components/shared/SeriesDetailV3Shell.svelte` | 111 |
| `src/components/pages/SourcesView.svelte` | 107 |
| `src/store/state.svelte.ts` | 100 |
| `src/components/shared/TrackingPanel.svelte` | 80 |
| `src/components/reader/BookReader.svelte` | 75 |
| `src/components/reader/ReaderHud.svelte` | 75 |
| `src/components/settings/Settings.svelte` | 73 |
| `src/components/reader/NovelReader.svelte` | 55 |
| `src/components/library/LibraryCard.svelte` | 46 |

## Mapa De Tokens

### Ativos

Tokens usados por componentes reais, store, CSS final ou `style.setProperty`:

- Base color: `bg-void`, `bg-base`, `bg-surface`, `bg-raised`, `bg-overlay`, `bg-subtle`.
- Border: `border-dim`, `border-base`, `border-strong`, `border-focus`.
- Text: `text-primary`, `text-secondary`, `text-muted`, `text-faint`, `text-disabled`.
- Accent/status atuais: `accent`, `accent-dim`, `accent-muted`, `accent-fg`, `accent-bright`, `color-error`, `color-error-bg`, `color-success`, `color-info`, `color-info-bg`, `color-read`.
- Typography/scale: `font-ui`, `font-sans`, `text-2xs`, `text-xs`, `text-sm`, `text-base`, `text-md`, `text-lg`, `text-xl`, `text-2xl`, `text-3xl`, `weight-*`, `leading-*`, `tracking-*`.
- Spacing/radius/motion/z-index atuais: `sp-*`, `radius-*`, `t-*`, `z-reader`, `z-modal`, `z-settings`.
- HUD atuais: `hud-control-height`, `hud-icon-button-size`, `hud-control-radius`, `hud-chip-radius`, `hud-popover-radius`, `hud-status-radius`, `hud-toast-radius`, `hud-chapter-row-radius`, `hud-surface-opacity`, `hud-sidebar-width`, `hud-toolbar-gap`, `hud-reader-chrome-opacity`, `hud-selection-bg`, `hud-selection-border`, `hud-progress-height`.
- Nocturne port ativos: `n-*` e `activity-*`, ainda mantidos como camada de compatibilidade ativa.

### Legacy

Tokens adicionados neste marco para a migração incremental. Eles existem no CSS final, ThemeEditor/store/presets, ou servem como ponte para componentes futuros, mas ainda nao devem ser considerados totalmente migrados:

- Primitive aliases: `primitive-bg-*`, `primitive-border-*`, `primitive-accent`.
- Semantic colors: `color-background`, `color-background-void`, `color-surface`, `color-surface-secondary`, `color-elevated`, `color-card`, `color-modal`, `color-popover`, `color-menu`, `color-overlay`, `color-border`, `color-outline`, `color-divider`, `color-accent`, `color-accent-muted`, `color-success-bg`, `color-warning`, `color-warning-bg`, `color-danger`, `color-danger-bg`, `text-tertiary`, `text-inverse`.
- Typography aliases: `font-family-ui`, `font-family-sans`, `font-family-reader`.
- Spacing aliases: `space-xs`, `space-sm`, `space-md`, `space-lg`, `space-xl`.
- Radius aliases: `radius-control`, `radius-card`, `radius-modal`, `radius-popover`.
- Effects: `shadow-sm`, `shadow-md`, `shadow-lg`, `shadow-focus`, `blur-backdrop`, `blur-glass`.
- Motion aliases: `duration-fast`, `duration-normal`, `duration-slow`, `easing-standard`, `easing-emphasized`.
- Z-index aliases: `z-dropdown`, `z-popover`, `z-tooltip`, `z-toast`.
- Component aliases: `component-card-*`, `component-modal-*`, `component-popover-*`, `component-menu-*`, `component-overlay-bg`, `component-button-*`, `component-input-*`, `component-tab-*`, `component-toast-*`, `component-sidebar-bg`, `component-topbar-bg`, `component-focus-ring`.

### Mortos

Nenhum token foi classificado como Morto neste marco.

Regra aplicada: se ha duvida, uso dinamico, ThemeEditor, custom theme, store, preset ou falta de validacao visual completa, o token fica como Legacy. Nenhum token foi removido.

## Cores Diretas

Classificacao inicial:

- Permitidas por enquanto: arquivos de tema/token, assets SVG de marca, canvas/splash, fixtures e swatches.
- Migrar para token: componentes Svelte, `nocturne-port.css`, readers, settings, sources, migration, toasts, menus, cards, inputs e overlays.

Lista por arquivo com contagem atual esta na secao "Auditoria Automatizada Inicial". A lista linha a linha deve ser regenerada pelo comando `rg` acima no inicio de cada marco visual, para evitar drift.

## Componentes Fora Do Design System

Componentes e areas com valores diretos que devem ser migrados em marcos futuros:

- Componentes base: `Toaster`, `ContextMenu`, `MangaPreview`, `TrackingPanel`, `NocturneState`.
- Layout: `Layout`, `Sidebar` via `nocturne-port.css`, `TitleBar`, `ActivityButton`, `ActivityOverlay`, `RecentActivity`, `WindowControlsInline`.
- Reader: `Reader`, `ReaderHud`, `TtsControls`, `BookReader`, `NovelReader`.
- Library: `LibraryCard`, `LibraryDisplayPopover`, `LibraryDensityRail`, `BooksLibraryBody`, `ComicsLibraryBody`.
- Settings: `Settings`, `ThemeEditor`, `NovelRepositoriesPanel`, `SyncdConnectionPanel`, `SuwayomiUpdatePanel`.
- Sources/search: `BrowseV3`, `SourcesView`, `Extensions`, `ExtensionSettingsPanel`.
- Migration/detail modals: `MigrateModal`, `MassMigrateModal`, `NovelMigrateModal`, `TasteInsightsModal`, `SeriesDetailV3Shell`.

## Acessibilidade

Marco 1 nao alterou componentes visuais, entao nao foram aplicadas correcoes de contraste neste marco.

Pendencias para Marco 2+:

- Validar WCAG AA em componentes base antes e depois da migracao.
- Corrigir apenas contraste, surfaces, borders, blur, shadows, fontes, hover, focus e disabled.

## Checklist Visual

Marco 1 nao capturou screenshots antes/depois porque nao houve migracao de componente visual.

Screenshots obrigatorios a partir do Marco 2 quando houver alteracao visual:

- Library
- Reader
- Settings
- Sources
- Downloads
- Modal
- Popover
- Dropdown
- Toast
- Cards
- Buttons
- Inputs
- Sidebar
- Toolbar
- Mass Migration
- Updater

## Plano Para Proximos Temas

Antes de criar qualquer tema novo:

1. Completar Marco 2 com componentes base usando somente `component-*` e semantic tokens.
2. Migrar Layout, Settings, Reader HUD, Library, Sources, Mass Migration e Updater em marcos separados.
3. Manter `--n-*` como compatibilidade ativa ate os consumidores reais serem movidos para tokens semanticos/componentes.
4. So depois criar novos temas alterando `nocturne-theme.css` como referencia de formato.

## Resultado Do Marco 1

- Tokens removidos: nenhum.
- Tokens classificados como Morto: nenhum.
- Componentes visuais migrados: nenhum.
- Infraestrutura preparada: sim, parcialmente.
- Proximo passo recomendado: revisar este marco e iniciar Marco 2 com screenshots reais antes/depois dos componentes base.

## Validacao Do Marco 1

Executado:

- `pnpm exec vitest run --project unit src/store/themeTokens.test.ts` - passou, 3 testes.
- `pnpm build` - passou.
- `git diff --check` - passou; apenas avisos de normalizacao LF/CRLF do Git.

Observacoes:

- Uma tentativa anterior com `pnpm test:unit -- src/store/themeTokens.test.ts` executou tambem a suite ampla configurada pelo workspace; o teste novo falhou uma vez porque classificava uso no ThemeEditor como Ativo. A classificacao foi corrigida para tratar ThemeEditor/store/preset como Legacy e o teste focado passou depois disso.
- O worktree ja continha mudancas fora deste marco em assets e screenshots de `docs/`; elas nao foram tocadas pela migracao de temas.
- `src/components/settings/Settings.svelte` aparece no status por normalizacao de linha, mas nao possui diff de conteudo em `git diff`.

---

## Marco 2 - Componentes Base

Status: implementado de forma incremental e limitado ao escopo permitido.

### Escopo Migrado

Componentes alterados neste marco:

- `src/components/layout/Toaster.svelte`
- `src/components/shared/ContextMenu.svelte`

O `ContextMenu` foi tratado como a implementacao compartilhada de menu/dropdown contextual. Nenhuma tela de Library, Settings, Reader, Sources, Downloads, Mass Migration ou Updater foi migrada neste marco.

### Tokens Criados Neste Marco

Tokens adicionados em `src/styles/tokens.css` e implementados para Nocturne em `src/styles/nocturne-theme.css`:

- Pesos tipograficos: `--weight-semibold`, `--weight-bold`, `--weight-extrabold`.
- Menu/dropdown: `--component-menu-radius`, `--component-menu-shadow`, `--component-menu-z-index`, `--component-menu-item-fg`, `--component-menu-item-hover-bg`, `--component-menu-item-hover-fg`, `--component-menu-item-danger-fg`, `--component-menu-item-danger-hover-bg`, `--component-menu-icon-fg`, `--component-menu-divider`.
- Toast: `--component-toast-bg-hover`, `--component-toast-border-hover`, `--component-toast-radius`, `--component-toast-offset`, `--component-toast-blur`, `--component-toast-focus-ring`, `--component-toast-life-bg`, `--component-toast-title-fg`, `--component-toast-body-fg`, `--component-toast-success-fg`, `--component-toast-error-fg`, `--component-toast-info-fg`, `--component-toast-download-fg`, `--component-toast-progress-track`, `--component-toast-progress-fill`, `--component-toast-progress-shadow`, `--component-toast-action-bg`, `--component-toast-action-bg-hover`, `--component-toast-action-fg`, `--component-toast-action-border`, `--component-toast-close-bg`, `--component-toast-close-bg-hover`, `--component-toast-close-fg`, `--component-toast-close-fg-hover`, `--component-toast-close-border`, `--component-toast-close-border-hover`.

Classificacao: Legacy/Ativo incremental. Eles existem no CSS final; `Toaster` e `ContextMenu` ja consomem estes tokens ativamente. Como os tokens novos tambem servem de contrato para temas futuros e custom themes ainda nao os editam diretamente, nao devem ser removidos.

### Cores Diretas Removidas

Comando:

```powershell
rg -n "#[0-9A-Fa-f]{3,8}\b|rgba?\(|hsla?\(|oklch\(|color-mix\(" src\components\layout\Toaster.svelte src\components\shared\ContextMenu.svelte
```

Resultado apos a migracao: nenhuma ocorrencia.

Ocorrencias migradas para tokens:

- `Toaster.svelte`: background radial/rgba, border, shadow, hover, focus ring, progress bar, status accents, action button, close button, title/body colors.
- `ContextMenu.svelte`: background, border, shadow, item foreground, hover, danger state, icon color, divider.

Excecoes mantidas nesses componentes: nenhuma para cores diretas. Valores de dimensao pequenos que preservam layout local, como `11px`, `12px`, `24px`, `34px` e paddings internos, foram mantidos porque este marco nao deve alterar layout nem reescrever o componente.

### Acessibilidade

Problema encontrado:

- `--component-toast-body-fg` herdava a cor antiga `rgba(202, 196, 208, 0.5)`, que ficava abaixo de 4.5:1 para texto pequeno no fundo do toast Nocturne.

Correcao:

- `--component-toast-body-fg` foi elevado para `rgba(202, 196, 208, 0.62)`.

Validacao automatica adicionada:

- `src/components/shared/baseThemeComponents.test.ts` calcula contraste dos pares Nocturne usados por Toast e ContextMenu e exige WCAG AA para texto normal (`>= 4.5:1`).

### Testes Adicionados

Arquivo novo:

- `src/components/shared/baseThemeComponents.test.ts`

Cobertura:

- render minimo do `Toaster`;
- render minimo do `ContextMenu`;
- ausencia de cores diretas nos componentes migrados;
- contraste AA dos tokens Nocturne usados pelos componentes migrados.

`vitest.workspace.ts` passou a incluir este teste no projeto `shell-jsdom`.

### Screenshots Reais

Tentativa realizada:

- Servidor local encontrado em `127.0.0.1:1420`.
- A automacao do navegador embutido tentou abrir a superficie local para capturar estados reais.
- A navegacao nao estabilizou dentro de 90s e reiniciou a sessao do navegador.

Resultado:

- Screenshots reais antes/depois nao foram gerados neste marco.
- Nao foram criados mockups nem screenshots artificiais para substituir essa evidencia.

Risco registrado:

- Antes do Marco 3, e recomendavel expor um caminho de auditoria visual controlado para estados reais de base components, por exemplo um metodo de audit bridge somente em runtime de automacao que dispare toast e menu/dropdown reais sem alterar fluxos de usuario.

### Componentes Base Nao Migrados

Nao existem componentes genericos centralizados para `Modal`, `Dialog`, `Card`, `Button`, `Input` e `Tabs` equivalentes ao `Toaster`/`ContextMenu` neste marco. As implementacoes atuais aparecem espalhadas em componentes de feature e telas (`MangaPreview`, `TrackingPanel`, `Settings`, `MassMigrateModal`, `MigrateModal`, `LibraryCard`, `LibraryToolbar`, `LibraryDisplayPopover`, entre outros).

Por restricao de escopo, estes nao foram migrados no Marco 2 para evitar alterar telas ou iniciar Marco 3/4/6 por acidente.

### Resultado Do Marco 2

- Tokens removidos: nenhum.
- Tokens classificados como Morto: nenhum.
- Componentes migrados: `Toaster`, `ContextMenu`.
- Componentes fora do Design System deixados para marcos futuros: `NocturneState`, `MangaPreview`, `TrackingPanel`, modais de migracao, cards de biblioteca, settings controls, popovers de Library/Downloads/Sources e tabs/inputs definidos dentro de telas.
- `pnpm exec vitest run --project shell-jsdom src/components/shared/baseThemeComponents.test.ts`: passou, 4 testes.
- `pnpm exec vitest run --project unit src/store/themeTokens.test.ts`: passou, 3 testes.
- `pnpm build`: passou; Vite manteve apenas o aviso de chunks acima de 500 kB.
- `git diff --check`: passou; apenas avisos de normalizacao LF/CRLF do Git.

---

## Marco 3 - Layout

Status: implementado de forma incremental e limitado ao layout.

### Escopo Migrado

Componentes/seletores alterados neste marco:

- `src/components/layout/Layout.svelte`
- `src/components/layout/ActivityButton.svelte`
- `src/components/layout/ActivityOverlay.svelte`
- `src/components/layout/TitleBar.svelte`
- `src/components/layout/WindowControlsInline.svelte`
- Bloco global de shell/layout em `src/styles/nocturne-port.css`, de `.aethon-app-shell` ate antes de `.n-btn`.

Areas cobertas:

- app shell background/text/font;
- sidebar/navigation rail;
- itens de navegacao e badges;
- topbar/header;
- search dim layer;
- toolbar icon buttons;
- window controls;
- activity overlay/back action.

Nao foram migrados neste marco:

- Settings e seus seletores `.aethon-port--settings`;
- Reader/Reader HUD;
- Library cards/toolbars internos;
- Downloads/Sources/Mass Migration/Updater;
- `.n-btn` base buttons;
- `RecentActivity.svelte` conteudo interno do painel;
- `SplashScreen`/branding visual.

### Tokens Criados Neste Marco

Tokens adicionados em `src/styles/tokens.css` e implementados para Nocturne em `src/styles/nocturne-theme.css`:

- App/layout: `--component-app-bg`, `--component-app-fg`, `--component-app-font`, `--component-detail-layer-bg`, `--component-search-dim-bg`.
- Sidebar/nav: `--component-sidebar-bg`, `--component-sidebar-border`, `--component-sidebar-shadow`, `--component-sidebar-blur`, `--component-sidebar-scrim-bg`, `--component-sidebar-highlight-bg`, `--component-sidebar-z-index`, `--component-sidebar-search-z-index`, `--component-nav-item-*`, `--component-nav-tooltip-*`, `--component-nav-badge-*`.
- Topbar/search/toolbar: `--component-topbar-*`, `--component-search-*`, `--component-toolbar-icon-*`.
- Window controls: `--component-window-controls-z-index`, `--component-window-control-*`.
- Activity overlay/badge: `--component-activity-badge-*`, `--component-activity-overlay-*`.

Classificacao: Ativo no layout migrado ou Legacy incremental quando tambem serve como contrato para temas futuros. Nenhum token foi removido.

### Cores Diretas Removidas

Comandos:

```powershell
rg -n "#[0-9A-Fa-f]{3,8}\b|rgba?\(|hsla?\(|oklch\(|color-mix\(" src\components\layout\Layout.svelte src\components\layout\ActivityButton.svelte src\components\layout\ActivityOverlay.svelte src\components\layout\TitleBar.svelte src\components\layout\WindowControlsInline.svelte src\components\layout\Sidebar.svelte src\components\layout\AppTopbar.svelte
```

Resultado apos a migracao: nenhuma ocorrencia nos componentes de layout migrados.

Ocorrencias migradas para tokens:

- background/surface do shell;
- sidebar background, blur, border, shadow, scrim, highlight;
- nav item idle/hover/active/error;
- nav tooltip e badges;
- topbar background, border image, blur, shadow, scrim/noise;
- search input/icon/focus/placeholder;
- toolbar icon idle/hover/active;
- window controls idle/hover/active/close;
- activity badge e activity overlay.

### Excecoes Mantidas

- `src/styles/nocturne-port.css` antes de `.aethon-app-shell`: splash/branding visual. Mantido por ser branding e fora do layout app-shell.
- `src/styles/nocturne-port.css` depois de `.n-btn`: base buttons, settings, cards, readers, fixtures e componentes de telas futuras. Mantido por escopo.
- `src/components/layout/RecentActivity.svelte`: conteudo do painel de atividade, nao toolbar/sidebar/topbar. Mantido para evitar expandir o marco.
- Variaveis `--n-*` de dimensao/motion ainda aparecem como camada ativa de compatibilidade no CSS portado. As cores/surfaces/blur/shadow/z-index migrados neste marco passam por component/semantic tokens; a remocao completa de metricas `--n-*` deve ser feita em marco proprio para nao alterar densidade visual.

### Acessibilidade

Validado automaticamente:

- render de sidebar/nav ativa;
- render de window controls;
- render de activity toolbar badge;
- ausencia de cores diretas nos componentes de layout migrados;
- ausencia de cores diretas no bloco global do shell/layout.

Nao houve alteracao de contraste visual pretendida neste marco. A migracao preserva os valores Nocturne existentes via tokens.

### Screenshots Reais

Screenshots capturados da janela real do Aethon:

- Antes: `docs/screenshots/theme-marco3-before-layout.png`
- Depois: `docs/screenshots/theme-marco3-after-layout.png`

Observacao: o conteudo das recomendacoes mudou entre capturas por dados runtime, mas a comparacao visual do shell mostra sidebar, topbar, search, toolbar e window controls equivalentes.

### Testes Adicionados

Arquivo novo:

- `src/components/layout/layoutThemeComponents.test.ts`

Cobertura:

- render minimo de Sidebar;
- render minimo de TitleBar e WindowControlsInline;
- render minimo de ActivityButton com badge;
- regra estatica contra cores diretas nos componentes migrados;
- regra estatica contra cores diretas no bloco global de shell/layout em `nocturne-port.css`.

`vitest.workspace.ts` passou a incluir este teste no projeto `shell-jsdom`.

### Resultado Do Marco 3

- Tokens removidos: nenhum.
- Tokens classificados como Morto: nenhum.
- Componentes migrados: `Layout`, `ActivityButton`, `ActivityOverlay`, `TitleBar`, `WindowControlsInline`, shell CSS de Sidebar/Topbar/Search/Toolbar.
- Componentes fora do Design System deixados para marcos futuros: Settings, Reader HUD, Library, Downloads, Sources, Mass Migration, Updater, base buttons, cards, inputs, tabs e conteudo interno de RecentActivity.
- `pnpm exec vitest run --project shell-jsdom src/components/layout/layoutThemeComponents.test.ts src/components/shared/baseThemeComponents.test.ts`: passou, 9 testes.
- `pnpm exec vitest run --project unit src/store/themeTokens.test.ts`: passou, 3 testes.
- `pnpm build`: passou; Vite manteve apenas o aviso de chunks acima de 500 kB.
- `git diff --check`: passou; apenas avisos de normalizacao LF/CRLF do Git.

## Marco 4 - Settings

### Escopo executado
- Migrado exclusivamente o visual central de Settings: shell, topbar local, rails, subnav, cards, rows, toggles, chips, botoes pequenos, selects/dropdowns locais, meters, overlays/painel de backup e estados de foco/hover relacionados.
- Nao foram alteradas regras de negocio, i18n, updater, Reader, Library, Sources, Mass Migration ou Updater.
- Nao removi tokens.

### Tokens utilizados/criados
Foram adicionados tokens `--component-settings-*` em `src/styles/tokens.css`, com implementacao canonica Nocturne em `src/styles/nocturne-theme.css`:
- base: `--component-settings-font`, `--component-settings-fg`;
- surfaces/text/borders: `--component-settings-surface-*`, `--component-settings-border-*`, `--component-settings-text-*`;
- shell/topbar/rail/nav/card/row: `--component-settings-modal-*`, `--component-settings-topbar-*`, `--component-settings-rail-*`, `--component-settings-nav-*`, `--component-settings-card-*`, `--component-settings-row-*`;
- controls: `--component-settings-button-*`, `--component-settings-toggle-*`, `--component-settings-chip-*`, `--component-settings-input-*`, `--component-settings-select-menu-*`;
- feedback/effects: `--component-settings-meter-*`, `--component-settings-overlay-*`.

### Cores diretas removidas
- `Settings.svelte`: controles `step-btn`, `select-btn`, `select-menu`, storage meter, `path-input-error`, `folder-update-excluded`, overlay/painel de backup.
- `nocturne-port.css`: bloco principal `.aethon-port--settings` e regras centrais de modal, topbar, rail, nav, subnav, cards, rows, toggles, chips, botoes e notices.

### Excecoes mantidas
- `Settings.svelte`: swatches dos temas e `input[type=color]` do leitor prose continuam com cores diretas por serem valores editaveis/fixtures visuais, nao tokens do shell.
- `Settings.svelte`: regras de Content/source status usam `color-mix()` com tokens semanticos para estados success/error; mantido como legado ativo ate o Marco de Content/Sources.
- `nocturne-port.css`: preview de tema, brand card e ilustracoes internas de Settings ainda possuem gradientes/cores diretas; mantidos como legado ativo para evitar diff visual amplo.
- `ThemeEditor.svelte`, `SyncdConnectionPanel.svelte`, `SuwayomiUpdatePanel.svelte` e `NovelRepositoriesPanel.svelte` ainda possuem estilos locais e devem ser migrados em lotes especificos. O updater nao foi alterado por restricao do Marco 4.

### Screenshots reais
- Antes: `docs/screenshots/theme-marco4-before-settings.png`
- Depois: `docs/screenshots/theme-marco4-after-settings.png`
Ambos capturados do app real rodando via WebView2/CDP na tela Settings/General com Nocturne.

Validacao final CDP/WebView2:

- `docs/screenshots/marco4-validation/settings-general-final-real.png`
- `docs/screenshots/marco4-validation/settings-appearance-real.png`
- `docs/screenshots/marco4-validation/settings-themeeditor-real.png`
- `docs/screenshots/marco4-validation/settings-system-security-real.png`
- `docs/screenshots/marco4-validation/settings-syncd-real.png`
- `docs/screenshots/marco4-validation/settings-content-integrations-real.png`
- `docs/screenshots/marco4-validation/settings-novel-repositories-or-source-rules-real.png`
- `docs/screenshots/marco4-validation/settings-advanced-about-real.png`
- `docs/screenshots/marco4-validation/settings-suwayomi-updater-real.png`

Foram removidos os screenshots diagnosticos temporarios (`current-*`, `try-*`, `settings-after-wait.png` e capturas intermediarias duplicadas). Em `src/test/browser/__screenshots__`, os baselines validos de Settings foram mantidos apenas em `src/test/browser/__screenshots__/custom/*.png`; as imagens automaticas de falha do provider em `src/test/browser/__screenshots__/src/components/settings/Settings.browser.test.ts/` foram removidas.

### Validacao
- `npm test -- --project shell-jsdom src/components/settings/Settings.test.ts`: passou, 8 testes.
- `npm test -- --project shell-jsdom src/components/settings/Settings.test.ts src/components/settings/SuwayomiUpdatePanel.test.ts src/components/settings/NovelRepositoriesPanel.test.ts src/components/settings/SyncdSessionDetails.test.ts`: passou, 4 arquivos, 21 testes.
- `npm test -- --project browser-components src/components/settings/Settings.browser.test.ts`: passou, 1 arquivo, 6 testes. O harness foi alinhado ao app real aplicando `data-theme="nocturne"` no `html` durante testes browser.
- `pnpm build`: passou. Apenas aviso conhecido de chunks maiores que 500 kB.
- `git diff --check`: passou; apenas avisos de normalizacao LF/CRLF do Git.

Observacao: `NovelRepositoriesPanel.svelte` existe e possui teste focado, mas nao esta montado diretamente em Settings nesta build. A validacao visual real cobriu a area alcancavel de `Content & Integrations > Source rules`, que e o ponto de repositories/source rules disponivel em Settings. A migracao visual completa de `NovelRepositoriesPanel.svelte` fica documentada como risco/pendencia futura.

### Riscos antes do Marco 5
- Settings ainda tem legado ativo em previews, swatches, ThemeEditor e paineis especializados. Nao remover/migrar sem lote dedicado.
- Algumas variaveis `--n-*` seguem usadas para dimensoes/motion herdadas; classificar como Legacy ativo ate uma etapa especifica de compatibilidade.
- Updater foi mantido fora deste marco conforme restricao, entao seus estilos diretos permanecem documentados para etapa propria.

## Marco 5 - Reader HUD

### Escopo executado
- Migrada exclusivamente a camada visual compartilhada do Reader HUD:
  - `ReaderHud.svelte`;
  - `TtsControls.svelte`;
  - controles herdados por `ReaderBrightnessControl.svelte` via classes `popover-*`.
- Foram preservados comportamento, atalhos, fluxo de leitura, renderizacao, paginacao, TTS e adaptadores de `Reader`, `BookReader` e `NovelReader`.
- Nao foram alterados `Reader.svelte`, `BookReader.svelte`, `NovelReader.svelte`, Library, Downloads, Sources, Settings, Mass Migration ou Updater neste marco.
- Nao removi tokens Legacy nem a camada `--n-*`.

### Tokens utilizados/criados
Foram adicionados tokens `--component-reader-*` em `src/styles/tokens.css`, com implementacao canonica Nocturne em `src/styles/nocturne-theme.css`:

- base/surface: `--component-reader-font`, `--component-reader-bg`, `--component-reader-bg-layer`, `--component-reader-panel-bg`, `--component-reader-panel-hover-bg`, `--component-reader-panel-strong-bg`;
- controles: `--component-reader-control-bg`, `--component-reader-control-hover-bg`, `--component-reader-control-active-bg`, `--component-reader-control-track-bg`, `--component-reader-control-track-hover-bg`;
- bordas/texto/acento: `--component-reader-border`, `--component-reader-border-hover`, `--component-reader-border-active`, `--component-reader-divider`, `--component-reader-fg`, `--component-reader-muted-fg`, `--component-reader-faint-fg`, `--component-reader-accent-fg`, `--component-reader-accent-muted-bg`, `--component-reader-accent-strong-fg`, `--component-reader-accent-gradient`;
- efeitos: `--component-reader-shadow`, `--component-reader-shadow-compact`, `--component-reader-inset-highlight`, `--component-reader-control-shadow`, `--component-reader-blur`, `--component-reader-popover-blur`, `--component-reader-focus-ring`;
- estado/layout/motion: `--component-reader-disabled-opacity`, `--component-reader-hidden-opacity`, `--component-reader-chrome-z-index`, `--component-reader-popover-z-index`, `--component-reader-control-radius`, `--component-reader-popover-radius`, `--component-reader-pill-radius`, `--component-reader-toggle-radius`, `--component-reader-overlay-padding-bottom`, `--component-reader-capsule-width`, `--component-reader-capsule-height`, `--component-reader-capsule-gap`, `--component-reader-capsule-padding-x`, `--component-reader-button-size`, `--component-reader-icon-button-size`, `--component-reader-range-track-height`, `--component-reader-range-thumb-size`, `--component-reader-checkpoint-width`, `--component-reader-checkpoint-height`, `--component-reader-transition-fast`, `--component-reader-transition-popover`.

Classificacao: Ativo nos componentes migrados. Nenhum token foi removido.

### Cores diretas removidas
Comando de verificacao:

```powershell
rg -n "#[0-9A-Fa-f]{3,8}\b|rgba?\(|hsla?\(|oklch\(|color-mix\(" src/components/reader/ReaderHud.svelte src/components/reader/TtsControls.svelte src/components/reader/ReaderBrightnessControl.svelte
```

Resultado apos a migracao: nenhuma ocorrencia nos componentes do Reader HUD migrados.

Ocorrencias migradas para tokens:

- background do viewport/HUD;
- surfaces de capsule bar, back link, metadata title e popovers;
- bordas idle/hover/active;
- sombras, blur e inset highlights;
- textos primary/muted/faint;
- acentos do slider/checkpoint/TTS;
- botoes idle/hover/active/disabled;
- range tracks e thumbs;
- toggles, segmented controls, steppers, selects, swatches e color picker dentro do popover;
- foco visivel do back link, botoes, sliders, selects, inputs e linhas TTS;
- z-index de overlay/popover e transicoes.

### Excecoes mantidas
- Nenhuma cor direta permaneceu em `ReaderHud.svelte`, `TtsControls.svelte` ou `ReaderBrightnessControl.svelte`.
- Valores diretos de tamanho/posicao preservados dentro do componente quando representam geometria local do HUD e nao tema visual global. Os principais tamanhos reutilizaveis do HUD foram promovidos para `--component-reader-*`.
- `Reader.svelte`, `BookReader.svelte` e `NovelReader.svelte` permanecem fora do escopo por conterem renderizacao/logica de leitura e ja existirem alteracoes nao relacionadas no working tree.

### Acessibilidade
Validado automaticamente:

- ausencia de cores diretas nos componentes visuais do Reader HUD;
- consumo obrigatorio de tokens `--component-reader-*`;
- contraste Nocturne >= 4.5:1 para texto primary, muted, faint e acentos sobre o panel do HUD;
- render e interacao basica do HUD sem desmontar conteudo do adapter;
- render e preferencias do TTS.

Correcoes feitas:

- foco visivel tokenizado em back link, botoes do HUD, range de brilho, controles de popover, selects, inputs e TTS;
- disabled opacity passou por token `--component-reader-disabled-opacity`;
- hover/active/focus usam tokens de componente em vez de valores diretos.

### Screenshots reais
Screenshots capturados da janela real do Aethon em Nocturne via WebView2/CDP:

- Antes:
  - `docs/screenshots/marco5-reader-hud/reader-hud-before-main.png`
  - `docs/screenshots/marco5-reader-hud/reader-hud-before-hover-settings.png`
  - `docs/screenshots/marco5-reader-hud/reader-hud-before-focus-settings.png`
  - `docs/screenshots/marco5-reader-hud/reader-hud-before-settings-popover.png`
  - `docs/screenshots/marco5-reader-hud/reader-hud-before-brightness-popover.png`
  - `docs/screenshots/marco5-reader-hud/reader-hud-before-slider-hover.png`
- Depois:
  - `docs/screenshots/marco5-reader-hud/reader-hud-after-main.png`
  - `docs/screenshots/marco5-reader-hud/reader-hud-after-hover-settings.png`
  - `docs/screenshots/marco5-reader-hud/reader-hud-after-focus-settings.png`
  - `docs/screenshots/marco5-reader-hud/reader-hud-after-settings-popover.png`
  - `docs/screenshots/marco5-reader-hud/reader-hud-after-brightness-popover.png`
  - `docs/screenshots/marco5-reader-hud/reader-hud-after-slider-hover.png`

Notas de captura:

- O baseline "antes" foi capturado a partir do commit `394137e` em worktree temporaria.
- Um toast real do updater interceptou o clique de brilho durante a captura; nas capturas finais de controles o toaster foi ocultado no DOM apenas para permitir interacao com o HUD. As imagens continuam sendo screenshots reais do app/WebView2, nao mockups.
- A worktree temporaria foi removida do registro de worktrees apos a captura.

### Validacao
- `npm exec vitest run -- --project shell-jsdom src/components/reader/ReaderHud.test.ts src/components/reader/TtsControls.test.ts src/lib/reader/tts.test.ts --reporter=dot`: passou, 3 arquivos, 18 testes.
- `C:\Users\jhow-\AppData\Roaming\npm\pnpm.cmd build`: passou; Vite manteve apenas o aviso conhecido de chunks maiores que 500 kB.
- `git diff --check`: passou; apenas avisos de normalizacao LF/CRLF do Git.
- Varredura final de cores diretas nos componentes do Reader HUD: sem ocorrencias.
- `pnpm tauri:dev:gate` inicialmente falhou por `ERR_PNPM_IGNORED_BUILDS` no wrapper de pnpm do runtime Codex e depois por arquivo bloqueado pelo sidecar `javaw.exe` do Suwayomi. O sidecar orfao foi encerrado e o app atual abriu via `npm exec pnpm -- tauri:dev:gate`, com CDP em `127.0.0.1:9223`.

### Riscos antes do Marco 6
- Ha alteracoes nao relacionadas no working tree em Discord, Tauri, Reader core e paginas de migracao; elas nao pertencem ao Marco 5 e nao devem ser misturadas no proximo commit.
- `Reader.svelte`, `BookReader.svelte` e `NovelReader.svelte` ainda possuem estilos/logica proprios fora da camada HUD. Migrar esses arquivos exigiria um marco proprio porque toca renderizacao/fluxo de leitura.
- O app real pode exibir toasts do updater sobre o HUD durante auditorias visuais; para comparacoes futuras, usar um perfil/audit path que silencie toasts ou capture com toaster explicitamente oculto.
- A camada `--n-*` segue ativa como compatibilidade e deve continuar classificada como Legacy/Ativo ate haver marco especifico para sua reducao.

### Checklist de escopo pos-Marco 5
- `Reader.svelte`, `BookReader.svelte` e `NovelReader.svelte` aparecem modificados no working tree, mas o diff atual e de Discord Rich Presence/TTS presence, nao de tema. Essas mudancas ja estavam fora do escopo do Marco 5 e devem ser mantidas fora do commit de tema.
- Os arquivos efetivamente alterados pelo Marco 5 sao `ReaderHud.svelte`, `TtsControls.svelte`, `ReaderHud.test.ts`, `tokens.css`, `nocturne-theme.css`, `docs/theme-system-audit.md` e os screenshots em `docs/screenshots/marco5-reader-hud/`.
- Validacao de consumo dos tokens `--component-reader-*`: 50 tokens definidos em `tokens.css`/`nocturne-theme.css`, 0 tokens sem consumo nos componentes/documentacao do Marco 5.
- Mudancas antigas fora do tema a manter separadas: mensagens i18n, Tauri/Cargo, Discord, paginas de migracao, Reader core, Settings e assets/docs de Discord.

## Marco 6 - Library

### Escopo executado
- Migrada exclusivamente a camada visual ativa da Library:
  - `src/components/pages/Library.svelte`;
  - `src/components/library/LibraryShell.svelte`;
  - `src/components/library/LibraryHeader.svelte`;
  - `src/components/library/LibraryToolbar.svelte`;
  - `src/components/library/LibraryCollectionsBar.svelte`;
  - `src/components/library/LibraryDisplayPopover.svelte`;
  - `src/components/library/LibraryDensityRail.svelte`;
  - `src/components/library/BooksLibraryBody.svelte`;
  - `src/components/library/ComicsLibraryBody.svelte`;
  - `src/components/library/LibraryCard.svelte`;
  - `src/components/library/LibraryCardGrid.svelte`;
  - `src/components/library/VirtualLibraryCardGrid.svelte`.
- Nao foram alteradas regras de Library, GraphQL, queries, filtros, ordenacao, selecao, navegacao, persistencia, Sources, Downloads, Reader, Settings, Mass Migration, Updater ou Discord/Rich Presence.
- Nao foram removidos tokens Legacy nem a camada `--n-*`.

### Mapa de componentes

| Arquivo | Status | Evidencia | Acao |
| --- | --- | --- | --- |
| `src/components/pages/Library.svelte` | Ativo | Renderizado pelo `Layout` quando `store.navPage === "library"`; importa `LibraryShell`, `LibraryToolbar`, `BooksLibraryBody`, `ComicsLibraryBody`. | Migrado visualmente. |
| `LibraryShell.svelte` | Ativo | Renderizado por `Library.svelte`; compoe header, toolbar, collections e body. | Migrado visualmente. |
| `LibraryHeader.svelte` | Ativo | Importado por `LibraryShell.svelte`; monta tabs Comics/Books e topbar. | Migrado visualmente. |
| `LibraryToolbar.svelte` | Ativo | Importado por `LibraryShell.svelte` e `Library.svelte`; monta busca, sort, filter, display e refresh. | Migrado visualmente. |
| `LibraryCollectionsBar.svelte` | Ativo | Importado por `LibraryShell.svelte`; renderiza collections/categorias quando presentes. | Migrado visualmente. |
| `LibraryDisplayPopover.svelte` | Ativo | Importado por `LibraryToolbar.svelte`; popover de display/density/layout. | Migrado visualmente. |
| `LibraryDensityRail.svelte` | Ativo | Importado por `LibraryDisplayPopover.svelte`; slider de densidade. | Migrado visualmente. |
| `BooksLibraryBody.svelte` | Ativo | Renderizado por `Library.svelte` quando secao Books esta ativa. | Migrado apenas visual local/drop overlay. |
| `ComicsLibraryBody.svelte` | Ativo | Renderizado por `Library.svelte` quando secao Comics esta ativa. | Migrado apenas visual local/select bar/menu. |
| `LibraryCard.svelte` | Ativo | Renderizado por `LibraryCardGrid` e `VirtualLibraryCardGrid`; usado por Books/Comics ativos. | Migrado visualmente. |
| `LibraryCardGrid.svelte` | Ativo | Usado por grids compartilhados e tests; cadeia ativa via cards/grid. | Migrado z-index visual. |
| `VirtualLibraryCardGrid.svelte` | Ativo | Usado por Books/Comics ativos para renderizacao virtualizada. | Migrado z-index visual. |
| `BooksTypeSelector.svelte` | Ativo | Importado por `LibraryToolbar.svelte` quando ha opcoes de tipo Books. | Sem CSS direto de cor/efeito a migrar; validado no contrato. |
| `NovelsLibraryBody.svelte` | Legacy/Fora do lote | Arquivo existe em `src/components/library`, mas nao e importado por `Library.svelte` na cadeia ativa atual. | Nao migrado para evitar diff por nome. |

### Tokens utilizados/criados
Foram adicionados tokens `--component-library-*` em `src/styles/tokens.css`, com implementacao canonica Nocturne em `src/styles/nocturne-theme.css`:

- base/escala: `--component-library-font`, `--component-library-scale`, `--component-library-topbar-height`;
- surfaces/text/borders/status: `--component-library-surface`, `--component-library-surface-raised`, `--component-library-border-dim`, `--component-library-border-strong`, `--component-library-fg`, `--component-library-muted-fg`, `--component-library-faint-fg`, `--component-library-disabled-opacity`, `--component-library-accent-fg`, `--component-library-accent-muted-bg`, `--component-library-accent-border`, `--component-library-danger-*`;
- cards: `--component-library-card-*`, `--component-library-cover-fallback-bg`;
- navigation/toolbar/popover: `--component-library-chip-divider-bg`, `--component-library-overflow-indicator-*`, `--component-library-toolbar-divider`, `--component-library-dropdown-z-index`, `--component-library-header-z-index`, `--component-library-panel-*`, `--component-library-control-z-index`, `--component-library-insert-shadow`, `--component-library-popover-*`;
- density: `--component-library-density-*`;
- Books/Comics local states: `--component-library-drop-*`, `--component-library-select-*`;
- refresh dialog: `--component-library-refresh-*`.

Classificacao: todos os 94 tokens `--component-library-*` definidos estao Ativos e consumidos por componentes reais da Library. Validacao automatica: 94 definidos, 0 sem consumo.

### Cores diretas removidas
Comando de verificacao:

```powershell
rg -n -- '#[0-9A-Fa-f]{3,8}\b|rgba?\(|hsla?\(|oklch\(|color-mix\(' src/components/library src/components/pages/Library.svelte
```

Resultado apos a migracao: nenhuma ocorrencia nos componentes ativos migrados.

Ocorrencias migradas para tokens:

- `Library.svelte`: backdrop/modal de refresh, opcoes de refresh, chip divider, indicador de overflow, z-indexes de paineis e toolbar hero, icone inline de Books.
- `LibraryToolbar.svelte`: divisores dos menus, color do toggle de direcao, z-indexes de search/cluster/dropdown.
- `LibraryDisplayPopover.svelte`: labels/meta, toggles, mini-switch, thumb, blur, sombras, hover, selected.
- `LibraryDensityRail.svelte`: track/fill/thumb/labels, sombras e z-indexes.
- `BooksLibraryBody.svelte`: drop overlay, blur, panel surface, border, shadow e z-index.
- `ComicsLibraryBody.svelte`: select bar, botoes de selecao, danger state, bulk move menu, disabled opacity, sombras e z-indexes.
- `LibraryCard.svelte`: list card surfaces, hover filters, cover surface/border/shadow, fallback, badges, selection overlay, progress track/fill/liquid/shine, title/meta text, chips e progress.
- `LibraryShell`, `LibraryHeader`, `LibraryCardGrid`, `VirtualLibraryCardGrid`, `LibraryCollectionsBar`: z-index/escala/sombra locais migrados para tokens.

### Excecoes mantidas
- `NovelsLibraryBody.svelte`: mantido como Legacy/Fora do lote porque nao esta na cadeia ativa renderizada por `Library.svelte`.
- `src/styles/nocturne-theme.css`: valores diretos permanecem permitidos por serem implementacao do tema Nocturne, nao consumo direto por componentes.
- `src/styles/tokens.css`: valores diretos permanecem permitidos por serem definicao de tokens primitivos/semanticos/de componente.
- Geometria local que nao representa tema visual global foi preservada quando ja dependia de tokens de layout (`--library-*`, `--sp-*`, `--radius-*`) e nao de cor/efeito direto.

### Acessibilidade
Validado automaticamente:

- ausencia de cores diretas em arquivos ativos da Library;
- ausencia de consumo direto de `--n-*` nos componentes ativos migrados;
- consumo obrigatorio de todos os tokens `--component-library-*`;
- render ativo de Library Cards, toolbar, header, collections e corpos Books/Comics pelos testes existentes.

Validado visualmente no app real:

- grid Comics;
- grid Books;
- foco por teclado em Library;
- popover de display/density/layout;
- cards, badges/chips, botao ativo e controles de toolbar.

Nao houve alteracao pretendida de contraste ou layout. Os valores Nocturne existentes foram preservados por tokens de tema.

### Screenshots reais
Screenshots capturados da janela real do Aethon em Nocturne via WebView2/CDP:

- Antes:
  - `docs/screenshots/marco6-library/library-before-comics-grid.png`
  - `docs/screenshots/marco6-library/library-before-books-grid.png`
  - `docs/screenshots/marco6-library/library-before-focus.png`
  - `docs/screenshots/marco6-library/library-before-display-popover.png`
- Depois:
  - `docs/screenshots/marco6-library/library-after-comics-grid.png`
  - `docs/screenshots/marco6-library/library-after-books-grid.png`
  - `docs/screenshots/marco6-library/library-after-focus.png`
  - `docs/screenshots/marco6-library/library-after-display-popover.png`

Notas de captura:

- A primeira tentativa de captura "depois" atingiu timeout porque o CDP listou primeiro a pagina auxiliar `novelRuntimeHost`, que nao possui `window.__aethonAudit`. A captura final selecionou explicitamente a pagina principal com a ponte de auditoria.
- A comparacao Comics antes/depois ficou visualmente equivalente. O badge de notificacao da topbar variou por estado runtime real do app, nao por mudanca de tema.

### Validacao
- `C:\Users\jhow-\AppData\Roaming\npm\pnpm.cmd test:unit -- src/components/library/LibraryThemeTokens.test.ts src/components/library/LibraryCardGrid.test.ts src/components/library/LibraryToolbar.test.ts src/components/library/BooksLibraryBody.test.ts src/components/library/ComicsLibraryBody.test.ts src/components/library/LibraryShell.test.ts src/components/library/LibraryCollectionsBar.test.ts src/components/library/LibraryHeader.test.ts`: passou; por configuracao do script, executou a suite unit/shell ampla, 100 arquivos e 537 testes.
- `npm exec vitest run -- --project shell-jsdom src/components/library/LibraryThemeTokens.test.ts`: passou, 1 arquivo, 2 testes.
- `C:\Users\jhow-\AppData\Roaming\npm\pnpm.cmd build`: passou; Vite manteve apenas o aviso conhecido de chunks maiores que 500 kB.
- `git diff --check`: passou; apenas avisos de normalizacao LF/CRLF do Git, incluindo arquivos antigos fora deste marco.

### Riscos antes do Marco 7
- Ha alteracoes antigas e nao relacionadas no working tree em Discord/Rich Presence, Tauri/Cargo, mensagens i18n, paginas de migracao, Reader core e Settings. Nao misturar essas alteracoes no commit do Marco 6.
- `NovelsLibraryBody.svelte` permanece Legacy/Fora do lote e deve ser reavaliado se a secao de novels voltar a ser renderizada pela Library ativa.
- A camada `--n-*` segue existindo em temas e CSS legado; no Marco 6 ela deixou de ser consumida diretamente pelos componentes ativos da Library, mas nao foi removida.
- Marco 7 nao deve iniciar antes de revisar/stagear somente o diff de tema da Library, porque o working tree continua com mudancas antigas fora do escopo.

## Marco 7 - Sources

### Escopo executado
- Migrada exclusivamente a camada visual ativa de Sources:
  - `src/components/pages/SourcesView.svelte`;
  - `src/components/pages/ExtensionSettingsPanel.svelte`.
- O host `src/components/pages/BrowseV3.svelte` foi mantido fora da migracao visual porque tambem serve Search/Discover e ja possui mudancas antigas fora deste marco. Ele foi usado apenas como rota/shell de validacao.
- Nao foram alteradas regras de instalacao/remocao/update de extensoes, repositorios, busca, filtros, navegacao, i18n, Library, Downloads, Reader, Settings, Mass Migration, Updater, Discord/Rich Presence ou Tauri.
- Nao foram removidos tokens Legacy nem a camada `--n-*`.

### Mapa de componentes

| Componente | Status no Marco 7 | Evidencia |
| --- | --- | --- |
| `SourcesView.svelte` | Ativo/migrado | Renderizado pela aba `Browse > Sources`; screenshots reais mostram lista, repositorios e estados de extensao. |
| `ExtensionSettingsPanel.svelte` | Ativo/migrado | Renderizado ao abrir uma extensao instalada na aba Sources; screenshot `sources-after-settings-panel.png`. |
| `BrowseV3.svelte` | Ativo/fora do lote | Shell compartilhado de Search/Discover/Sources; nao migrado para evitar tocar superficies fora do Marco 7. |
| `NovelSources.svelte` | Legacy/fora do lote | Possui teste proprio, mas nao participa da superficie ativa validada neste marco. |
| `Extensions.svelte`, `SourceBrowse.svelte`, `SourceList.svelte` | Legacy/fora do lote | Telas/implementacoes antigas de Sources/Discover; nao migradas sem marco dedicado. |

### Tokens utilizados/criados
Foram adicionados tokens `--component-sources-*` em `src/styles/tokens.css`, com implementacao canonica Nocturne em `src/styles/nocturne-theme.css`.

Categorias cobertas:

- escala e layout local: `--component-sources-scale`, `--component-sources-root-*`;
- panels/cards/tabela/lista: `--component-sources-panel-*`, `--component-sources-row-*`, `--component-sources-card-*`, `--component-sources-cardlist-*`;
- texto e metadata: `--component-sources-eyebrow-*`, `--component-sources-title-*`, `--component-sources-meta-*`, `--component-sources-subtle-*`;
- filtros/botoes/inputs: `--component-sources-tabs-*`, `--component-sources-input-*`, `--component-sources-icon-*`, `--component-sources-button-*`, `--component-sources-ghost-*`;
- status/chips/badges: `--component-sources-badge-*`, `--component-sources-status-*`, `--component-sources-lang-*`;
- overlays/repos/APK: `--component-sources-overlay-*`, `--component-sources-repo-*`, `--component-sources-apk-*`;
- settings panel: `--component-sources-settings-*`, `--component-sources-setting-*`, `--component-sources-toggle-*`, `--component-sources-select-*`;
- empty/error/progress: `--component-sources-empty-*`, `--component-sources-error-*`, `--component-sources-progress-*`;
- motion, blur, shadow, radius, spacing e z-index locais.

Classificacao: todos os 133 tokens `--component-sources-*` definidos estao Ativos e consumidos pelos componentes reais migrados. Validacao automatica: 133 definidos, 0 sem consumo.

### Cores diretas removidas
Comando de verificacao:

```powershell
rg -n -- '#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(|oklch\(|color-mix\(|linear-gradient\(|radial-gradient\(|backdrop-filter:\s*blur|box-shadow:\s*[^;]*rgba|--n-' src/components/pages/SourcesView.svelte src/components/pages/ExtensionSettingsPanel.svelte
```

Resultado apos a migracao: nenhuma ocorrencia nos componentes ativos migrados.

Ocorrencias migradas para tokens:

- `SourcesView.svelte`: root e panel surfaces, bordas, divisores, tabs/filtros, search, icon buttons, tabela/lista, extension cards, badges, language pills, status pills, acoes install/update/remove, empty/error states, progress, overlays de repositorio/APK, blur, sombras, radius, spacing, opacity, z-index e estados hover/focus/active/disabled.
- `ExtensionSettingsPanel.svelte`: drawer/surface, header, close button, icon shell, detail grid, action card de mass migration, cards de settings, toggles, selects, inputs, credential rows, sync rows, status pills, hint/help text, scrollbar, hover/focus/disabled, shadows, radius, spacing e z-index.

### Excecoes mantidas
- `BrowseV3.svelte`: mantido fora do Marco 7 por ser shell compartilhado de Search/Discover/Sources e por ja conter mudancas antigas nao relacionadas no working tree. Deve ser migrado somente quando Search/Discover estiverem no escopo.
- `NovelSources.svelte`, `Extensions.svelte`, `SourceBrowse.svelte` e `SourceList.svelte`: classificados como Legacy/Fora do lote; nao foram removidos nem migrados.
- `src/styles/nocturne-theme.css`: valores diretos permanecem permitidos por serem implementacao do tema Nocturne.
- `src/styles/tokens.css`: valores diretos permanecem permitidos por serem definicao de tokens primitivos/semanticos/de componente.

### Acessibilidade
Validado automaticamente:

- ausencia de cores diretas, funcoes de cor, blur/shadow diretos e consumo direto de `--n-*` em `SourcesView.svelte` e `ExtensionSettingsPanel.svelte`;
- consumo obrigatorio de todos os tokens `--component-sources-*`;
- render/fluxo de Sources por `BrowseV3.test.ts`;
- contraste computado no app real: menor razao observada na superficie ativa de Sources foi aproximadamente 7.72:1, acima de WCAG AA para texto normal.

Validado visualmente no app real:

- lista principal de Sources;
- overlay de Manga repositories;
- painel lateral de Extension Settings;
- cards/rows, tabs, inputs, botoes, badges, toggles, select, hover/focus/active/disabled alcancaveis.

Nao houve alteracao pretendida de layout, comportamento ou identidade visual. Os valores Nocturne existentes foram preservados por tokens de componente.

### Screenshots reais
Screenshots capturados da janela real do Aethon em Nocturne via WebView2/CDP:

- Antes:
  - `docs/screenshots/marco7-sources/sources-before-main.png`
  - `docs/screenshots/marco7-sources/sources-before-repos.png`
- Depois:
  - `docs/screenshots/marco7-sources/sources-after-main.png`
  - `docs/screenshots/marco7-sources/sources-after-repos.png`
  - `docs/screenshots/marco7-sources/sources-after-settings-panel.png`

Notas de captura:

- A captura diagnostica `sources-before-settings-panel.png` foi removida porque mostrou novamente o overlay de repositorios, nao o painel lateral. Para evitar registrar comparacao falsa, o baseline antes/depois valido deste marco cobre main e repositories; o painel lateral possui validacao real "depois" e deve ganhar baseline dedicado no proximo lote se houver nova alteracao nele.
- A comparacao main/repositories antes/depois ficou visualmente equivalente. O painel lateral depois ficou integro, com tokens aplicados em cards, rows, toggles, inputs e superficies.

### Validacao
- `C:\Users\jhow-\AppData\Roaming\npm\pnpm.cmd test:unit -- src/components/pages/SourcesThemeTokens.test.ts`: passou; por configuracao do script, executou a suite unit/shell ampla, 102 arquivos e 544 testes.
- `npm exec vitest run -- --project shell-jsdom src/components/pages/SourcesThemeTokens.test.ts src/components/pages/BrowseV3.test.ts`: passou, 2 arquivos e 14 testes. O stderr `Repository timeout` e esperado pelo teste que simula falha parcial de update.
- `C:\Users\jhow-\AppData\Roaming\npm\pnpm.cmd build`: primeira execucao falhou por arquivo gerado transitorio do Paraglide (`src/paraglide/messages/ui_entries.js`) ausente; a segunda execucao passou sem alteracao de codigo. Vite manteve apenas o aviso conhecido de chunks maiores que 500 kB.
- `git diff --check`: passou; apenas avisos de normalizacao LF/CRLF do Git, incluindo arquivos antigos fora deste marco.

### Riscos antes do Marco 8
- Ha alteracoes antigas e nao relacionadas no working tree em Discord/Rich Presence, Tauri/Cargo, mensagens i18n, paginas de migracao, Reader core e Settings. Nao misturar essas alteracoes no commit do Marco 7.
- `BrowseV3.svelte` segue com estilos compartilhados fora deste lote; migrar agora tocaria Search/Discover e violaria o escopo.
- `NovelSources.svelte`, `Extensions.svelte`, `SourceBrowse.svelte` e `SourceList.svelte` continuam Legacy/Fora do lote e devem ser reavaliados quando o escopo incluir Sources legadas ou novels/source status.
- A camada `--n-*` segue existindo em temas e CSS legado; no Marco 7 ela deixou de ser consumida diretamente pelos componentes ativos de Sources migrados, mas nao foi removida.

## Marco 8 - Mass Migration

### Escopo executado
- Migrada exclusivamente a camada visual ativa de Mass Migration:
  - `src/components/pages/MassMigrateModal.svelte`.
- O modal foi validado pelo fluxo real `Browse > Sources > Extension Settings > Mass migration`.
- Nao foram alteradas regras de preview, selecao, busca manual, aplicacao/undo de migracao, journal, GraphQL, Sources, Library, Reader, Settings, Updater, Discord/Rich Presence ou Tauri.
- `MigrateModal.svelte` e `NovelMigrateModal.svelte` permaneceram fora do lote por serem migracoes individuais/novel migration, nao Mass Migration ativa deste marco.
- Nao foram removidos tokens Legacy nem a camada `--n-*`.

### Mapa de componentes

| Componente | Status no Marco 8 | Evidencia |
| --- | --- | --- |
| `MassMigrateModal.svelte` | Ativo/migrado | Aberto a partir de `SourcesView.svelte` e `ExtensionSettingsPanel.svelte`; screenshots reais mostram loading, lista de destinos e foco. |
| `MigrateModal.svelte` | Ativo/fora do lote | Modal de migracao individual de manga, nao alterado neste marco. |
| `NovelMigrateModal.svelte` | Ativo/fora do lote | Modal de migracao de novels, nao alterado neste marco. |

### Tokens utilizados/criados
Foram adicionados tokens `--component-migration-*` em `src/styles/tokens.css`, com implementacao canonica Nocturne em `src/styles/nocturne-theme.css`.

Categorias cobertas:

- overlay/modal: `--component-migration-overlay-*`, `--component-migration-modal-*`;
- texto/divisores: `--component-migration-eyebrow-*`, `--component-migration-title-*`, `--component-migration-muted-*`, `--component-migration-divider-*`;
- controles: `--component-migration-icon-*`, `--component-migration-primary-*`, `--component-migration-secondary-*`, `--component-migration-input-*`;
- rows/cards/listas: `--component-migration-row-*`, `--component-migration-item-*`, `--component-migration-cover-*`, `--component-migration-source-icon-*`;
- selecao/acoes: `--component-migration-select-*`, `--component-migration-menu-*`;
- estados: `--component-migration-error-*`, `--component-migration-done-*`, `--component-migration-disabled-*`, `--component-migration-focus-*`;
- motion/efeitos: `--component-migration-transition-*`, `--component-migration-animation-*`, `--component-migration-pair-arrow-*`.

Classificacao: todos os 88 tokens `--component-migration-*` definidos estao Ativos e consumidos pelo componente real migrado. Validacao automatica: 88 definidos, 0 sem consumo.

### Cores diretas removidas
Comando de verificacao:

```powershell
rg -n -- '#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(|oklch\(|color-mix\(|linear-gradient\(|radial-gradient\(|backdrop-filter:\s*blur|box-shadow:\s*[^;]*rgba|--n-' src/components/pages/MassMigrateModal.svelte
```

Resultado apos a migracao: nenhuma ocorrencia no componente ativo migrado.

Ocorrencias migradas para tokens:

- `MassMigrateModal.svelte`: overlay, blur, z-index, modal surface, border, shadow, header, steps, lista de fontes, rows hover/selected, inputs/focus, queue items, selection buttons, disabled states, covers, pair arrow, manual search results, action menu, footer, primary/secondary buttons, error states e focus-visible.

### Excecoes mantidas
- `MassMigrateModal.svelte`: as 3 linhas antigas de Discord Presence permanecem no worktree, mas sao mudancas preexistentes fora do tema e nao pertencem ao Marco 8.
- `MigrateModal.svelte` e `NovelMigrateModal.svelte`: mantidos fora do lote, apesar de terem mudancas antigas no working tree.
- `src/styles/nocturne-theme.css`: valores diretos permanecem permitidos por serem implementacao do tema Nocturne.
- `src/styles/tokens.css`: valores diretos permanecem permitidos por serem definicao de tokens primitivos/semanticos/de componente.

### Acessibilidade
Validado automaticamente:

- ausencia de cores diretas, funcoes de cor, blur/shadow diretos e consumo direto de `--n-*` em `MassMigrateModal.svelte`;
- consumo obrigatorio de todos os tokens `--component-migration-*`;
- render/fluxo de abertura por `BrowseV3.test.ts`;
- contraste computado no app real: menor razao observada na superficie ativa do modal foi aproximadamente 10.48:1, acima de WCAG AA para texto normal.

Corrigido neste marco:

- adicionada regra `:focus-visible` tokenizada para controles do modal.

Risco registrado sem alterar comportamento:

- com o modal aberto, a ordem de tabulacao ainda pode alcancar elementos atras do overlay. Corrigir exige focus trap/inert e alteraria comportamento de modal, entao deve ser tratado em marco especifico de acessibilidade/modal behavior.

### Screenshots reais
Screenshots capturados da janela real do Aethon em Nocturne via WebView2/CDP:

- Antes:
  - `docs/screenshots/marco8-mass-migration/mass-migration-before-sources.png`
- Depois:
  - `docs/screenshots/marco8-mass-migration/mass-migration-after-sources.png`
  - `docs/screenshots/marco8-mass-migration/mass-migration-after-target-list.png`
  - `docs/screenshots/marco8-mass-migration/mass-migration-after-focus.png`

Notas de captura:

- O baseline antes capturou o estado de loading do modal. A comparacao direta before/after cobre esse estado equivalente; a captura adicional `mass-migration-after-target-list.png` documenta a lista carregada apos a migracao.
- A captura de foco mostra a pendencia de focus trap: o foco pode sair do modal para elementos do shell atras do overlay. Essa pendencia foi mantida como risco comportamental, nao corrigida neste marco visual.

### Validacao
- `npm exec vitest run -- --project shell-jsdom src/components/pages/MassMigrationThemeTokens.test.ts src/components/pages/BrowseV3.test.ts`: passou, 2 arquivos e 14 testes. O stderr `Repository timeout` e esperado pelo teste que simula falha parcial de update.
- `C:\Users\jhow-\AppData\Roaming\npm\pnpm.cmd build`: passou; Vite manteve apenas o aviso conhecido de chunks maiores que 500 kB.
- `git diff --check`: passou; apenas avisos de normalizacao LF/CRLF do Git, incluindo arquivos antigos fora deste marco.

### Riscos antes do Marco 9
- Ha alteracoes antigas e nao relacionadas no working tree em Discord/Rich Presence, Tauri/Cargo, mensagens i18n, Reader core, Settings e migracoes individuais. Nao misturar essas alteracoes no commit do Marco 8.
- `MigrateModal.svelte` e `NovelMigrateModal.svelte` ainda possuem estilos diretos e devem ser migrados em lote proprio se o escopo futuro incluir migracoes individuais/novel migration.
- O focus trap/inert de `MassMigrateModal.svelte` permanece pendente como acessibilidade comportamental.
- A camada `--n-*` segue existindo em temas e CSS legado; no Marco 8 ela deixou de ser consumida diretamente pelo componente ativo migrado, mas nao foi removida.

## Marco 9 - Updater

### Escopo executado
- Migrada exclusivamente a camada visual do updater de Suwayomi:
  - `src/components/settings/SuwayomiUpdatePanel.svelte`.
- Nao foram alteradas regras de update, runtime, staging, install, rollback, Tauri, i18n, Settings shell, Reader, Library, Sources, Mass Migration ou Downloads.
- A rota real validada foi `Settings > Updates`, que abre a pane `Advanced > About` com o painel `data-testid="suwayomi-update-panel"`.
- Nao foram removidos tokens Legacy nem a camada `--n-*`.

### Mapa de componentes

| Componente | Status no Marco 9 | Evidencia |
| --- | --- | --- |
| `SuwayomiUpdatePanel.svelte` | Ativo/migrado | Importado por `Settings.svelte` e renderizado na pane About; screenshots reais mostram summary e dialog de detalhes. |
| `Settings.svelte` | Host/fora do lote | Usado apenas como shell de navegacao para validar o painel; nao recebeu migracao visual neste marco. |

### Tokens utilizados/criados
Foram adicionados tokens `--component-updater-*` em `src/styles/tokens.css`, com implementacao canonica Nocturne em `src/styles/nocturne-theme.css`.

Categorias cobertas:

- painel/summary: `--component-updater-panel-*`, `--component-updater-summary-*`;
- status pills: `--component-updater-pill-*`, incluindo estados danger e update available;
- overlay/backdrop: `--component-updater-backdrop-*`;
- modal/dialog: `--component-updater-modal-*`;
- status row: `--component-updater-status-*`;
- changelog body: `--component-updater-changelog-*`.

Classificacao: todos os 49 tokens `--component-updater-*` definidos estao Ativos e consumidos pelo componente real migrado. Validacao automatica: 49 definidos, 0 sem consumo.

### Cores diretas removidas
Comando de verificacao:

```powershell
rg -n -- '#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(|oklch\(|color-mix\(|linear-gradient\(|radial-gradient\(|backdrop-filter:\s*blur|box-shadow:\s*[^;]*rgba|--n-' src/components/settings/SuwayomiUpdatePanel.svelte
```

Resultado apos a migracao: nenhuma ocorrencia no componente ativo migrado.

Ocorrencias migradas para tokens:

- `SuwayomiUpdatePanel.svelte`: pill base, pill danger, pill update available, backdrop, blur, z-index, modal surface, radial background, border, radius, shadow, dialog backdrop, status row, changelog body, fonte, spacing e tamanhos do modal.

### Excecoes mantidas
- `src/styles/nocturne-theme.css`: valores diretos permanecem permitidos por serem implementacao do tema Nocturne.
- `src/styles/tokens.css`: valores diretos permanecem permitidos por serem definicao de tokens primitivos/semanticos/de componente.
- O estado real do updater mudou entre capturas antes/depois (`Update available` para `Up to date`) apos reload/check de runtime; isso foi registrado como diferenca de dados, nao regressao visual.

### Acessibilidade
Validado automaticamente:

- ausencia de cores diretas, funcoes de cor, blur/shadow diretos, z-index numerico direto e consumo direto de `--n-*` em `SuwayomiUpdatePanel.svelte`;
- consumo obrigatorio de todos os tokens `--component-updater-*`;
- render e fluxos principais por `SuwayomiUpdatePanel.test.ts`.

Validado no app real:

- summary do updater em Nocturne;
- dialog de detalhes;
- overlay/backdrop;
- estado de pill;
- rows e botoes disabled dentro do dialog.

Contraste computado no app real:

- `.suwayomi-update-modal`: aproximadamente 14.57:1;
- `.suwayomi-update-modal__status`: aproximadamente 15.51:1.

Nao houve correcao funcional de focus trap/inert neste marco. O `dialog.showModal()` existente permanece responsavel pelo comportamento modal.

### Screenshots reais
Screenshots capturados da janela real do Aethon em Nocturne via WebView2/CDP:

- Antes:
  - `docs/screenshots/marco9-updater/updater-before-summary.png`
  - `docs/screenshots/marco9-updater/updater-before-details.png`
- Depois:
  - `docs/screenshots/marco9-updater/updater-after-summary.png`
  - `docs/screenshots/marco9-updater/updater-after-details.png`

Notas de captura:

- As capturas foram feitas em `Settings > Updates`.
- O baseline antes tinha update disponivel/toast real; depois do reload a sessao reportou runtime atualizado. A geometria, superficies, blur, radius, shadows e hierarquia visual do painel/modal permaneceram equivalentes.

### Validacao
- `npm exec vitest run -- --project shell-jsdom src/components/settings/SuwayomiUpdateThemeTokens.test.ts src/components/settings/SuwayomiUpdatePanel.test.ts`: passou, 2 arquivos e 11 testes.
- `C:\Users\jhow-\AppData\Roaming\npm\pnpm.cmd build`: a primeira execucao falhou por arquivo gerado transitorio do Paraglide (`src/paraglide/messages/es.js`) ausente; a segunda execucao passou sem alteracao de codigo. Vite manteve apenas o aviso conhecido de chunks maiores que 500 kB.
- `git diff --check`: passou; apenas avisos de normalizacao LF/CRLF do Git, incluindo arquivos antigos fora deste marco.

### Riscos antes do proximo marco
- Ha alteracoes antigas e nao relacionadas no working tree em Discord/Rich Presence, Tauri/Cargo, mensagens i18n, Reader core, Settings e migracoes individuais. Nao misturar essas alteracoes no commit do Marco 9.
- `Settings.svelte` continua como host visual amplo e possui mudancas antigas fora deste lote; este marco migrou apenas `SuwayomiUpdatePanel.svelte`.
- O estado do updater depende de chamadas reais ao runtime/GitHub; para futuras comparacoes visuais, preferir perfil controlado ou fixture de runtime para evitar diferenca de dados entre before/after.
- `MigrateModal.svelte`, `NovelMigrateModal.svelte` e demais telas fora do updater seguem pendentes para marcos futuros conforme escopo.

## Marco 10 - Downloads

### Escopo executado
- Migrada exclusivamente a camada visual ativa de Downloads:
  - `src/components/pages/Downloads.svelte`.
- A superficie ativa foi confirmada no app real via WebView2/CDP em `http://tauri.localhost/`: sidebar `Downloads` abre `.aethon-port--downloads`, heading `Download Queue`, estado real `0 Items` e empty state `No downloads queued.`.
- Nao foram alteradas regras de fila, pause/resume, remove, reorder, open folder, GraphQL, stores, persistencia, Layout, Sidebar, Topbar, Reader, Library, Sources, Settings, Updater, Mass Migration, Discord/Rich Presence, Tauri/Cargo ou i18n.
- Nao foram removidos tokens Legacy nem a camada `--n-*`.

### Estados reais mapeados
- Disponiveis no app real: tela principal, estado vazio, filtros, acoes globais, foco por teclado em `Pause All`, botoes globais disabled via `aria-disabled`.
- Nao disponiveis no app real durante a validacao: linhas ativas, pausadas, erro, finished e controles por item. Esses estados continuam cobertos por `Downloads.test.ts`, que usa fixture com `DOWNLOADING`, `QUEUED`, `ERROR` e `FINISHED`, sem modificar dados do usuario.

### Tokens utilizados/criados
Foram adicionados tokens `--component-downloads-*` em `src/styles/tokens.css`, com implementacao canonica Nocturne em `src/styles/nocturne-theme.css`.

Categorias cobertas:

- escala/topbar/menu: `--component-downloads-scale`, `--component-downloads-topbar-*`, `--component-downloads-menu-*`;
- page/header/pill: `--component-downloads-page-*`, `--component-downloads-header-*`, `--component-downloads-pill-*`;
- summary/actions: `--component-downloads-summary-*`, `--component-downloads-primary-button-*`;
- empty/loading: `--component-downloads-empty-*`, `--component-downloads-load-note-*`;
- rows/thumb/status/progress: `--component-downloads-row-*`, `--component-downloads-thumb-*`, `--component-downloads-progress-*`;
- controls/focus/motion: `--component-downloads-row-action-*`, `--component-downloads-transition-*`, `--component-downloads-focus-ring`, opacity e transforms tokenizados.

Classificacao: todos os 137 tokens `--component-downloads-*` definidos estao Ativos ou ativos via cadeia de tokens/computed style. Validacao automatica: 137 definidos, 137 consumidos, 0 sem consumo.

### Cores e efeitos diretos removidos
Comando de verificacao:

```powershell
rg -n -- "--n-|#[0-9A-Fa-f]{3,8}\b|rgba?\(|hsla?\(|oklch\(|color-mix\(|linear-gradient\(|radial-gradient\(|backdrop-filter:\s*blur|box-shadow:\s*[^;]*rgba|z-index:\s*[0-9]|opacity:\s*0\.[0-9]|border-radius:\s*[0-9]" src\components\pages\Downloads.svelte
```

Resultado apos a migracao: nenhuma ocorrencia em `Downloads.svelte`.

Ocorrencias migradas para tokens:

- pill, summary card, borders, dividers, text, empty state, load note, rows, thumbs, status labels, progress track/fill, hover/focus/disabled, shadows, radius, z-index, opacity, transitions, transforms e menu panel.
- O inline style da barra de progresso deixou de usar `opacity: 0.15` direto e passou a usar `--component-downloads-progress-queued-opacity`.

### Excecoes mantidas
- `src/styles/nocturne-theme.css`: valores diretos permanecem permitidos por serem implementacao do tema Nocturne.
- `src/styles/tokens.css`: valores diretos permanecem permitidos por serem definicao de tokens primitivos/semanticos/de componente.
- `Downloads.svelte`: media query `520px`, percentuais de layout, grid/flex e valores de estado funcional como largura percentual de progresso permanecem como geometria/comportamento local, nao como cor/efeito visual direto.

### Acessibilidade
Validado automaticamente:

- ausencia de cores diretas, funcoes de cor, blur/shadow diretos, z-index numerico direto e consumo direto de `--n-*` em `Downloads.svelte`;
- consumo obrigatorio de todos os tokens `--component-downloads-*`;
- render e fluxos principais por `Downloads.test.ts`.

Corrigido neste marco:

- `downloads-menu-panel` ficava presente no DOM com geometria correta, mas `opacity: 0` no WebView2 quando aberto. A opacidade foi fixada via `--component-downloads-menu-opacity`, sem alterar logica de abertura/fechamento nem tocar no popover compartilhado.
- foco visivel local de botoes de summary e row actions passa por `--component-downloads-focus-ring`.

### Screenshots reais
Screenshots capturados da janela real do Aethon em Nocturne via WebView2/CDP:

- Antes:
  - `docs/screenshots/marco10-downloads/downloads-before-main.png`
  - `docs/screenshots/marco10-downloads/downloads-before-filter.png`
  - `docs/screenshots/marco10-downloads/downloads-before-actions.png`
  - `docs/screenshots/marco10-downloads/downloads-before-disabled-focus.png`
- Depois:
  - `docs/screenshots/marco10-downloads/downloads-after-main.png`
  - `docs/screenshots/marco10-downloads/downloads-after-filter.png`
  - `docs/screenshots/marco10-downloads/downloads-after-actions.png`
  - `docs/screenshots/marco10-downloads/downloads-after-disabled-focus.png`

Notas de captura:

- O estado real de Downloads estava vazio em todas as capturas (`0 Items`).
- As capturas antes de filtro/acoes registram a tela real antes da correcao, mas o painel nao ficava visivel por `opacity: 0`. As capturas depois mostram os popovers visiveis e tokenizados.
- Um toast real de update do Suwayomi aparece em algumas capturas; ele pertence ao runtime atual e nao foi editado neste marco.

### Validacao
- `npm exec vitest run -- --project shell-jsdom src/components/pages/DownloadsThemeTokens.test.ts src/components/pages/Downloads.test.ts`: passou, 2 arquivos e 11 testes.
- Contagem de tokens: 137 definidos, 137 consumidos, 0 sem consumo.
- Varredura final de `Downloads.svelte`: sem cores diretas, funcoes de cor, blur/shadow diretos, z-index numerico direto, opacity decimal direta, radius numerico direto ou consumo direto de `--n-*`.
- `pnpm build`: a execucao pelo wrapper do runtime Codex falhou antes de compilar por `ERR_PNPM_IGNORED_BUILDS`; a execucao com `C:\Users\jhow-\AppData\Roaming\npm\pnpm.cmd build` passou. Vite manteve apenas o aviso conhecido de chunks maiores que 500 kB.
- `git diff --check`: passou; apenas avisos de normalizacao LF/CRLF do Git, incluindo arquivos antigos fora deste marco.

### Riscos antes do proximo marco
- Ha alteracoes antigas e nao relacionadas no working tree em Discord/Rich Presence, Tauri/Cargo, mensagens i18n, Reader core, Settings e migracoes individuais. Nao misturar essas alteracoes com o Marco 10.
- Estados reais com fila ativa/pausada/erro nao estavam disponiveis visualmente sem criar dados artificiais; a validacao desses estados ficou nos testes de fixture.
- `BrowseV3.svelte`, `MigrateModal.svelte`, `NovelMigrateModal.svelte`, Reader core, Settings especializados e a camada `--n-*` seguem pendentes para marcos futuros.

## Marco 11 - BrowseV3

### Escopo executado
- Migrada exclusivamente a camada visual de `src/components/pages/BrowseV3.svelte`.
- Nao foram alteradas APIs, stores, GraphQL, navegacao, logica de busca, Reader, Library, Downloads, Sources, Settings, Updater, Discord/Rich Presence, Tauri/Cargo ou i18n.
- A alteracao funcional de Discord ja existente em `BrowseV3.svelte` antes deste marco foi preservada e nao faz parte desta migracao de tema.
- Nao foram removidos tokens Legacy nem a camada `--n-*`.

### Superficie ativa
- `BrowseV3.svelte` continua sendo a superficie ativa de Browse/Search/Discover no app: a sidebar `Browse` navega para `navPage === "search"` e renderiza as tabs `Search`, `Discover` e `Sources`.
- Este marco tokenizou apenas os estilos locais de BrowseV3. `SourcesView.svelte` ja havia sido tratado no Marco 7 e nao foi alterado aqui.

### Tokens utilizados/criados
Foram adicionados tokens `--component-browse-*` em `src/styles/tokens.css`, com implementacao Nocturne em `src/styles/nocturne-theme.css`.

Categorias cobertas:

- topbar/subtabs/search shell;
- sidebar/filtros do Discover;
- search landing, recommendation rows e insight panel;
- cards auxiliares, skeletons, empty/loading states;
- source rows, catalog shell, split view e filtros locais;
- inputs, selects, segmented controls, toggles, chips, badges e scrollbars;
- hover/focus/active/disabled, radius, shadows, z-index, opacity, motion e dimensoes herdadas do HUD.

Classificacao: todos os 443 tokens `--component-browse-*` definidos estao Ativos por consumo direto em `BrowseV3.svelte`. Validacao automatica: 443 definidos, 443 consumidos, 0 sem consumo.

### Cores e efeitos diretos removidos
Comando de verificacao:

```powershell
rg -n -- "--n-|#[0-9A-Fa-f]{3,8}\b|rgba?\(|hsla?\(|oklch\(|color-mix\(|linear-gradient\(|radial-gradient\(" src\components\pages\BrowseV3.svelte
```

Resultado apos a migracao:

- O bloco `<style>` de `BrowseV3.svelte` ficou com 0 ocorrencias de cores diretas, funcoes de cor, gradients, blur/shadow diretos ou consumo direto de `--n-*`.
- As ocorrencias restantes em `BrowseV3.svelte` estao fora do CSS e foram classificadas como excecoes:
  - cores de branding dos trackers em `trackerBrandColor()`;
  - `fill` inline de SVGs/logotipos de trackers;
  - estrela SVG de rating.

### Excecoes mantidas
- `trackerBrandColor()` mantem hex colors por branding de provedores externos.
- SVGs inline mantem `fill` hardcoded por serem logotipos/assets embutidos, nao superficie tematica do app.
- `src/styles/nocturne-theme.css` e `src/styles/tokens.css` continuam autorizados a conter valores diretos por serem arquivos de tema/tokens.
- A camada `--n-*` permanece como compatibilidade de tema. `BrowseV3.svelte` nao a consome diretamente apos este marco.

### Acessibilidade
Validado automaticamente:

- ausencia de cores diretas, funcoes de cor, blur/shadow diretos, z-index numerico direto, opacity decimal direta, radius numerico direto e consumo direto de `--n-*` no bloco `<style>` de `BrowseV3.svelte`;
- consumo obrigatorio de todos os tokens `--component-browse-*`;
- render e fluxos principais por `BrowseV3.test.ts`.

Validado visualmente no app real em Nocturne via WebView2/CDP:

- Search principal;
- Discover com skeleton/loading real de resultados;
- filtros/dropdown local de Discover.

### Screenshots reais
Screenshots capturados da janela real do Aethon em Nocturne via WebView2/CDP:

- Antes, a partir do baseline `6918aa6e7a4ee5515486d616f2ff6ef14d038bf6`:
  - `docs/screenshots/marco11-browsev3/browse-before-real-main.png`
  - `docs/screenshots/marco11-browsev3/browse-before-real-discover-results.png`
  - `docs/screenshots/marco11-browsev3/browse-before-real-filters.png`
- Depois:
  - `docs/screenshots/marco11-browsev3/browse-after-real-main.png`
  - `docs/screenshots/marco11-browsev3/browse-after-real-discover-results.png`
  - `docs/screenshots/marco11-browsev3/browse-after-real-filters.png`

Comparacao visual:

- Search principal: geometria, sidebar, topbar, tabs, painel lateral, tipografia e superficies permaneceram equivalentes. O before carregou cards de recomendacao e o after ficou em estado real de preparacao; essa diferenca e de dados/runtime.
- Discover: estrutura de filtros, skeletons, scrollbars, bordas, surfaces e hierarquia visual permaneceram equivalentes.
- Filtros/dropdown local: abertura, dimensoes, bordas, scroll interno e contraste permaneceram equivalentes. O before chegou a carregar resultados e o after ficou em skeleton; diferenca atribuida ao estado runtime/Suwayomi/fontes, nao a regressao visual.
- Nao ha regressao visual aparente em layout, radius, sombras, blur, borders, surfaces, hover/focus visiveis nos estados capturados.

### Validacao
- `npm exec vitest run -- --project shell-jsdom src/components/pages/BrowseV3ThemeTokens.test.ts src/components/pages/BrowseV3.test.ts`: passou, 2 arquivos e 14 testes.
- Contagem de tokens: 443 definidos, 443 consumidos, 0 sem consumo.
- Varredura final do bloco `<style>` de `BrowseV3.svelte`: 0 ocorrencias diretas.
- `C:\Users\jhow-\AppData\Roaming\npm\pnpm.cmd build`: passou; o Vite manteve apenas o aviso conhecido de chunks maiores que 500 kB.
- `git diff --check`: passou; apenas avisos de normalizacao LF/CRLF do Git.

### Riscos antes do proximo marco
- O diff de BrowseV3 e grande porque a tela concentrava muitos estilos legados locais; ele ficou restrito ao arquivo permitido e aos tokens do marco.
- Os screenshots before/after reais agora existem, mas os dados nao ficaram identicos entre execucoes: Search/Discover alternaram entre cards carregados e skeleton/loading real. A aprovacao visual deve ser lida com essa ressalva de estado runtime.
- Resultados completos dependem do runtime/Suwayomi/fontes instaladas.
- Ha alteracoes antigas e nao relacionadas no working tree em Discord/Rich Presence, Tauri/Cargo, mensagens i18n, Reader core, Settings e migracoes individuais. Nao misturar essas alteracoes com o Marco 11.
- `MigrateModal.svelte`, `NovelMigrateModal.svelte`, Reader core, Settings especializados e a reducao futura da camada `--n-*` seguem pendentes.

## Marco 12 - Migration Modals

### Escopo executado
- Migrada exclusivamente a camada visual de `src/components/pages/MigrateModal.svelte` e `src/components/pages/NovelMigrateModal.svelte`.
- Nao foram alteradas APIs, stores, GraphQL, navegacao, logica de migracao, Reader, Library, Downloads, Sources, Settings, Updater, Discord/Rich Presence, Tauri/Cargo ou i18n.
- As alteracoes antigas de Discord/Rich Presence ja presentes em `MigrateModal.svelte` e `NovelMigrateModal.svelte` foram preservadas no worktree, mas nao pertencem a este marco e nao devem ser misturadas em commit seletivo do tema.
- Nao foram removidos tokens Legacy nem a camada `--n-*`.

### Superficies ativas
- `MigrateModal.svelte` e ativo e renderizado por `src/components/pages/SeriesDetail.svelte` quando o usuario aciona a migracao/troca de fonte de um manga da biblioteca.
- `NovelMigrateModal.svelte` e ativo e renderizado por `src/components/pages/NovelDetail.svelte` quando o usuario aciona a migracao de novel e o estado de seguranca/classificacao permite a migracao.
- A validacao visual real reproduziu `MigrateModal.svelte`. O estado real disponivel nao abriu `NovelMigrateModal.svelte` sem alterar dados/configuracao do usuario; por isso a validacao visual desse modal ficou registrada como limitacao, com cobertura automatica de tokens e ausencia de valores diretos.

### Tokens utilizados/criados
Foram adicionados tokens `--component-migrate-modal-*` e `--component-novel-migrate-*` em `src/styles/tokens.css`, com implementacao Nocturne em `src/styles/nocturne-theme.css`.

Categorias cobertas:

- overlay, backdrop blur e z-index;
- modal surface, border, radius, shadow, width e max-height;
- header, divider, tipografia de titulo/eyebrow e close button;
- steps, source rows, hover/active, warning/error states;
- notice layer de novel migration, estados ready/blocked e disabled.

Tambem foram reutilizados os tokens compartilhados `--component-migration-*` criados no Marco 8.

Classificacao: todos os 28 tokens novos `--component-migrate-modal-*` e `--component-novel-migrate-*` definidos estao Ativos por consumo direto nos modais. Validacao automatica: 28 definidos, 28 consumidos, 0 sem consumo.

### Cores e efeitos diretos removidos
Foram removidos dos blocos `<style>` dos modais:

- `rgba()` diretos de overlays, surfaces, borders, hover/active e error/warning states;
- hex direto de texto e warning;
- `linear-gradient()` direto do notice de novel migration;
- `color-mix()` direto de estados ready/blocked;
- `backdrop-filter: blur(...)` direto;
- `box-shadow` direto;
- `z-index`, `opacity` e `border-radius` numericos diretos ligados a aparencia tematica.

Resultado apos a migracao:

- `MigrateModal.svelte`: 0 ocorrencias diretas no bloco `<style>` para cores, funcoes de cor, gradients, blur/shadow diretos, z-index numerico direto, opacity decimal direta, radius numerico direto ou consumo de `--n-*`.
- `NovelMigrateModal.svelte`: 0 ocorrencias diretas no bloco `<style>` para os mesmos criterios.

### Excecoes mantidas
- `src/styles/tokens.css` e `src/styles/nocturne-theme.css` continuam autorizados a conter valores diretos por serem arquivos de tokens/tema.
- Valores de layout/comportamento nao tematicos, como percentuais dinamicos de progresso/similaridade em markup, permanecem fora do escopo visual do token test.
- Nenhuma excecao visual direta foi mantida nos blocos `<style>` dos modais migrados.

### Acessibilidade
Validado automaticamente:

- ausencia de cores diretas, funcoes de cor, gradients, blur/shadow diretos, z-index numerico direto, opacity decimal direta, radius numerico direto e consumo direto de `--n-*` nos blocos `<style>` de `MigrateModal.svelte` e `NovelMigrateModal.svelte`;
- consumo obrigatorio de todos os tokens novos do Marco 12;
- definicao de todos os tokens compartilhados consumidos pelos modais;
- render/fluxo existente de `MigrateModal.test.ts`.

Validado visualmente no app real em Nocturne via WebView2/CDP:

- `MigrateModal.svelte` aberto a partir de `SeriesDetail.svelte`, com overlay, blur, surface, border, radius, sombra, tipografia, steps, filtros de fonte e lista de fontes.

Limitacao:

- `NovelMigrateModal.svelte` nao foi reproduzido visualmente no estado real atual sem criar/alterar dados ou classificacao de fontes. O modal segue coberto por token test e por varredura de valores diretos, mas precisa de smoke visual manual quando houver uma novel migravel no runtime.

### Screenshots reais
Screenshots capturados da janela real do Aethon em Nocturne via WebView2/CDP:

- Antes, a partir do baseline anterior ao Marco 12:
  - `docs/screenshots/marco12-migration-modals/migrate-modal-before-source.png`
- Depois:
  - `docs/screenshots/marco12-migration-modals/migrate-modal-after-source.png`

Comparacao visual:

- `MigrateModal.svelte`: geometria, centralizacao, overlay/blur, surface, bordas, radius, sombra, divisores, filtros, tipografia e hierarquia visual permaneceram equivalentes. Nao ha regressao visual aparente no estado capturado.
- `NovelMigrateModal.svelte`: validacao visual real pendente por limitacao de estado runtime, sem evidencia de regressao automatica nos estilos tokenizados.

### Validacao
- `npm exec vitest run -- --project shell-jsdom src/components/pages/MigrationModalsThemeTokens.test.ts src/components/pages/MigrateModal.test.ts src/components/pages/MassMigrationThemeTokens.test.ts`: passou, 3 arquivos e 5 testes.
- Contagem de tokens novos: 28 definidos, 28 consumidos, 0 sem consumo.
- Varredura final dos blocos `<style>` de `MigrateModal.svelte` e `NovelMigrateModal.svelte`: 0 ocorrencias diretas.
- `C:\Users\jhow-\AppData\Roaming\npm\pnpm.cmd build`: passou; o Vite manteve apenas o aviso conhecido de chunks maiores que 500 kB.
- `git diff --check`: passou; apenas avisos de normalizacao LF/CRLF do Git em arquivos ja alterados.

### Riscos antes do proximo marco
- `NovelMigrateModal.svelte` ainda precisa de comparacao visual real quando houver uma novel migravel disponivel no runtime.
- As mudancas antigas de Discord/Rich Presence dentro de `MigrateModal.svelte` e `NovelMigrateModal.svelte` continuam fora do escopo do tema; qualquer commit seletivo do Marco 12 precisa separar hunks visuais dos hunks de Discord.
- Ha alteracoes antigas e nao relacionadas no working tree em Discord/Rich Presence, Tauri/Cargo, mensagens i18n, Reader core, Settings e outras features. Nao misturar essas alteracoes com o Marco 12.
- Reader core, Settings especializados e a reducao futura da camada `--n-*` seguem pendentes para marcos futuros.

## Marco 13 - Settings Syncd Connection

### Escopo executado
- Migrada exclusivamente a camada visual de `src/components/settings/SyncdConnectionPanel.svelte` e `src/components/settings/SyncdSessionDetails.svelte`.
- Nao foram alteradas APIs, stores, runtime Syncd, pairing, QR, replication, reconnect, persistencia, `Settings.svelte`, ThemeEditor, NovelRepositoriesPanel, Reader, SeriesDetailV3Shell, MangaPreview, NocturneState, Discord/Rich Presence, Tauri/Cargo ou i18n.
- Nao foram removidos tokens Legacy nem a camada `--n-*`.

### Superficies ativas
- `SyncdConnectionPanel.svelte` e ativo em Settings > System > Security, aberto pelo controle `settings-security-syncd-manage`.
- `SyncdSessionDetails.svelte` e ativo quando existem sessoes Syncd persistidas e renderiza o popover de detalhes de cada sessao.
- O runtime real validado tinha `persistedCount: 0`, entao o painel principal foi reproduzido visualmente e o popover de sessao ficou como limitacao visual, com cobertura automatica por `SyncdSessionDetails.test.ts`.

### Tokens utilizados/criados
Foram adicionados tokens `--component-syncd-*` em `src/styles/tokens.css`, com implementacao Nocturne em `src/styles/nocturne-theme.css`.

Categorias cobertas:

- grid/card/surface/list item;
- borders, backgrounds, text muted/label, inputs e focus;
- QR surface, pills/status success/info/danger;
- session trigger, popover z-index, spacing, width, padding e text hierarchy.

Classificacao: todos os 60 tokens `--component-syncd-*` definidos estao Ativos por consumo direto em `SyncdConnectionPanel.svelte` ou `SyncdSessionDetails.svelte`. Validacao automatica: 60 definidos, 60 consumidos, 0 sem consumo.

### Cores e efeitos diretos removidos
Foram removidos dos blocos `<style>` dos componentes Syncd:

- `rgba()` diretos de cards, surfaces, inputs, focus, QR, list items e pills;
- `linear-gradient()` direto do trigger de detalhes;
- `color-mix()` direto dos status pills;
- consumo direto de `--n-on-surface` em input/textarea.

Resultado apos a migracao:

- `SyncdConnectionPanel.svelte`: 0 ocorrencias diretas no bloco `<style>` para cores, funcoes de cor, gradients, blur/shadow diretos ou consumo de `--n-*`.
- `SyncdSessionDetails.svelte`: 0 ocorrencias diretas no bloco `<style>` para os mesmos criterios.

### Excecoes mantidas
- `src/styles/tokens.css` e `src/styles/nocturne-theme.css` continuam autorizados a conter valores diretos por serem arquivos de tokens/tema.
- Dimensoes funcionais do layout responsivo, como `minmax(320px, 1fr)`, `min(100%, 220px)` e media query `880px`, permanecem no componente por serem geometria estrutural, nao cor/efeito tematico.
- Nenhuma excecao visual direta foi mantida nos blocos `<style>` dos componentes Syncd migrados.

### Acessibilidade
Validado automaticamente:

- ausencia de cores diretas, funcoes de cor, gradients, blur/shadow diretos e consumo direto de `--n-*` nos blocos `<style>` de `SyncdConnectionPanel.svelte` e `SyncdSessionDetails.svelte`;
- consumo obrigatorio de todos os tokens `--component-syncd-*`;
- render e interacao do popover por `SyncdSessionDetails.test.ts`;
- render de Settings por `Settings.test.ts`.

Validado visualmente no app real em Nocturne via WebView2/CDP:

- Settings > System > Security com o painel Desktop Sync Pairing aberto;
- estado real sem host ativo, sem peers e sem sessoes persistidas;
- surfaces, cards, inputs/textarea, NocturneState local, buttons, pills e hierarquia visual.

Limitacao:

- Nao havia sessao Syncd persistida no runtime real (`persistedCount: 0`), portanto o popover visual de `SyncdSessionDetails.svelte` nao foi capturado com dados reais. O comportamento e render do popover seguem cobertos por teste unitario.

### Screenshots reais
Screenshots capturados da janela real do Aethon em Nocturne via WebView2/CDP:

- Antes:
  - `docs/screenshots/marco13-syncd/syncd-before-panel.png`
- Depois:
  - `docs/screenshots/marco13-syncd/syncd-after-panel.png`

Comparacao visual:

- `SyncdConnectionPanel.svelte`: geometria, cards, surfaces, inputs, QR/empty state, badges/pills, bordas, radius, spacing e hierarquia visual permaneceram equivalentes. O toast real de update do Suwayomi aparece nas capturas e pertence ao runtime, nao ao Marco 13.
- `SyncdSessionDetails.svelte`: validacao visual real pendente por falta de sessao persistida, sem evidencia de regressao automatica nos estilos tokenizados.

### Validacao
- `npm exec vitest run -- --project shell-jsdom src/components/settings/SyncdConnectionThemeTokens.test.ts src/components/settings/SyncdSessionDetails.test.ts src/components/settings/Settings.test.ts`: passou, 3 arquivos e 13 testes.
- Contagem de tokens novos: 60 definidos, 60 consumidos, 0 sem consumo.
- Varredura final dos blocos `<style>` de `SyncdConnectionPanel.svelte` e `SyncdSessionDetails.svelte`: 0 ocorrencias diretas.
- `C:\Users\jhow-\AppData\Roaming\npm\pnpm.cmd build`: passou; o Vite manteve apenas o aviso conhecido de chunks maiores que 500 kB.
- `git diff --check`: passou; apenas avisos de normalizacao LF/CRLF do Git em arquivos ja alterados.

### Riscos antes do proximo marco
- `SyncdSessionDetails.svelte` ainda precisa de comparacao visual real quando houver sessao Syncd persistida disponivel no runtime.
- `Settings.svelte` segue com mudancas antigas no worktree e nao foi alterado neste marco; qualquer commit seletivo do Marco 13 deve manter essas mudancas fora.
- Ha alteracoes antigas e nao relacionadas no working tree em Discord/Rich Presence, Tauri/Cargo, mensagens i18n, Reader core, Settings, paginas de migracao e outras features. Nao misturar essas alteracoes com o Marco 13.
- Reader core, ThemeEditor, NovelRepositoriesPanel, SeriesDetailV3Shell, MangaPreview, NocturneState e a reducao futura da camada `--n-*` seguem pendentes para marcos futuros.

## Marco 14 - Settings ThemeEditor

### Escopo executado
- Migrada exclusivamente a camada visual de `src/components/settings/ThemeEditor.svelte`.
- Nao foram alteradas logica de edicao, import/export, persistencia, geracao de tokens, APIs, stores, ThemeProvider, `Settings.svelte`, NovelRepositoriesPanel, Reader, SeriesDetailV3Shell, MangaPreview, NocturneState, Discord/Rich Presence, Tauri/Cargo, i18n ou migracoes antigas.
- Nao foram removidos tokens Legacy nem a camada `--n-*`.

### Superficie ativa
- `ThemeEditor.svelte` e ativo: `src/App.svelte` faz lazy import por `themeEditor: () => import("./components/settings/ThemeEditor.svelte")`.
- `Settings.svelte` aciona `onOpenThemeEditor?.(null)` pelo botao `New Theme` em App > Appearance > Custom theme editor.
- Validacao real em Nocturne abriu o modal via app/WebView2/CDP sobre Settings/Appearance.

### Tokens utilizados/criados
Classificacao: todos os 220 tokens `--component-theme-editor-*` definidos estao Ativos por consumo direto em `ThemeEditor.svelte`.

Contagem validada automaticamente:
- Definidos: 220
- Consumidos: 220
- Sem consumo: 0
- Consumidos sem definicao: 0

Categorias cobertas:
- backdrop, z-index e animacao do modal;
- shell, header, actions, save button e danger state;
- preview pane, live preview, reader preview, popover preview, toast preview e swatches;
- editor pane, tabs, preset cards, token rows, color swatches, inputs, sliders, hover/focus e motion.

### Cores e efeitos diretos removidos
- `rgba(0, 0, 0, 0.72)` do backdrop migrado para `--component-theme-editor-backdrop-bg`.
- `z-index: 200` migrado para `--component-theme-editor-backdrop-z-index`.
- `color-mix(...)` do preview popover e reader chrome migrado para tokens de preview.
- Borders `rgba(...)` de swatches migrados para `--component-theme-editor-swatch-border` e `--component-theme-editor-color-swatch-border`.
- `box-shadow: 0 0 0 1px rgba(...)` do color swatch migrado para `--component-theme-editor-color-swatch-shadow`.
- `filter: brightness(1.12)` migrado para `--component-theme-editor-save-hover-filter`.
- Radius, opacity, transitions, dimensoes e spacing locais do modal/editor foram migrados para tokens de componente.
- O componente nao consome `--n-*` diretamente.

### Excecoes mantidas
- `#000000` em `toValidColorPickerValue` e logica de validacao de cores permanece como fallback funcional do input `type="color"`, nao como cor visual aplicada ao componente.
- Inline styles dinamicos de swatches (`background: {tokens[token]}` e `background: {hud[...]}`) permanecem para representar o valor que o usuario esta editando.
- `style={toCssVars(tokens)}` permanece para escopar o preview ao draft do tema, sem aplicar o draft ao shell do editor.
- `style="background: var(--{varName})"` no strip de swatches permanece como preview dinamico de tokens editaveis.
- `style="border-radius: {hud[item.token]}"` permanece como preview dinamico dos valores HUD editados.

### Screenshots reais
Screenshots capturados/registrados em Nocturne:

- Before:
  - `docs/screenshots/marco14-theme-editor/theme-editor-before-existing-baseline.png`
- After:
  - `docs/screenshots/marco14-theme-editor/theme-editor-after-colors.png`
  - `docs/screenshots/marco14-theme-editor/theme-editor-after-focus-hover.png`
  - `docs/screenshots/marco14-theme-editor/theme-editor-after-hud.png`

Observacao: a tentativa inicial de before neste marco capturou Settings/Appearance sem o modal por selecao incorreta do alvo CDP e foi descartada. O baseline before mantido e uma captura real anterior do ThemeEditor em Nocturne, reaproveitada de `docs/screenshots/marco4-validation/settings-themeeditor-real.png`. As capturas after foram feitas diretamente do elemento `.te-backdrop` no app real via WebView2/CDP.

Comparacao visual: geometria, surfaces, radius, bordas, tipografia e hierarquia do ThemeEditor permaneceram equivalentes. Um toast real do updater apareceu sobre o canto inferior direito nas capturas, risco ja conhecido em auditorias visuais e nao relacionado ao ThemeEditor.

### Limitacoes de estado
- Estado de edicao de tema customizado existente e botao de delete nao foram reproduzidos sem criar dados artificiais do usuario.
- Estado de erro de importacao nao foi forçado para evitar alterar fluxo de arquivos do usuario.
- Estados dinamicos de swatch/color picker permanecem cobertos por teste estatico e pela validacao visual do editor principal/HUD.

### Validacao
- `npm exec vitest run -- --project shell-jsdom src/components/settings/ThemeEditorThemeTokens.test.ts`: passou, 4 testes.
- Varredura final do bloco `<style>` de `ThemeEditor.svelte`: 0 ocorrencias diretas de hex/rgb/rgba/hsl/hsla/oklch/color-mix/gradients ou `--n-*`.
- Contagem final de tokens `--component-theme-editor-*`: 220 definidos, 220 consumidos, 0 sem consumo.

### Riscos antes do proximo marco
- `ThemeEditor.svelte` ainda possui excecoes funcionais inevitaveis para preview de valores editaveis por usuario; nao tratar como hardcoded visual.
- `Settings.svelte` segue com mudancas antigas no worktree e nao foi alterado neste marco; qualquer commit seletivo do Marco 14 deve manter essas mudancas fora.
- Ha alteracoes antigas e nao relacionadas no working tree em Discord/Rich Presence, Tauri/Cargo, mensagens i18n, Reader core, Settings, paginas de migracao e outras features. Nao misturar essas alteracoes com o Marco 14.
- NovelRepositoriesPanel, Reader core, SeriesDetailV3Shell, MangaPreview, NocturneState e a reducao futura da camada `--n-*` seguem pendentes para marcos futuros.

## Marco 15 - MangaPreview

### Escopo executado
- Migrada exclusivamente a camada visual de `src/components/shared/MangaPreview.svelte`.
- Nao foram alteradas logica de preview, carregamento de detalhe, capitulos, pastas, series link, GraphQL, stores, navegacao, leitor, Library, Sources, Settings, Reader, Discord/Rich Presence, Tauri/Cargo, i18n ou migracoes antigas.
- Nao foram removidos tokens Legacy nem a camada `--n-*`.

### Superficie ativa
- `MangaPreview.svelte` e ativo: `src/App.svelte` faz lazy import por `mangaPreview: () => import("./components/shared/MangaPreview.svelte")` e renderiza `<MangaPreviewView />`.
- `src/store/state.svelte.ts` mantem `previewManga` e `setPreviewManga(next: Manga | null)`.
- Superficies ativas como Home/Browse usam `setPreviewManga(...)` para abrir o preview.
- Validacao real em Nocturne abriu o preview de `The Greatest Estate Developer` no app/WebView2/CDP usando apenas estado em memoria para acionar a superficie, sem criar ou modificar dados persistidos do usuario.

### Tokens utilizados/criados
Classificacao: todos os 191 tokens `--component-manga-preview-*` definidos estao Ativos por consumo direto em `MangaPreview.svelte`.

Contagem validada automaticamente:
- Definidos: 191
- Consumidos: 191
- Sem consumo: 0
- Consumidos sem definicao: 0

Categorias cobertas:
- backdrop, z-index, modal, coluna de capa, imagem, spinner e estados de carregamento;
- botoes de acao, folder picker, criacao de pasta, series link e estados disabled;
- header, conteudo, skeletons, badges, status, capitulos, progresso e read button;
- descricao, generos, meta table, link modal, busca, lista, thumbnails e estados linked;
- blur, shadow, radius, spacing, opacity, motion e animacoes locais.

### Cores e efeitos diretos removidos
- Backdrop `rgba(...)`, `z-index`, blur e animacao migrados para tokens `--component-manga-preview-backdrop-*`.
- Backgrounds, borders e shadows do modal/capa/conteudo migrados para `--component-manga-preview-modal-*`, `--component-manga-preview-cover-*` e tokens semanticos de superficie.
- Gradientes e cores de progresso/read button/status badges migrados para tokens de componente.
- `box-shadow`, `filter`, `border-radius`, `opacity`, `transition`, `animation`, dimensoes e spacing locais foram migrados para tokens.
- Inline styles estaticos de skeletons, loading icon, caret e labels foram substituidos por classes tokenizadas.
- O componente nao consome `--n-*` diretamente.

### Excecoes mantidas
- `style="width:{(readCount / totalCount) * 100}%"` permanece como largura dinamica funcional da barra de progresso; o track, fill, radius, cor e motion estao tokenizados.
- Imagens de capa e thumbnails continuam sendo dados runtime (`src={coverSrc(...)}`), nao valores visuais hardcoded.
- A captura visual abriu o preview por ponte de auditoria/CDP e store em memoria porque nao ha um botao de auditoria dedicado para MangaPreview; nenhum dado persistido foi criado.

### Screenshots reais
Screenshots capturados/registrados em Nocturne:

- Before:
  - `docs/screenshots/marco15-manga-preview/manga-preview-before-main.png`
  - `docs/screenshots/marco15-manga-preview/manga-preview-before-folder-menu.png`
  - `docs/screenshots/marco15-manga-preview/manga-preview-before-link-modal.png`
- After:
  - `docs/screenshots/marco15-manga-preview/manga-preview-after-main.png`
  - `docs/screenshots/marco15-manga-preview/manga-preview-after-folder-menu.png`
  - `docs/screenshots/marco15-manga-preview/manga-preview-after-link-modal.png`

Comparacao visual: modal principal, folder picker e link modal mantiveram geometria, surfaces, bordas, blur, radius, sombras, tipografia, hierarquia visual e controles equivalentes. A tela por tras do backdrop mudou entre algumas capturas por estado runtime/navegacao do app durante a validacao, mas o componente auditado permaneceu visualmente equivalente.

### Limitacoes de estado
- Estados de erro de refresh, criacao de pasta com erro e resultados reais de series link nao foram forcados para evitar alteracao de dados do usuario; ficam cobertos por teste estatico de contrato visual.
- Hover/focus/disabled foram revisados no runtime quando disponiveis e protegidos por tokens; estados nao disponiveis sem manipular dados persistidos foram documentados como limitacao.

### Validacao
- `npm exec vitest run -- --project shell-jsdom src/components/shared/MangaPreviewThemeTokens.test.ts`: passou, 4 testes.
- `C:\Users\jhow-\AppData\Roaming\npm\pnpm.cmd build`: passou. A primeira tentativa com `pnpm build` pelo wrapper gerenciado do Codex falhou antes do build por `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`; o build foi reexecutado com o pnpm global do usuario e concluiu verde.
- `git diff --check`: passou; apenas avisos de LF/CRLF em arquivos ja modificados no worktree.
- Varredura final do bloco `<style>` de `MangaPreview.svelte`: 0 ocorrencias diretas de hex/rgb/rgba/hsl/hsla/oklch/color-mix/gradients ou `--n-*`.
- Contagem final de tokens `--component-manga-preview-*`: 191 definidos, 191 consumidos, 0 sem consumo.

### Riscos antes do proximo marco
- `NocturneState.svelte`, `NovelRepositoriesPanel.svelte`, `SeriesDetailV3Shell.svelte`, `Reader` core, tracking panels e a reducao futura da camada `--n-*` seguem pendentes para marcos futuros.
- `MangaPreview.svelte` ainda usa `NocturneState` para estado de erro; esse componente especializado permanece pendente e deve ser migrado em marco proprio.
- Ha alteracoes antigas e nao relacionadas no working tree em Discord/Rich Presence, Tauri/Cargo, mensagens i18n, Reader core, Settings, paginas de migracao e outras features. Nao misturar essas alteracoes com o Marco 15.
