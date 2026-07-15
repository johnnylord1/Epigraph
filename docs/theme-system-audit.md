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

## Marco 16 - NocturneState

### Escopo executado
- Migrada exclusivamente a camada visual de `src/components/shared/NocturneState.svelte`.
- Nao foram alteradas APIs, props, textos, chamadas, fluxos de erro/empty/loading, consumidores, Library, Sources, Settings, Reader, tracking panels, SeriesDetailV3Shell, Discord/Rich Presence, Tauri/Cargo, i18n ou migracoes antigas.
- Nao foram removidos tokens Legacy nem a camada `--n-*`.

### Superficie ativa
- `NocturneState.svelte` e componente compartilhado ativo, importado por Library, Sources, Browse, Settings, Syncd, Migration, MangaPreview, SeriesDetail, NovelDetail, Tracking e outras superficies.
- Validacao real em Nocturne usou Books Library com busca sem resultados (`zzzz-nocturne-state-audit-empty`) para renderizar um estado vazio real sem criar ou alterar dados persistidos do usuario.

### Tokens utilizados/criados
Classificacao: todos os 126 tokens `--component-nocturne-state-*` definidos estao Ativos por consumo direto em `NocturneState.svelte`.

Contagem validada automaticamente:
- Definidos: 126
- Consumidos: 126
- Sem consumo: 0
- Consumidos sem definicao: 0

Categorias cobertas:
- layout panel/compact/center, gap, padding, radius, border e shadow;
- backgrounds por tom, rail, icon container, eyebrow, title, body e detail;
- action buttons primary/secondary/danger, hover, focus, active e disabled;
- tons neutral, info, warning, danger e success;
- icon sizing por CSS tokenizado via `size="1em"`.

### Cores e efeitos diretos removidos
- Hex de tons (`#c9b5ff`, `#d6c09a`, `#d8b4ff`, `#b8dfbe`, `#ef9aa8`) migrados para tokens Nocturne.
- `rgba(...)`, `color-mix(...)`, `linear-gradient(...)`, shadows, radius, opacity, transitions, padding, gaps e tamanhos locais migrados para tokens de componente.
- Tamanhos diretos dos icones Phosphor foram removidos do markup e substituidos por `size="1em"` controlado por tokens CSS.
- O componente nao consome `--n-*` diretamente.

### Excecoes mantidas
- Nao ha excecoes visuais hardcoded no componente.
- `role={tone === "danger" ? "alert" : "status"}` permanece como semantica funcional/acessibilidade, fora do sistema visual.

### Screenshots reais
Screenshots capturados/registrados em Nocturne:

- Before:
  - `docs/screenshots/marco16-nocturne-state/nocturne-state-before-books-empty.png`
  - `docs/screenshots/marco16-nocturne-state/nocturne-state-before-element.png`
- After:
  - `docs/screenshots/marco16-nocturne-state/nocturne-state-after-books-empty.png`
  - `docs/screenshots/marco16-nocturne-state/nocturne-state-after-element.png`

Comparacao visual: Books Library empty state manteve geometria, surfaces, rail, icon, borda, sombra, tipografia e hierarquia equivalentes. Um toast real do updater apareceu em algumas capturas como ruido runtime externo e nao pertence ao componente auditado. Uma captura intermediaria ficou escura por estado global de foco da busca (`aethon-library-search-engaged`) e foi sobrescrita apos blur do input, mantendo a busca e o estado vazio.

### Limitacoes de estado
- Tons warning/danger/success e acoes com foco/disabled nao foram forcados no app real para evitar alterar estados de erro ou dados do usuario; ficam cobertos pelo teste focado de render/contrato.
- Como `NocturneState` e compartilhado, a migracao afeta consumidores existentes sem alterar suas chamadas. Validacao visual real cobriu um estado ativo da Library; os demais consumidores devem continuar em risco visual baixo ate serem vistos em seus fluxos naturais.

### Validacao
- `npm exec vitest run -- --project shell-jsdom src/components/shared/NocturneStateThemeTokens.test.ts`: passou, 3 testes.
- `C:\Users\jhow-\AppData\Roaming\npm\pnpm.cmd build`: passou. Mantem apenas o aviso conhecido de chunks maiores que 500 kB.
- `git diff --check`: passou; apenas avisos de LF/CRLF em arquivos ja modificados no worktree.
- Varredura final do bloco `<style>` de `NocturneState.svelte`: 0 ocorrencias diretas de hex/rgb/rgba/hsl/hsla/oklch/color-mix/gradients ou `--n-*`.
- Contagem final de tokens `--component-nocturne-state-*`: 126 definidos, 126 consumidos, 0 sem consumo.

### Riscos antes do proximo marco
- `NovelRepositoriesPanel.svelte`, `SeriesDetailV3Shell.svelte`, `Reader` core, tracking panels e a reducao futura da camada `--n-*` seguem pendentes para marcos futuros.
- `NocturneState` e usado por muitos fluxos; embora o contrato de tokens esteja fechado, consumidores com estados raros de erro/empty ainda podem precisar de smoke visual quando aparecerem naturalmente.
- Ha alteracoes antigas e nao relacionadas no working tree em Discord/Rich Presence, Tauri/Cargo, mensagens i18n, Reader core, Settings, paginas de migracao e outras features. Nao misturar essas alteracoes com o Marco 16.

## Marco 17 - Detail Surfaces

### Escopo executado
- Migrada a camada visual das superficies de detalhe ativas:
  - `src/components/shared/SeriesDetailV3Shell.svelte`
  - `src/components/pages/SeriesDetail.svelte`
  - `src/components/pages/NovelDetail.svelte`
  - `src/components/pages/BookDetail.svelte`
  - `src/components/shared/TrackingPanel.svelte`
  - `src/components/shared/NovelTrackingPanel.svelte`
- Nao foram alteradas APIs publicas, GraphQL, stores, navegacao, leitura, migracao, Discord/Rich Presence, Tauri/Cargo ou i18n.
- Foram preservadas mudancas antigas ja existentes em `BookDetail.svelte`, `TrackingPanel.svelte` e `NovelTrackingPanel.svelte`; este marco tocou apenas CSS/contrato de tokens nesses arquivos.
- Nao foram removidos tokens Legacy nem a camada `--n-*`.

### Superficies ativas
- `SeriesDetail.svelte` e ativo via `Layout.svelte` quando `store.activeManga` existe.
- `NovelDetail.svelte` e ativo via `App.svelte` quando `store.activeNovelDetail` existe.
- `BookDetail.svelte` e ativo via `Layout.svelte` quando `store.activeBookId` resolve um livro.
- `SeriesDetailV3Shell.svelte` e o shell visual compartilhado por Series, Novel e Book details.
- `TrackingPanel.svelte` e aberto a partir de `SeriesDetail.svelte`.
- `NovelTrackingPanel.svelte` e aberto a partir de `NovelDetail.svelte` e `BookDetail.svelte`.

### Tokens utilizados/criados
Classificacao: todos os tokens novos do Marco 17 estao Ativos por consumo direto nas superficies migradas.

Contagem validada automaticamente:
- `--component-detail-*`: 274 definidos, 274 consumidos, 0 sem consumo, 0 consumidos sem definicao, 0 ausentes no Nocturne.
- `--component-tracking-*`: 116 definidos, 116 consumidos, 0 sem consumo, 0 consumidos sem definicao, 0 ausentes no Nocturne.

Categorias cobertas:
- detail shell: background, topbar, hero, cover, tags, metricas, progresso, action band, drawers, chapter toolbar/body, chapter rows/grid, menus/dropdowns e estados hover/focus/active/disabled;
- detail pages: menus locais, download dropdowns, link picker de manga/novel, preview frame de book e estados de loading/missing;
- tracking overlays: backdrop, modal, header, tabs, rows, selects, inputs, botoes, chapter editor, progress, search results, badges, covers, empty/error states, radius, blur, shadow, z-index, opacity e motion.

### Cores e efeitos diretos removidos
- `SeriesDetailV3Shell.svelte`: removidos hex, `rgba(...)`, gradientes, shadows, blur/filter, z-index direto, radius/opacities diretos e consumo direto de `--n-*` no componente.
- `SeriesDetail.svelte`: menus/dropdowns e link picker migrados para `--component-detail-*`.
- `NovelDetail.svelte`: download dropdown e link picker migrados para `--component-detail-*`.
- `BookDetail.svelte`: preview frame visual migrado para `--component-detail-*`.
- `TrackingPanel.svelte` e `NovelTrackingPanel.svelte`: backdrop/modal/tabs/records/search/results migrados para `--component-tracking-*`.

### Excecoes mantidas
- O HTML standalone exportado por `NovelDetail.svelte` conserva CSS direto dentro da string `const html = ...` (`#111`, `#e8e4eb`, `#d3c4ff`, `#2c2933`). Essa excecao e intencional porque o arquivo exportado precisa funcionar fora do app, sem acesso aos CSS variables do tema.
- Inline styles dinamicos de progresso/largura (`style={...width...}`) permanecem funcionais; cor, track, radius e surfaces foram tokenizados.
- Imagens/covers continuam dados runtime, nao valores visuais hardcoded.

### Screenshots reais
Capturas after geradas em Nocturne com app/Vite real e estado de auditoria em memoria, sem criar dados persistidos:

- `docs/screenshots/marco17-detail-surfaces/detail-after-series-main.png`
- `docs/screenshots/marco17-detail-surfaces/detail-after-series-tracking.png`
- `docs/screenshots/marco17-detail-surfaces/detail-after-novel-main.png`
- `docs/screenshots/marco17-detail-surfaces/detail-after-novel-tracking.png`

Limitacao: screenshots before nao foram recapturados neste fechamento porque o Marco 17 ja estava com diff aplicado sobre um worktree sujo com mudancas antigas fora do tema; trocar arquivos para baseline anterior arriscaria misturar/reverter trabalho do usuario. A comparacao visual foi feita contra o comportamento/layout esperado e contra a identidade Nocturne existente. `BookDetail` nao foi capturado no runtime web porque a abertura pelo browser shim de Vite travou em dependencias runtime/Tauri; a superficie ficou coberta pelo contrato de tokens e build.

### Limitacoes de estado
- Series detail e Novel detail foram abertas com estado de auditoria em memoria para evitar escrita persistente.
- Tracking de manga/novel foi validado nos estados reais disponiveis sem credenciais de rastreador conectadas.
- Book tracking e estados de trackers conectados/resultados reais nao foram forcados.

### Validacao
- `npm exec vitest run -- --project shell-jsdom src/components/shared/DetailSurfacesThemeTokens.test.ts src/components/shared/SeriesDetailV3Shell.test.ts`: passou, 6 testes.
- `pnpm build`: bloqueado antes do build por `ERR_PNPM_IGNORED_BUILDS` apos o pnpm recriar `node_modules` e exigir `pnpm approve-builds` para scripts de dependencias (`esbuild`, `protobufjs`, `svelte-preprocess`, etc.).
- `npm run build`: passou, mantendo apenas o aviso conhecido de chunks maiores que 500 kB.
- Varredura final dos blocos `<style>` migrados: 0 ocorrencias diretas de hex/rgb/rgba/hsl/hsla/oklch/color-mix/gradients, blur direto, shadow rgba direto, z-index numerico, radius/opacidade direta ou `--n-*`.

### Riscos antes do proximo marco
- `NovelRepositoriesPanel.svelte`, Reader core e a reducao futura da camada `--n-*` seguem pendentes.
- O lote gerou muitos tokens por preservar fielmente a identidade atual das details; uma etapa futura pode consolidar nomes equivalentes, mas nao deve remover tokens sem evidencia e validacao visual.
- A validacao visual de BookDetail deve ser repetida em WebView2/CDP quando o runtime Tauri estiver estavel.
- Ha alteracoes antigas e nao relacionadas no working tree em Discord/Rich Presence, Tauri/Cargo, mensagens i18n, Reader core, Settings, paginas de migracao e outras features. Nao misturar essas alteracoes com o Marco 17.

## Marco 18 - Settings NovelRepositoriesPanel

### Escopo executado
- Migrada exclusivamente a camada visual de `src/components/settings/NovelRepositoriesPanel.svelte`.
- Nao foram alteradas logica de repositorios, refresh, trust gate, catalogo, instalacao/remocao de plugins, classificacao automatica, smoke test, stores, SourcesView, Settings.svelte, Reader, Discord/Rich Presence, Tauri/Cargo, i18n ou migracoes antigas.
- Nao foram removidos tokens Legacy nem a camada `--n-*`.

### Superficie e status
- `NovelRepositoriesPanel.svelte` possui teste focado e permanece como superficie especializada/Legacy preparada.
- Busca global confirmou que `NovelRepositoriesPanel.svelte` nao esta importado/renderizado por `Settings.svelte` nem pelo app ativo nesta build.
- A UI ativa de repositorios de novels em runtime esta dentro de `SourcesView.svelte` via `utilityPanel === "novelRepos"` e nao foi alterada neste marco.

### Tokens utilizados/criados
Classificacao: todos os tokens novos do Marco 18 estao Legacy/Preparados por consumo direto no componente especializado, mas sem presenca confirmada no runtime ativo do app.

Contagem validada automaticamente:
- `--component-novel-repositories-*`: 89 definidos, 89 consumidos, 0 sem consumo, 0 consumidos sem definicao, 0 ausentes no Nocturne.

Categorias cobertas:
- surfaces/cards, borders, radius, shadows, textos, texto muted, summary pills, filtros, inputs/focus, badges por status, metricas, trust gate, catalog toggle, catalog entries, spacing, opacity/keyframes e motion.

### Cores e efeitos diretos removidos
- Removidos do bloco `<style>` de `NovelRepositoriesPanel.svelte`: `rgba(...)`, `#hex`, `color-mix(...)`, gradiente, shadows diretos, radius direto, opacity direta e consumo direto de `--n-*`.
- O componente agora consome somente `--component-novel-repositories-*` para valores visuais locais.

### Excecoes mantidas
- Nenhuma excecao visual direta permaneceu no bloco `<style>` migrado.
- O breakpoint `@media (max-width: 980px)` permanece direto por ser condicao estrutural responsiva; custom properties nao sao adequadas para media query neste caso e nao altera identidade visual por tema.

### Screenshots reais
- Nao foram geradas screenshots reais do componente porque ele nao esta montado em Settings nem em outra rota ativa do app atual.
- Nao foram criados mockups, dados artificiais ou caminhos temporarios para forcar screenshot.
- A validacao visual em runtime deve ser feita quando o painel voltar a ser montado ou quando houver decisao de substituir o painel ativo de `SourcesView.svelte`.

### Validacao
- `npm exec vitest run -- --project shell-jsdom src/components/settings/NovelRepositoriesPanel.test.ts src/components/settings/NovelRepositoriesThemeTokens.test.ts`: passou, 5 testes.
- `pnpm build`: bloqueado antes do build por `ERR_PNPM_IGNORED_BUILDS`, exigindo `pnpm approve-builds` para scripts de dependencias (`core-js`, `es5-ext`, `esbuild`, `msw`, `protobufjs`, `svelte-preprocess`).
- `npm run build`: passou, mantendo apenas o aviso conhecido de chunks maiores que 500 kB.
- `git diff --check`: passou; apenas avisos de LF/CRLF em arquivos ja modificados no worktree.
- Varredura final do bloco `<style>` de `NovelRepositoriesPanel.svelte`: 0 ocorrencias diretas de hex/rgb/rgba/hsl/hsla/oklch/color-mix/gradients, `--n-*`, shadow rgba direto, z-index numerico, radius direto ou opacity decimal direta.

### Riscos antes do proximo marco
- Reader core (`Reader.svelte`, `BookReader.svelte`, `NovelReader.svelte`) segue como principal superficie ativa pendente e deve ser dividido se o diff crescer.
- A UI ativa de repositorios de novels em `SourcesView.svelte` ja foi tratada no Marco 7 dentro do escopo de Sources, mas ainda compartilha dominio funcional com este painel Legacy.
- A reducao futura da camada `--n-*` segue pendente e deve ocorrer somente apos Reader core.
- Ha alteracoes antigas e nao relacionadas no working tree em Discord/Rich Presence, Tauri/Cargo, mensagens i18n, Reader core, Settings, paginas de migracao e outras features. Nao misturar essas alteracoes com o Marco 18.

## Marco 19 - Reader Core

### Escopo executado
- Migrada exclusivamente a camada visual restante de `src/components/reader/Reader.svelte`, `src/components/reader/BookReader.svelte` e `src/components/reader/NovelReader.svelte`.
- Nao foram alterados fluxo de leitura, progresso, paginacao, fullscreen, atalhos, TTS, cache/offline, GraphQL, stores, sincronizacao, renderizacao EPUB/PDF/manga ou comportamento do HUD.
- `ReaderHud.svelte` e `TtsControls.svelte` foram inspecionados no preflight por serem dependencias visuais do Reader, mas nao foram alterados neste marco.
- Nao foram removidos tokens Legacy nem a camada `--n-*`.

### Preflight e separacao de mudancas antigas
- `Reader.svelte`, `BookReader.svelte` e `NovelReader.svelte` ja estavam modificados no working tree antes do Marco 19 por mudancas antigas de Discord/Rich Presence, TTS presence e resolucao de capas. Essas alteracoes foram preservadas e nao fazem parte da migracao de tema.
- A implementacao do Marco 19 se limitou a estilos e valores visuais locais, mais o inline style de opacidade visual dos step values e da transicao de fade do manga reader.
- A migracao nao exigiu alteracao de logica de leitura, entao nao houve necessidade de dividir o marco em sub-marcos.

### Tokens utilizados/criados
Classificacao: todos os tokens novos do Marco 19 estao Ativos por consumo direto nos tres componentes ativos do Reader Core.

Contagem validada automaticamente:
- `--component-reader-core-*`: 115 definidos em `tokens.css`, 115 definidos em `nocturne-theme.css`, 115 consumidos, 0 sem consumo, 0 consumidos sem definicao, 0 ausentes no Nocturne.

Categorias cobertas:
- manga reader: botoes de erro/retry, banner de retomada, download modal, stepper local, z-index, blur, shadow, motion, fade e gap de long strip;
- book reader: viewport prose, EPUB host, PDF canvas/page, reflow text, placeholders, full-width panel, overlay de erro, radius e shadows;
- novel reader: viewport prose, corpo de leitura, full-width panel e destaque TTS ativo.

### Cores e efeitos diretos removidos
- `Reader.svelte`: migrados `rgba(...)`, radius, shadows, blur, z-index, opacities, transforms e transicoes locais para `--component-reader-core-*`.
- `BookReader.svelte`: migrados backgrounds/gradientes do viewport, surfaces do EPUB/PDF, border/radius/shadow, overlay de erro e placeholder color para tokens.
- `NovelReader.svelte`: migrados backgrounds/gradientes do viewport, surface do reader body, border/radius/shadow e destaque TTS para tokens.

### Excecoes mantidas
- Paletas de leitura prose (`light`, `sepia`, `oled`, `dark`, `slate`, `forest`, `nord`, `warm`, `nocturne`) continuam com hex diretos em `BookReader.svelte` e `NovelReader.svelte`. Elas sao dados funcionais configuraveis pelo usuario/conteudo do leitor, nao cores do tema do app.
- Swatches inline `style="background:#..."` continuam representando essas mesmas paletas funcionais; remove-los para tokens de tema confundiria tema do app com tema de pagina lida.
- O link color `#c9b5ff` injetado no EPUB permanece como excecao funcional dentro do CSS aplicado ao documento EPUB/iframe, onde os CSS variables do shell do app nao sao garantidos.
- `style={\`--prose-page-bg:${prosePalette.bg};\`}` permanece para transmitir a cor selecionada pelo usuario para a superficie de leitura.
- Regras estruturais de layout, dimensoes de pagina/canvas e media queries permanecem como geometria local, nao identidade visual por tema.

### Screenshots reais
- Validacao concluida no app desktop real em Nocturne, com WebView2/CDP estavel em `127.0.0.1:9223` e a pagina principal `Aethon [MAIN :4567]` expondo `window.__aethonAudit`.
- `docs/screenshots/marco19-reader-core/after-manga-reader.png`: Reader de manga no estado real de erro `HTTP 404`, com surface de erro, acoes e HUD.
- `docs/screenshots/marco19-reader-core/after-manga-reader-rendered-mangadex.png`: Reader de manga com paginas reais renderizadas a partir de uma obra MangaDex; 28 imagens detectadas e 12 carregadas no viewport/lazy load no momento da captura, sem erro.
- `docs/screenshots/marco19-reader-core/after-manga-download-modal.png`: modal local de download, settings popover e HUD sobre o mesmo estado real.
- `docs/screenshots/marco19-reader-core/after-book-reader.png`: BookReader EPUB com conteudo real e HUD recolhido.
- `docs/screenshots/marco19-reader-core/after-book-reader-hud-focus.png`: BookReader EPUB com HUD e popover de configuracoes visiveis.
- `docs/screenshots/marco19-reader-core/after-book-reader-pdf-reflow.png`: BookReader PDF real no modo reflow, com paleta Nocturne, texto extraido e HUD visivel.
- `docs/screenshots/marco19-reader-core/after-book-reader-pdf-canvas.png`: o mesmo PDF real no modo canvas, com pagina rasterizada e settings popover; a preferencia reflow original foi restaurada depois da captura.
- `docs/screenshots/marco19-reader-core/after-novel-reader.png`: NovelReader aberto por navegacao real a partir de NovelDetail, com conteudo persistido e HUD visivel.
- Nao foram criados mockups, fixtures artificiais ou dados persistidos para forcar estados. Nao existe baseline before do Reader Core preservado antes da migracao; a comparacao foi feita contra a geometria, hierarquia e comportamento esperados do app e contra o HUD ja validado no Marco 5.
- Nao foi observada regressao aparente de layout, superficies, borders, radius, shadows, tipografia, contraste ou hierarquia visual nas superficies reproduzidas.

### Limitacoes de estado
- O primeiro capitulo selecionado pelo helper retornou `HTTP 404` tanto no carregamento normal quanto em `Try web view`; uma segunda passagem confirmou que essa indisponibilidade era especifica da obra/fonte, nao do Reader Core.
- Matriz real adicional: MangaDex (`Doumo, Suki na hito ni Horegusuri wo Iraisareta Majo desu`) renderizou 28 paginas sem erro; Comick (`Aru Hi, Totsuzen Gal no Iinazuke ga Dekita`) informou que a fonte nao fornece mais as paginas; Manganato (`God At Random`) informou `Cloudflare bypass currently disabled`; Comix (`Shihai Shoujo Kubaru-chan`) retornou `HTTP 404`.
- O BookReader PDF foi validado com `Toaru Majutsu no Index - Old Testament Completo.` nos dois modos: reflow com texto real e uma ilustracao canvas `1116 x 1600`, e canvas nativo `1232 x 1741`; ambos sem estado de erro.
- NovelReader nao possui helper direto `openFirstNovelReader`; ele foi aberto naturalmente pelo helper `openFirstNovel` seguido do botao unico `CONTINUE CH.1` em NovelDetail.
- Hover/active foi validado nos controles do HUD e no settings popover. O primeiro `Tab` do BookReader transferiu foco para o iframe EPUB, comportamento esperado do documento embarcado; os estilos de foco do HUD permanecem cobertos pelo Marco 5.

### Validacao
- A validacao por computed style encontrou 6 aliases Nocturne inicialmente vazios no modal de download (`panel-bg`, `panel-border`, `title-fg`, `option-fg`, `sub-fg`, `step-fg`). As referencias Legacy inexistentes `--reader-*` foram substituidas pelos equivalentes ativos `--component-reader-*`, sem mudanca intencional de valor visual.
- A validacao do PDF encontrou outra falha de resolucao: tokens dependentes de `--prose-text`, `--prose-bg` e `--prose-page-bg` eram computados no `:root` antes de essas variaveis funcionais existirem no viewer. No reflow Nocturne, isso fixava o texto no fallback escuro `#19151d` sobre fundo escuro.
- Os sete tokens dependentes da paleta foram movidos para o contexto global `:where(.book-viewer, .novel-viewer)` e para seu override Nocturne. Depois da correcao, o PDF computou foreground `#ffffff`, panel `#131316` e o gradient baseado em `--prose-page-bg: #131316`, preservando a paleta funcional escolhida pelo usuario.
- Pos-correcao no app real: 115 `--component-reader-core-*` encontrados no computed style e 0 valores vazios.
- O modal corrigido computou `rgba(26, 26, 30, 0.97)`, border `rgba(255, 255, 255, 0.2)`, radius `16px`, shadow Nocturne e `blur(28px) saturate(1.65)`.
- `ReaderCoreThemeTokens.test.ts` passou a validar tambem que todos os aliases usados pelos tokens Reader Core do Nocturne apontam para custom properties definidas e que os sete tokens dependentes da paleta sao definidos no contexto dos viewers.
- `npm exec vitest run -- --project shell-jsdom src/components/reader/ReaderCoreThemeTokens.test.ts src/components/reader/ReaderHud.test.ts src/components/reader/TtsControls.test.ts`: passou apos a correcao, 3 arquivos e 16 testes.
- `pnpm build`: passou, mantendo apenas o aviso conhecido de chunks maiores que 500 kB.
- `git diff --check`: passou; apenas avisos de LF/CRLF em arquivos ja modificados no working tree.
- `ReaderCoreThemeTokens.test.ts` valida contrato 115/115, paridade `tokens.css`/Nocturne, aliases resolviveis, ausencia de valores visuais diretos nos blocos `<style>` e excecoes funcionais de paleta prose.

### Riscos antes do proximo marco
- A renderizacao real do manga reader foi confirmada com MangaDex; falhas observadas nas demais obras foram respostas especificas das fontes (`Cloudflare bypass currently disabled`, paginas nao fornecidas e `404`).
- As mudancas antigas de Discord/Rich Presence/Tauri/i18n/Settings/migracoes continuam presentes fora do escopo e exigem staging seletivo se este marco for commitado.
- A reducao futura da camada `--n-*` continua pendente e deve ocorrer somente apos a validacao visual do Reader Core.

### Veredito
- Marco 19 aprovado para fechamento sem ressalva visual de Reader Core: manga reader, BookReader EPUB/PDF (reflow e canvas), NovelReader e estados reais de erro foram validados.

## Marco 20 - Activity Center

### Escopo executado
- Migrada exclusivamente a camada visual ativa formada por `ActivityButton.svelte`, `ActivityOverlay.svelte` e `RecentActivity.svelte`.
- A cadeia ativa foi confirmada por imports reais: `Layout.svelte` renderiza `ActivityOverlay`; `Home.svelte`, `BrowseV3.svelte`, `Downloads.svelte`, `LibraryHeader.svelte` e `Settings.svelte` reutilizam `ActivityButton`; ambos convergem em `RecentActivity`.
- `Home.svelte`, `TasteInsightsModal.svelte`, wrappers Legacy de Discover/Extensions, logica de notificacoes, historico, retry de fontes, stores e i18n nao foram alterados.
- `Home.svelte` permaneceu fora do lote porque possui 171 ocorrencias visuais diretas e somar sua migracao ao Activity Center ultrapassaria o diff razoavel do marco.

### Tokens e compatibilidade
- `--component-activity-*`: 74 definidos em `tokens.css`, 74 definidos em `nocturne-theme.css`, 74 consumidos pelos tres componentes e 0 sem consumo.
- Os tokens cobrem badge, overlay, painel, borders/dividers, textos, accent/danger, filtros, contadores, cards de issue, thumbnails, actions, timeline, motion, radius, shadow e escala visual.
- `ActivityButton`, `ActivityOverlay` e `RecentActivity` nao consomem mais `--n-*` diretamente.
- `--n-hud-scale` e `--n-topbar-height` permanecem apenas dentro da camada de tokens como aliases Legacy de compatibilidade. Nenhum token Legacy foi removido.
- Os antigos `--activity-*` permanecem definidos como Legacy em `nocturne-theme.css`; nao foram removidos nesta etapa, embora os tres consumidores ativos tenham sido migrados.

### Valores diretos removidos
- Varredura final dos tres blocos `<style>`: 0 ocorrencias de hex, rgb/rgba, hsl/hsla, oklch, color-mix, gradients, `--n-*`, shadows/blur diretos, z-index numerico, radius direto ou opacity decimal direta.
- Geometria estrutural responsiva e calculos de dimensao continuam locais, mas passam pela escala `--component-activity-scale` em vez de acessar a compatibilidade Nocturne diretamente.
- Nao ha excecoes visuais diretas no escopo deste marco.

### Acessibilidade
- A auditoria runtime encontrou falhas pre-existentes no before: subtitulo `4.38:1`, filtros inativos `3.43:1` e textos faint/horarios `2.61:1`.
- Os tres tokens Nocturne correspondentes foram ajustados sem mudar layout. Ratios finais medidos no app real: subtitulo `4.75:1`, filtro inativo `5.28:1`, item subtitle `5.14:1`, issue titles `4.75:1` e horarios `4.75:1`.
- `ActivityCenterThemeTokens.test.ts` fixa WCAG AA `>= 4.5:1` para os tokens de texto normal do Activity Center.

### Screenshots reais
- `docs/screenshots/marco20-activity-center/before-activity-center.png`: Activity Center real em Nocturne antes da migracao, com filtros, contagens e issues reais.
- `docs/screenshots/marco20-activity-center/after-activity-center.png`: mesma superficie apos a migracao e correcao AA. A geometria computada permaneceu `1163 x 658`, radius `18px`, border e shadow equivalentes.
- O screenshot after inclui um toast de atualizacao de biblioteca que surgiu naturalmente durante o runtime; trata-se de mudanca de estado/dados, nao regressao visual do Activity Center.
- A captura diagnostica escurecida pela janela WebView2 inativa foi substituida; apenas o after com a janela focada foi preservado.

### Validacao
- Computed style no app real Nocturne: 74 tokens encontrados no Activity Center e 0 valores vazios.
- `npm exec vitest run -- --project shell-jsdom src/components/layout/ActivityCenterThemeTokens.test.ts src/components/layout/layoutThemeComponents.test.ts`: 2 arquivos e 8 testes passaram antes da adicao do gate de contraste.
- `npm exec vitest run -- --project shell-jsdom src/components/layout/ActivityCenterThemeTokens.test.ts`: 1 arquivo e 4 testes passaram apos o ajuste WCAG.
- Reexecucao final combinada dos testes focados: 2 arquivos e 9 testes passaram, incluindo o gate WCAG.
- `pnpm build`: passou, mantendo apenas o aviso conhecido de chunks maiores que 500 kB.
- `git diff --check`: passou; apenas avisos informativos de conversao LF/CRLF do working tree.

### Riscos antes do proximo marco
- `Home.svelte` permanece a maior superficie ativa nao consolidada, com volume suficiente para um marco proprio.
- `TasteInsightsModal.svelte` continua ativo via `BrowseV3.svelte` e deve ser agrupado com outras superficies auxiliares de Browse somente se o diff permanecer coeso.
- `Discover.svelte` e `Extensions.svelte` permanecem Legacy/fora da rota ativa atual; nao migrar apenas por nome.
- A reducao final de `--n-*` continua pendente na camada de tokens e nos consumidores ativos restantes; nao remover aliases sem busca global e validacao runtime.

### Veredito
- Marco 20 tecnicamente aprovado para fechamento seletivo; nao iniciar Home no mesmo diff.

## Marco 21 - Home Dashboard

### Escopo executado
- Migrada exclusivamente a camada visual de `src/components/pages/Home.svelte`, superficie ativa carregada por `Layout.svelte` para `navPage === "home"`.
- Foram preservadas integralmente logica de busca, navegacao, historico, cards de continuidade, snapshots, fontes, estatisticas, stores, GraphQL, MangaPreview e Activity Center.
- `Home.svelte` nao possuia mudancas locais anteriores no preflight. As mudancas antigas de Discord/Rich Presence, Tauri/Cargo, i18n, Reader, Settings, Books e migracoes permaneceram fora do lote.

### Tokens e compatibilidade
- `--component-home-*`: 74 definidos em `tokens.css`, 74 implementados em `nocturne-theme.css`, 74 consumidos e 0 sem consumo.
- Categorias cobertas: escala, search dim e z-index, foregrounds, accents, surfaces, borders, radius, shadows, progress, charts, status, hover/active, opacity, transforms e motion.
- `Home.svelte` deixou de consumir diretamente a camada `--n-*`. `--component-home-scale` continua apontando para `--n-hud-scale` apenas dentro da camada de tokens e permanece classificado como alias Legacy de compatibilidade.
- Nenhum token Legacy ou `--n-*` foi removido.

### Valores diretos removidos
- Baseline do commit anterior: 82 ocorrencias visuais diretas pelo scanner do marco e 129 referencias diretas `var(--n-*)` em `Home.svelte`.
- Estado final: 0 hex/rgb/rgba/hsl/hsla/oklch/color-mix/gradients ou `--n-*` no bloco `<style>`; shadows, blur, radius, z-index, opacity, filter, transitions e transforms visuais usam tokens.
- Nao permaneceram excecoes visuais diretas no componente. Geometria estrutural responsiva continua local e usa apenas `--component-home-scale` quando depende da escala do HUD.

### Acessibilidade
- Textos pequenos preexistentes usavam alphas entre `0.26` e `0.60`, abaixo de WCAG AA sobre a surface `rgba(28, 27, 27, 0.8)`.
- Os tokens de texto normal foram ajustados para alpha `0.62`, resultando em contraste calculado de aproximadamente `4.67:1`; o token muted de tracking manteve `4.53:1`.
- Iconografia secundaria permaneceu acima de `3:1`. Geometria, tipografia, hierarquia e identidade Nocturne foram preservadas.

### Screenshots reais
- `docs/screenshots/marco21-home/before-home-main.png`: Home real em Nocturne antes da migracao, com cards, quick actions, updates, estatisticas e finished items.
- `docs/screenshots/marco21-home/after-home-main.png`: mesma superficie apos a migracao; geometria e hierarquia permaneceram equivalentes, com aumento apenas no contraste dos textos pequenos.
- `docs/screenshots/marco21-home/after-home-search-focus.png`: busca real focada, acima do dim; computed style mediu z-index `540` para search/center contra `61` para o dim.
- `docs/screenshots/marco21-home/after-home-card-hover.png`: hover real do primeiro card; computed style confirmou surface `rgba(28, 27, 27, 0.8)`, border `rgba(72, 69, 79, 0.05)`, radius, shadow e deslocamento esperados.
- A tentativa inicial de baseline focado atingiu o input oculto de Search/Books, pois duas instancias `.n-search input` estavam montadas. Essa captura invalida foi removida; nao foi renomeada nem apresentada como baseline. O baseline before valido cobre a tela principal, e foco/hover possuem validacao runtime after e contrato automatizado.

### Validacao
- Computed style no app desktop real em Nocturne: 74 tokens encontrados e 0 valores vazios.
- A busca focada manteve `body.aethon-home-search-engaged`, search com `position: relative` e dim com `pointer-events: auto`, sem alterar a logica de entrada/saida.
- `npm exec vitest run -- --project shell-jsdom src/components/pages/HomeThemeTokens.test.ts`: passou, 1 arquivo e 4 testes.
- `npm exec vitest run -- --project shell-jsdom src/components/pages/HomeThemeTokens.test.ts src/components/shared/MangaPreviewThemeTokens.test.ts`: passou, 2 arquivos e 8 testes.
- `pnpm build`: passou com 6294 modulos transformados; permaneceu apenas o aviso conhecido de chunk maior que 500 kB.
- `git diff --check`: passou; apenas avisos informativos de conversao LF/CRLF no working tree.

### Riscos antes do proximo marco
- `TasteInsightsModal.svelte` permanece a proxima superficie auxiliar ativa de Browse com volume visual relevante.
- `NovelSourceCheckModal.svelte` e `NovelSourceStatusDetails.svelte` permanecem candidatos a um lote coeso posterior de diagnostico de novel sources.
- `Discover.svelte`, `Extensions.svelte`, `NovelSources.svelte`, `Tracking.svelte` e `GenreDrillPage.svelte` continuam Legacy ate nova evidencia de renderizacao real.
- A reducao final de `--n-*` deve ocorrer somente depois dos consumidores ativos restantes e sem remocao automatica de aliases Legacy.

### Veredito
- Marco 21 tecnicamente aprovado para fechamento seletivo; o Marco 22 nao foi iniciado.

## Marco 22 - Browse Taste Insights

### Escopo executado
- Migrada exclusivamente a camada visual de `src/components/pages/TasteInsightsModal.svelte`.
- A superficie ativa foi confirmada por import e render direto em `BrowseV3.svelte`; o modal foi aberto pelo fluxo real `Browse > View full insights` com perfil e recomendacoes existentes.
- Nao foram alterados `BrowseV3.svelte`, logica de recomendacoes, calculos de afinidade, navegacao, stores, GraphQL, i18n, Sources, Home ou demais superficies.
- `TasteInsightsModal.svelte` nao possuia mudancas locais anteriores no preflight.

### Tokens e compatibilidade
- `--component-taste-insights-*`: 51 definidos em `tokens.css`, 51 implementados em `nocturne-theme.css`, 51 consumidos e 0 sem consumo.
- Categorias cobertas: backdrop/blur/z-index, surface, borders, radius, shadow, texto, accent/danger, cards, tracks, gauges, badges, metricas, rows, botoes, hover, focus, opacity e motion CSS.
- O componente nao consome mais `--n-*`, `--accent-bright` ou fallbacks de tema diretamente.
- Nenhum token Legacy ou camada `--n-*` foi removido.

### Valores diretos removidos e excecoes
- Removidos do componente: hex, rgba, gradients, blur, shadows, radius, z-index, opacity e transitions CSS diretos, incluindo quatro fallbacks de cor inline dos icones.
- Estado final: 0 cores/funcoes de cor, gradients, `--n-*` ou `var(--accent-*)` diretos no componente; propriedades visuais auditadas consomem tokens.
- Permanecem somente dois inline styles dinamicos de largura para afinidades e preferencias de formato. Eles representam dados runtime, nao identidade de tema.
- `transition:fly={{ y: 20, duration: 200 }}` permanece como excecao funcional Svelte: controla a animacao de montagem no runtime e nao e uma custom property CSS dependente de tema.

### Acessibilidade
- Textos auxiliares pequenos usavam alphas entre `0.38` e `0.55`, insuficientes sobre a surface superior do modal.
- `--component-taste-insights-muted-fg` foi ajustado para alpha `0.62`, com contraste automatizado acima de WCAG AA.
- Close e botoes de extensao receberam foco explicito via `--component-taste-insights-focus-ring`; validacao real por teclado mediu shadow `0 0 0 3px rgba(184, 167, 234, 0.18)`.
- O risco comportamental foi corrigido localmente: surface com `role="dialog"`, `aria-modal`, nome/descricao associados, foco inicial, ciclo Tab/Shift+Tab, fechamento por Escape, isolamento `inert` do fundo e restauracao do foco anterior.

### Screenshots reais
- `docs/screenshots/marco22-taste-insights/before-taste-insights-main.png`: baseline real Nocturne estabilizado apos o termino do `fade`, com dados reais de 634 entradas.
- `docs/screenshots/marco22-taste-insights/after-taste-insights-main.png`: mesma geometria e hierarquia apos a migracao, com contraste auxiliar corrigido.
- `docs/screenshots/marco22-taste-insights/after-taste-insights-hover.png`: lista inferior de extensoes com hover real do botao.
- `docs/screenshots/marco22-taste-insights/after-taste-insights-focus.png`: close button focado por teclado com ring visivel.
- A primeira tentativa before ocorreu durante o `fade` e foi sobrescrita. Para recapturar corretamente, somente o diff criado neste marco em `TasteInsightsModal.svelte` foi revertido temporariamente e reaplicado de forma identica; o componente estava limpo no preflight e nenhum trabalho do usuario foi revertido.

### Validacao visual e automatizada
- Computed style before/after permaneceu `980 x 736`, gradient, border `1px solid rgba(255, 255, 255, 0.08)`, radius `20px` e shadow equivalentes.
- Computed style final: 51 tokens encontrados e 0 valores vazios.
- Hover final do botao: background `rgba(156, 39, 176, 0.12)`, border `rgba(156, 39, 176, 0.35)`, foreground `rgb(243, 229, 245)` e radius `8px`.
- `npm exec vitest run -- --project shell-jsdom src/components/pages/TasteInsightsThemeTokens.test.ts src/components/pages/BrowseV3.test.ts`: reexecucao final passou, 2 arquivos e 17 testes. O stderr `Repository timeout` e esperado pelo teste de falha parcial de Sources.
- Teste comportamental adicional valida dialog semantics, foco inicial, ciclo bidirecional, Escape, `inert` e restauracao do foco; execucao focada passou com 5/5 testes.
- Validacao WebView2 real: close recebeu foco inicial, Tab no ultimo botao voltou ao close, Shift+Tab no close voltou ao ultimo botao, Escape desmontou o modal e restaurou foco em `View full insights`. A contagem de elementos inert passou de 1 baseline para 8 durante o modal e retornou a 1 depois do fechamento.
- `pnpm build`: passou com 6294 modulos transformados; permaneceu apenas o aviso conhecido de chunk maior que 500 kB.
- `git diff --check`: passou; apenas avisos informativos de conversao LF/CRLF no working tree.

### Riscos antes do proximo marco
- O risco de focus trap/inert e semantica de dialog do Taste Insights foi resolvido e coberto por teste automatizado e runtime real.
- `NovelSourceCheckModal.svelte` e `NovelSourceStatusDetails.svelte` formam o proximo lote ativo coeso recomendado.
- Superficies Legacy continuam sem migracao automatica e a reducao de `--n-*` permanece para o fechamento final.

### Veredito
- Marco 22 tecnicamente aprovado para fechamento seletivo; o marco seguinte nao foi iniciado.

## Marco 23 - Active Shell Compatibility Closure

### Preflight e ajuste de escopo
- O candidato anterior `NovelSourceCheckModal.svelte` e importado somente por `NovelRepositoriesPanel.svelte`; `NovelSourceStatusDetails.svelte` e importado somente por `NovelRepositoriesPanel.svelte` e `NovelSources.svelte`.
- `NovelRepositoriesPanel.svelte` e `NovelSources.svelte` nao participam da rota ativa atual. Os dois componentes de diagnostico foram portanto reclassificados como Legacy e nao foram migrados apenas por nome.
- A busca global identificou como consumidores ativos restantes de `--n-*` apenas `Layout.svelte` e `WindowControlsInline.svelte`.

### Escopo executado
- Migrada exclusivamente a compatibilidade visual ativa de `src/components/layout/Layout.svelte` e `src/components/layout/WindowControlsInline.svelte`.
- `WindowControlsInline` e renderizado por Home, BrowseV3, Downloads, Settings e LibraryHeader; `Layout` e o shell ativo do app.
- Nao foram alterados navegacao, lazy loading, keepalive, APIs de janela Tauri, comportamento de minimizar/maximizar/fechar ou qualquer superficie Legacy.

### Tokens e compatibilidade
- `--component-layout-main-*` e `--component-window-inline-*`: 8 definidos em `tokens.css`, 8 implementados em `nocturne-theme.css`, 8 consumidos e 0 sem consumo.
- Os tokens cobrem offset da sidebar, gap, tamanho, radius, motion, active transform, icon size e focus ring dos controles.
- `--n-sidebar-width` e `--n-hud-scale` permanecem somente dentro das definicoes de tokens Nocturne como aliases Legacy; nenhum token ou camada de compatibilidade foi removido.
- `Layout.svelte` e `WindowControlsInline.svelte` agora possuem 0 consumo direto de `--n-*`.

### Auditoria final dos consumidores
- A varredura global de componentes encontrou `--n-*` restante somente em `Discover.svelte` e `Extensions.svelte`.
- Ambos permanecem Legacy/fora da rota ativa, conforme Marcos 7, 11 e 20. Nao foram alterados ou removidos nesta etapa.
- Os componentes ativos do shell nao possuem cores diretas nem valores locais de radius, transition ou transform fora de tokens.

### Acessibilidade
- A validacao runtime encontrou foco invisivel preexistente nos controles de janela: outline com estilo `none` e box-shadow `none`.
- Foi aplicado `--component-window-inline-focus-ring` em `:focus-visible` sem alterar dimensoes ou comportamento.
- Resultado runtime por teclado: shadow `0 0 0 3px rgba(184, 167, 234, 0.18)` no botao Minimize.

### Screenshots reais
- `docs/screenshots/marco23-active-shell-compat/before-shell-main.png` e `after-shell-main.png`: shell real Home antes/depois.
- `docs/screenshots/marco23-active-shell-compat/before-window-controls.png` e `after-window-controls.png`: controles reais antes/depois.
- `docs/screenshots/marco23-active-shell-compat/after-window-controls-hover.png`: hover real do botao Minimize.
- `docs/screenshots/marco23-active-shell-compat/after-window-controls-focus.png`: foco por teclado com ring visivel.

### Validacao visual e automatizada
- Before/after preservou controles em `71.078 x 21.328px`, botoes `21.328px`, radius `8px`, foreground `rgba(239, 234, 255, 0.68)` e margem principal `67.5564px`.
- Computed style final: 8 tokens encontrados e 0 valores vazios.
- `npm exec vitest run -- --project shell-jsdom src/components/layout/ActiveShellCompatibilityThemeTokens.test.ts src/components/layout/layoutThemeComponents.test.ts`: passou, 2 arquivos e 8 testes.
- `pnpm build`: passou com 6294 modulos transformados; permaneceu apenas o aviso conhecido de chunk maior que 500 kB.
- `git diff --check`: passou; apenas avisos informativos de conversao LF/CRLF no working tree.

### Riscos restantes
- `Discover.svelte`, `Extensions.svelte`, `NovelSources.svelte`, `NovelSourceCheckModal.svelte`, `NovelSourceStatusDetails.svelte` e `NovelRepositoriesPanel.svelte` permanecem Legacy e nao devem ser removidos sem nova evidencia global/runtime.
- A camada `--n-*` ainda existe como contrato Legacy dentro dos temas/tokens. A proxima etapa segura e uma auditoria final de aliases e classificacao, nao remocao automatica.

### Veredito
- Marco 23 tecnicamente aprovado para fechamento seletivo; nenhum componente Legacy foi migrado ou removido.

## Marco 24 - Auditoria final de superficies Legacy e compatibilidade

### Objetivo e momento de execucao
- Iniciado depois do fechamento seletivo do Marco 23 no commit `93ee067`.
- Revalidar cada superficie e alias classificados como Legacy contra imports diretos/indiretos, rotas, lazy imports, flags, stores, presets, ThemeEditor, custom tokens, CSS compilado/computed style e aplicativo real.
- Este marco e de classificacao e evidencia. Nenhum componente, token ou alias deve ser removido automaticamente; qualquer limpeza posterior exige escopo e aceite separados.

### Preflight inicial e correcao de classificacao
- `src/main.ts` monta diretamente `App.svelte` e nao importa `src/routes.ts`. Assim, o mapa antigo que ainda importa `Extensions.svelte` permanece Legacy e nao comprova uma rota runtime ativa.
- O shell ativo continua limitado a Home, Library, Search/Explore, Downloads e Settings; `Layout.svelte` carrega `Search.svelte`, que renderiza `BrowseV3.svelte` para Search, Discover e Sources.
- A frase do Marco 23 sobre os consumidores globais restantes de `--n-*` deve ser lida como a varredura de `src/components`: o componente raiz ativo `App.svelte` ainda publica `--n-hud-scale` via `style.setProperty` e consome `--n-text-muted` no estado de carregamento.
- `--n-hud-scale` e portanto **Ativo por compatibilidade**, nao Legacy puro. Ele alimenta `nocturne-port.css`, aliases semanticos/de componente e CSS computado real; nao pode ser removido.
- `--n-text-muted` possui uma referencia ativa em `App.svelte`, mas nenhuma definicao global encontrada. Foi classificado como pendencia ativa de infraestrutura para correcao visual separada, sem alteracao neste preflight.
- A validacao em `http://localhost:1420` confirmou o shell e a navegacao principal reais. O backend MAIN em `127.0.0.1:4567` nao estava disponivel, portanto a validacao runtime completa das subtelas Legacy permanece pendente e nao foi substituida por dados artificiais.

### Inventario Legacy a revalidar

| Item | Classificacao atual | Evidencia atual | Validacao pendente | Pode remover agora? |
| --- | --- | --- | --- | --- |
| `Discover.svelte` | Legacy | A navegacao ativa de Discover/Search usa `Search.svelte` com `BrowseV3.svelte`; o componente antigo ainda referencia `SourceBrowse.svelte` e `--n-primary-container`. | Confirmar ausencia em rotas alternativas, imports dinamicos, flags e runtime real. | Nao |
| `Extensions.svelte` | Legacy | Ainda aparece em `routes.ts` e em mock de teste, mas o estado de navegacao ativo normaliza `extensions` para `search`; ainda consome `--n-hud-scale`. | Validar compatibilidade de rotas antigas, deep links, estado persistido e runtime de upgrade. | Nao |
| `routes.ts` | Legacy de navegacao | Importa `Extensions.svelte`, mas nao e importado por `main.ts`, `App.svelte` ou pelo shell ativo encontrado. | Confirmar empacotamento final, entradas alternativas e compatibilidade externa antes de classificar como morto. | Nao |
| `SourceBrowse.svelte` | Legacy | Consumido pela superficie Legacy `Discover.svelte`; nao foi comprovado como superficie ativa independente. | Buscar outros hosts, imports dinamicos e renderizacao condicional. | Nao |
| `SourceList.svelte` | Legacy | Associado aos fluxos antigos/compartilhados de Sources e Discover, sem evidencia runtime suficiente para classificar como morto. | Confirmar todos os hosts e estados de Sources no app real. | Nao |
| `NovelSources.svelte` | Legacy | Mantem testes e renderiza `NovelSourceStatusDetails.svelte`, mas nao participa da rota ativa validada. | Verificar rotas antigas, flags de novels, deep links e estados persistidos. | Nao |
| `NovelSourceCheckModal.svelte` | Legacy | Importado por `NovelRepositoriesPanel.svelte`, atualmente fora da superficie ativa de Settings. | Ativar apenas por fluxo real de repositorios e confirmar computed style/renderizacao. | Nao |
| `NovelSourceStatusDetails.svelte` | Legacy | Importado por `NovelRepositoriesPanel.svelte` e `NovelSources.svelte`, ambos sem renderizacao ativa comprovada. | Validar os dois hosts e estados de erro/status em runtime real. | Nao |
| `NovelRepositoriesPanel.svelte` | Legacy preparado | Migrado no Marco 18, mas nao aparece na superficie Settings ativa validada. | Confirmar feature flags, configuracao de backend e caminho real de ativacao. | Nao |
| `NovelsLibraryBody.svelte` | Legacy | Nao foi encontrado na cadeia de imports/renderizacao da Library ativa; pode representar compatibilidade de uma Library anterior. | Repetir busca global, lazy imports, modos/tabs, flags de novels e app real. | Nao |
| `Tracking.svelte` | Legacy | Nao houve evidencia runtime suficiente de renderizacao na navegacao ativa durante os marcos visuais. | Mapear hosts, rotas, integrações e estados que habilitam tracking. | Nao |
| `GenreDrillPage.svelte` | Legacy | Superficie especializada sem caminho runtime ativo comprovado na auditoria atual. | Verificar navegacao indireta a partir de Browse/Search e feature flags. | Nao |
| Camada `--n-*` | Mista: Ativa e Legacy | Permanece como contrato de temas, aliases, `nocturne-port.css` e custom themes. `App.svelte` publica `--n-hud-scale`; `Discover.svelte` e `Extensions.svelte` sao consumidores Legacy diretos. | Separar token a token entre Ativo e Legacy por CSS compilado/computed style, sem remocao automatica. | Nao |
| `--n-hud-scale` | Ativo por compatibilidade | Publicado dinamicamente por `App.svelte` e consumido por CSS/tokens reais, inclusive `nocturne-port.css`. | Mapear todos os aliases dependentes e manter o contrato durante a preparacao para novos temas. | Nao |
| `--n-text-muted` | Referencia invalida corrigida | Era consumido pelo estado `.page-loading` de `App.svelte`, mas nunca esteve definido. Foi substituido por `--component-app-loading-fg`. | Manter teste de contrato para impedir regressao. | Nao se aplica |
| `--n-sidebar-width`, `--n-topbar-height` | Ativos por compatibilidade | Alimentam `nocturne-port.css` e tokens semanticos/de componente presentes no CSS final. | Manter enquanto a camada port/token depender desses aliases. | Nao |
| Aliases `--activity-*` | Legacy de compatibilidade | Mantidos pela migracao do Marco 20 para preservar consumidores ou temas anteriores. | Buscar referencias globais, custom tokens, ThemeEditor e computed style. | Nao |

### Regras de classificacao do marco futuro
- **Ativo:** somente com evidencia de componente real renderizado e impacto observavel em CSS final/computed style.
- **Legacy:** manter sempre que existir compatibilidade, referencia dinamica, ThemeEditor, custom tokens, preset, store, template, rota antiga ou qualquer duvida.
- **Morto:** classificar apenas depois de provar ausencia global, dinamica, em temas/presets/stores/templates e no aplicativo rodando. Mesmo com essa prova, apenas documentar; nao remover nesse marco.

### Criterios de aceite
- Inventario global reconciliado com imports estaticos, `import()`, componentes condicionais, rotas, flags e estado persistido.
- Busca registrada por CSS Variables, `style.setProperty`, `setAttribute`, presets, ThemeEditor, custom tokens, stores e templates.
- Cada item acima classificado como Ativo, Legacy ou Morto com evidencia de arquivo/linha e resultado runtime.
- Superficies que se mostrarem ativas validadas visualmente em Nocturne com screenshots reais e computed styles.
- Nenhum token, alias, componente ou codigo legado removido durante a auditoria.
- Testes focados relevantes, `pnpm build` e `git diff --check` verdes.

### Risco registrado
- A ausencia de uma superficie na navegacao principal nao prova que ela esteja morta: deep links, migracao de estado, feature flags, backend configurado e temas customizados podem manter caminhos indiretos ativos.
- A porcao sem consumo da camada `--n-*` e os aliases `--activity-*` devem continuar classificados como Legacy; os demais tokens `--n-*` sao ativos por compatibilidade. Nenhuma remocao faz parte deste marco.

### Resultado consolidado da classificacao
- **Ativos:** 53 de 62 tokens `--n-*`. A evidencia inclui consumo em `nocturne-port.css`, tokens semanticos/de componente, CSS global e publicacao dinamica de `--n-hud-scale` por `App.svelte`.
- **Legacy:** 9 de 62 tokens `--n-*`, todos ainda definidos e sem consumidor estatico atual: `--n-bg`, `--n-bg-top`, `--n-line`, `--n-line-strong`, `--n-outline-variant`, `--n-popover-control-bg`, `--n-popover-control-border`, `--n-surface-container` e `--n-surface-container-low`.
- **Legacy:** 13 aliases `--activity-*`, definidos em `nocturne-theme.css` e sem consumidor estatico atual: `--activity-panel`, `--activity-panel-soft`, `--activity-line`, `--activity-line-soft`, `--activity-text`, `--activity-title`, `--activity-muted`, `--activity-subtle`, `--activity-faint`, `--activity-accent`, `--activity-accent-soft`, `--activity-accent-line` e `--activity-danger`.
- **Legacy de superficie/navegacao:** `routes.ts`, `Discover.svelte`, `Extensions.svelte`, `SourceBrowse.svelte`, `SourceList.svelte`, `NovelSources.svelte`, `NovelSourceCheckModal.svelte`, `NovelSourceStatusDetails.svelte`, `NovelRepositoriesPanel.svelte`, `NovelsLibraryBody.svelte`, `Tracking.svelte` e `GenreDrillPage.svelte`.
- `SourceBrowse.svelte` e hospedado somente por `Discover.svelte`; os dois componentes de diagnostico Novel sao hospedados somente por `NovelRepositoriesPanel.svelte`/`NovelSources.svelte`. Os demais candidatos sem host encontrado continuam Legacy por conservadorismo.
- **Mortos:** 0. A ausencia de import estatico ou consumo atual nao foi considerada prova suficiente diante de rotas antigas, temas customizados, estado persistido e configuracoes de backend.
- **Removidos:** 0 tokens, 0 aliases, 0 componentes e 0 arquivos Legacy.

### Correcao ativa executada
- Criado `--component-app-loading-fg` em `tokens.css` com origem semantica `--text-tertiary` e implementacao Nocturne equivalente.
- `.page-loading` em `App.svelte` passou a consumir o novo token; a referencia indefinida `--n-text-muted` foi eliminada.
- `--n-hud-scale` permaneceu intocado como publicador ativo de escala e passou a ser protegido explicitamente pelo teste de contrato.
- Contagem do novo contrato: 1 token definido, 1 implementado, 1 consumido e 0 sem consumo.

### Validacao visual e limitacoes
- O app web real foi executado em Nocturne em `http://127.0.0.1:1420`; o shell ativo e a navegacao principal foram confirmados.
- O backend MAIN em `127.0.0.1:4567` permaneceu indisponivel. Nenhum dado ou flag artificial foi criado para forcar as superficies Legacy.
- `.page-loading` foi transitorio demais para uma captura before/after confiavel. A tentativa diagnostica ja mostrava Home e foi removida; nenhuma screenshot enganosa foi mantida.
- A equivalencia visual da cor fica coberta pelo token semantico Nocturne e pelo contrato automatizado. Uma captura runtime do estado exato continua limitada ate ser possivel manter um lazy load visivel de forma natural.

### Testes e build
- `npm exec vitest run -- --project shell-jsdom --project unit src/AppThemeCompatibilityTokens.test.ts src/components/layout/ActiveShellCompatibilityThemeTokens.test.ts src/store/themeTokens.test.ts`: passou, 3 arquivos e 10 testes.
- O teste novo valida definicao/consumo do token de loading, preservacao de `--n-hud-scale`, isolamento das superficies Legacy e a lista completa dos 9 tokens `--n-*` e 13 aliases `--activity-*` Legacy.
- `pnpm build`: passou com 6294 modulos transformados; permaneceu apenas o aviso conhecido de chunk maior que 500 kB.

### Riscos remanescentes e veredito
- As superficies Legacy nao devem ser removidas ate validacao com backend/configuracoes que possam ativar rotas ou hosts indiretos.
- Os 22 aliases/tokens Legacy permanecem definidos para compatibilidade. Uma eventual remocao deve ser um marco separado, com validacao de ThemeEditor, temas importados e estado persistido.
- Marco 24 tecnicamente aprovado para fechamento seletivo, condicionado apenas a `git diff --check`; nenhum marco posterior foi iniciado.

## Marco 27 - Contrato canonico de temas

- Tipos, defaults, presets de motion, inventarios de chaves e metadados dos temas built-in foram centralizados em `src/lib/theme/contract.ts`.
- `state.svelte.ts` continua reexportando a API anterior para preservar todos os consumidores existentes; nenhuma API publica de componente ou store foi removida.
- `Settings.svelte` deixou de manter uma segunda lista local de temas e passou a consumir `BUILTIN_THEMES` do contrato central.
- Os valores de `DEFAULT_THEME_TOKENS`, `NOCTURNE_THEME_TOKENS`, HUD e motion foram preservados sem alteracao visual.
- Nenhum tema novo, token `--n-*`, alias Legacy ou componente foi adicionado/removido.
- O teste de contrato valida IDs unicos, inventarios completos de 47 tokens de tema e 15 tokens HUD, reexports do store e consumo do registro compartilhado em Settings.
- Como este marco apenas move ownership de dados TypeScript, nao ha screenshot before/after; a equivalencia visual permanece coberta pelo mesmo CSS e pelos gates de build/componentes.

## Marcos 28-30 - Consolidacao final de temas

### Preflight global

- Baseline de codigo: `8caa8a5` (`refactor(theme): centralize theme contract`).
- A varredura automatica encontrou 439 declaracoes de component tokens com cor direta no fallback de `tokens.css` e 1.124 em `nocturne-theme.css`; nenhuma quantidade foi assumida manualmente.
- As 1.563 declaracoes possuem 604 grafias de cor e 224 bases RGB distintas. Apenas 24 bases aparecem em tres ou mais grupos de componentes; somente essas bases sao candidatas a primitivas compartilhadas. Bases locais permanecem papeis semanticos do dominio.
- Distribuicao inicial por lote: 28A = 75 declaracoes/91 ocorrencias; 28B = 123/142; 28C.1 = 539/603; 28C.2 = 179/195; 28C.3 = 414/462; 28D.1 = 66/74; 28D.2 = 149/170.
- Os lotes 28C.1 e 28C.3 excedem o limite de 350 declaracoes e serao divididos automaticamente antes da edicao, sem ampliar o escopo funcional.
- Syncd, componentes Legacy e a camada `--n-*` permanecem fora da migracao. O inventario anterior de 53 aliases `--n-*` ativos, 9 Legacy e 13 aliases `--activity-*` Legacy continua valido.

### Baselines reais do preflight

- O app desktop real foi iniciado pelo launcher gerenciado, em Nocturne, com WebView2/CDP na porta 9223 e dados persistidos reais. Nenhuma fixture ou dado artificial foi criado.
- Capturas em `docs/screenshots/marco28-preflight/`: Home, Activity Center, Library Books/Comics, display popover, Browse normal/focus, Downloads, Settings, Book/Series/Novel Details e Book/Manga/Novel Readers.
- O backend MAIN em `127.0.0.1:4567` estava indisponivel. Superficies que dependem exclusivamente dele continuam limitadas aos estados persistidos disponiveis e aos testes focados.

### Marco 28A - Componentes base

#### Escopo e derivacao

- Prefixos migrados: `card`, `modal`, `popover`, `menu`, `button`, `input`, `tab`, `toast` e `nocturne-state`.
- Valores diretos removidos: 75 declaracoes e 91 ocorrencias, sendo 1 declaracao no fallback e 74 na implementacao Nocturne. Restam zero cores literais nesses prefixos.
- Foram adicionadas 2 primitivas absolutas compartilhadas (`--primitive-absolute-black` e `--primitive-absolute-white`) e 45 fontes semanticas para controles, popover, toast e estados. O teste percorre o grafo de referencias e confirma 47/47 fontes alcancaveis por component tokens migrados.
- `popover` e `menu` deixaram de depender diretamente de `--n-popover-*`; os aliases `--n-*` foram preservados sem remocao ou alteracao.
- Gradients, shadows e `color-mix()` dos component tokens mantiveram geometria, stops, alpha e ordem, mas suas cores agora partem de variables semanticas. `transparent` permanece a unica keyword de cor permitida.
- Nenhum componente Svelte, API, layout, animacao ou comportamento foi alterado.

#### Validacao visual

- Before: `docs/screenshots/marco28-preflight/before-library-display-popover.png`, `before-downloads.png`, `before-settings.png` e `before-home.png`.
- After: `docs/screenshots/marco28a-base/after-library-comics-display-popover.png`, `after-downloads-state.png`, `after-settings-controls.png`, `after-home.png`, `after-activity-center.png` e `after-toast-real.png`.
- A Library carregou capas e executou uma atualizacao real entre as capturas. Essa mudanca de dados explica as diferencas de conteudo; popover, toast, cards, bordas, sombras, tipografia e hierarquia permaneceram equivalentes.
- `Settings.browser.test.ts` reutilizou as seis baselines existentes e passou sem gerar `.actual.png`, fornecendo comparacao visual byte-exata para cards, inputs, buttons, tabs, hover/focus e estados de Settings cobertos.

#### Gates

- `pnpm test:unit -- src/lib/theme/componentColorDerivation.test.ts src/components/shared/baseThemeComponents.test.ts src/components/shared/NocturneStateThemeTokens.test.ts`: 3 arquivos, 9 testes, todos verdes.
- `pnpm test:browser -- src/components/settings/Settings.browser.test.ts`: 1 arquivo, 6 testes/browser screenshots, todos verdes.
- `pnpm build`: verde, 6.297 modulos; permanece apenas o aviso conhecido de chunk acima de 500 kB.
- `git diff --check`: verde para os arquivos do lote.

#### Riscos remanescentes

- Toasts de sucesso/erro/download nao ocorreram naturalmente nesta sessao; o toast real de progresso e os demais estados ficam cobertos pelo contrato de tokens e testes de render existentes.
- Os demais 1.488 component tokens com valores diretos pertencem aos lotes posteriores e continuam bloqueados pelo gate progressivo assim que cada prefixo for migrado.

### Marco 28B - Shell e Settings

#### Escopo e derivacao

- Prefixos migrados: `app`, `search`, `sidebar`, `topbar`, `nav`, `toolbar`, `window`, `settings` e `theme-editor`.
- Syncd permaneceu integralmente excluido; nenhum `--component-syncd-*`, componente ou teste Syncd foi alterado.
- Foram removidas 123 declaracoes e 142 ocorrencias de cor direta. Restam zero cores literais e zero aliases `--n-*` de cor nesses prefixos; `--n-hud-scale` permanece ativo apenas para geometria/escala Legacy.
- Foram adicionados 41 papeis semanticos para o background do app, shell, Search, navigation errors, toolbar, window controls e Settings. Nenhuma primitiva nova foi necessaria neste lote.
- `--n-gradient-bg`, `--n-primary`, `--n-on-surface`, `--n-on-primary` e equivalentes deixaram de ser dependencias diretas dos component tokens migrados. Os aliases continuam definidos e intocados para consumidores Legacy.
- O gradiente de app agora deriva de `--accent-bright`, `--color-app-background-top` e `--color-background`; Settings, shell e ThemeEditor consomem somente semantic/component tokens.

#### Regressao do dim da Search

- O teste de navegacao foi ampliado para abrir/limpar os cinco estados de Search (`home`, `library`, `browse`, `downloads`, `settings`) em ciclos sucessivos de navegacao.
- No app real, Home foi focado, Library foi aberta, Home foi focado novamente, o dim foi fechado e Browse foi focado. Em todas as repeticoes, a navegacao removeu a classe anterior e o dim voltou de `opacity: 1` para `0` ao fechar/trocar de pagina.
- Computed style real: dim global em `z-index: 500`, topbar em `520` e campo Search em `540`. A barra permaneceu acima do dim na primeira e na segunda abertura, inclusive depois da troca de pagina.

#### Validacao visual e browser

- Before: `docs/screenshots/marco28-preflight/before-home.png`, `before-browse-focus.png` e `before-settings.png`.
- After em `docs/screenshots/marco28b-shell-settings/`: `after-search-home-first-focus.png`, `after-search-library-cleared.png`, `after-search-home-second-focus.png`, `after-search-home-closed.png`, `after-search-browse-focus.png` e `after-settings.png`.
- A primeira execucao do matcher customizado por elemento produziu PNGs vazios ao serializar `color(srgb ...)`, embora o DOM e o screenshot completo estivessem corretos. `src/test/browser/setup.ts` passou a comparar o frame real e aceitar somente arredondamento de rasterizacao: delta maximo de 1 canal e ate 0,2% de pixels alterados.
- A comparacao diagnostica da tela General encontrou 0,1059% de pixels alterados, todos com delta maximo 1. Storage revelou um delta real no meter porque os alphas 0,86/0,94 haviam sido perdidos; os alphas foram restaurados antes do gate final.
- As cinco baselines browser de Settings passaram sem atualizacao. Nenhum `.actual.png` ou screenshot diagnostico foi preservado.

#### Gates

- Testes focados: `componentColorDerivation`, layout, Settings, ThemeEditor e navigation; 5 arquivos e 32 testes verdes.
- Browser: `Settings.browser.test.ts`; 1 arquivo e 6 testes verdes, incluindo as cinco baselines visuais.
- `pnpm build`: verde com 6.297 modulos; permanece apenas o aviso conhecido de chunk acima de 500 kB.
- Nenhum componente visual, API, store ou comportamento foi alterado; a unica mudanca fora de CSS/docs e o reforco dos testes de navegacao/screenshot.

### Marco 28C.1.1 - Details (primeiro lote)

#### Escopo e derivacao

- O prefixo `detail` possui 178 declaracoes de cor direta por arquivo. Para respeitar o limite de 350 declaracoes por commit, o lote foi dividido por ordem estavel dos tokens: esta primeira parte termina em `--component-detail-link-title-color`.
- Foram derivadas 111 declaracoes por arquivo, 222 no total, removendo 264 ocorrencias literais. Os 164 component tokens ate o limite do lote possuem zero cor direta; permanecem 67 declaracoes diretas por arquivo para o segundo lote.
- Foram adicionadas 16 fontes semanticas de `detail` para superficies de painel, controles, capitulos, hero, dropdown, danger e link modal. Todas sao consumidas transitivamente pelos component tokens migrados; nenhuma primitiva nova foi necessaria.
- Sombras, gradients, alphas e stops foram preservados. As cores agora partem de semantic variables e usam `color-mix()` apenas com `transparent`.
- `--component-detail-topbar-height` continua usando o alias Legacy geometrico `--n-topbar-height`; nenhuma camada `--n-*` foi removida ou alterada.

#### Validacao visual real

- Before: `docs/screenshots/marco28-preflight/before-book-detail.png`, `before-series-detail.png` e `before-novel-detail.png`.
- After: `docs/screenshots/marco28c1-detail-part1/after-book-detail.png`, `after-series-detail.png` e `after-novel-detail.png`.
- BookDetail e NovelDetail mantiveram a mesma obra e apresentam equivalencia aparente de geometria, superficies, bordas, contraste, tipografia, controles e hierarquia.
- A primeira obra de manga persistida mudou de `Osananajimi wo Erabenai!` para `The Greatest Estate Developer` entre as capturas. A diferenca e de dados; SeriesDetail manteve a mesma estrutura e os mesmos estados visuais. Nenhum dado foi fabricado ou alterado para forcar equivalencia de conteudo.
- O WebView2 ocasionalmente retornou um frame intermediario preto durante captura CDP. As capturas finais foram recapturadas em sequencia e validadas visualmente; nenhum frame diagnostico foi preservado.

#### Gates

- Testes focados: `componentColorDerivation.test.ts`, `DetailSurfacesThemeTokens.test.ts` e `SeriesDetailV3Shell.test.ts`; 3 arquivos e 9 testes verdes.
- `pnpm build`: verde com 6.297 modulos; permanece apenas o aviso conhecido de chunk acima de 500 kB.
- `git diff --check`: verde.
- Nenhum componente Svelte, layout, API, store ou comportamento foi alterado neste sublote.

### Marco 28C.1.2 - Details e Tracking (fechamento)

#### Escopo e derivacao

- O segundo sublote derivou as 67 declaracoes restantes de `detail` em cada CSS, as 85 de `tracking` em cada CSS e `manga` (1 fallback e 12 Nocturne): 317 declaracoes e 339 ocorrencias no total.
- Resultado global dos prefixos: `detail` 275/275 tokens sem cor direta, `tracking` 116/116 e `manga` 191/191, tanto no fallback quanto no Nocturne. Nao ha token sem consumo segundo os contratos de cada superficie.
- Foram adicionadas 12 fontes semanticas para controles/superficies profundas de Detail, track de progresso, gradiente primario, superficie/titulos de Tracking e status success/warning do MangaPreview. Todas sao alcancaveis transitivamente por component tokens ativos.
- A fonte de progresso de Detail e propria (`--color-detail-progress-track-source`), evitando dependencia semantica indevida de Settings. Tracking e MangaPreview tambem nao dependem de valores especificos do Nocturne.
- As unicas referencias `--n-*` nesses prefixos sao geometricas: `--n-hud-scale` e `--n-topbar-height`. Nenhum alias Legacy foi removido ou alterado.

#### Validacao visual real

- Baselines: Details em `docs/screenshots/marco28-preflight/`, Tracking em `docs/screenshots/marco17-detail-surfaces/` e MangaPreview em `docs/screenshots/marco15-manga-preview/`.
- After em `docs/screenshots/marco28c1-detail-part2/`: SeriesDetail list/grid, menu real de download, Tracking, MangaPreview principal, folder menu e link modal.
- SeriesDetail preservou geometria, hero, tags, progresso, controles, cards/list rows, dropdown, shadows, radius e hierarquia nos modos list/grid.
- Tracking abriu no estado real desconectado e preservou backdrop, blur, modal, tabs, close control e empty state. Estados MyAnimeList/AniList conectados nao estavam disponiveis e nao foram simulados.
- MangaPreview foi aberto apenas em memoria com a primeira obra real da Library; nenhum dado persistido foi criado. Modal, backdrop, folder menu e link modal mantiveram superficies, bordas, blur, sombras e hierarquia equivalentes.
- Com o backend MAIN indisponivel, folder menu e link modal permaneceram em loading. Success/error e resultados reais continuam cobertos pelos contratos de tokens, sem fixtures persistidas.

#### Gates

- Testes focados: `componentColorDerivation.test.ts`, `DetailSurfacesThemeTokens.test.ts`, `MangaPreviewThemeTokens.test.ts` e `SeriesDetailV3Shell.test.ts`; 4 arquivos e 13 testes verdes.
- A varredura progressiva confirma zero hex/rgb/rgba/hsl/hsla/oklch/keywords de cor e zero aliases `--n-*` de cor em `detail`, `tracking` e `manga`.
- `pnpm build`: verde com 6.297 modulos; permanece apenas o aviso conhecido de chunk acima de 500 kB.
- `git diff --check`: verde.
- Nenhum componente Svelte, layout, API, store, tracking provider ou comportamento foi alterado.

### Marco 28C.2 - Library e Dashboard

#### Escopo e derivacao

- Prefixos migrados: `library`, `home`, `activity` e `downloads`.
- O lote removeu 179 declaracoes e 195 ocorrencias de cor direta, todas antes concentradas nos overrides Nocturne. Restam zero literais nesses prefixos no fallback e no tema.
- Tambem foram removidas 24 dependencias Legacy de cor (`--n-on-surface`, `--n-primary*`, `--n-gradient-primary`, `--n-on-primary*`, `--n-on-surface-variant` e o alias inexistente `--n-error`). `--n-hud-scale` e `--n-topbar-height` permanecem apenas em geometria.
- Foram adicionadas 45 fontes semanticas: papeis compartilhados para texto/superficie profunda, tracks, status e gradient accent; papeis locais para Library, Activity Center e Downloads. Nenhuma primitiva nova foi necessaria.
- Search passou a compartilhar `--color-deep-neutral-surface-source`; o progresso de Detail, Home e Downloads converge em `--color-neutral-track-source`; MangaPreview reutiliza os status vivid. As relacoes preservam os valores Nocturne e removem acoplamentos entre componentes.
- `--component-downloads-danger-fg` agora resolve por `--color-danger`, corrigindo a referencia anterior a `--n-error`, que nunca foi definida.

#### Acessibilidade e testes de cor

- Os helpers WCAG de Home e Activity Center aceitavam apenas `rgb/rgba` literal e falharam corretamente ao encontrar a nova derivacao.
- Foi criado `src/test/themeColor.ts`, que resolve a cascata fallback -> Nocturne, aliases, hex/rgb, alpha, `color-mix()` e ciclos. Os mesmos pares e limites de contraste foram mantidos; nenhum threshold foi reduzido.
- O gate progressivo confirma zero cor literal e zero alias `--n-*` de cor em todos os component tokens dos quatro prefixos.

#### Validacao visual real

- Before: Home, Activity Center, Library Comics/Books, display popover e Downloads em `docs/screenshots/marco28-preflight/`.
- After em `docs/screenshots/marco28c2-library-dashboard/`: Home, Activity Center, Library Comics, Library Books, display popover, Downloads vazio, filtro e menu de acoes.
- Library manteve grid, capas, badges, filtros, densidade, progressos, popover, toggles e hierarquia. Home manteve cards de continuidade, atalhos, graficos e activity summaries.
- Activity Center abriu com notificacoes reais; surfaces, issue rows, tabs, count pills, danger state e tipografia permaneceram equivalentes.
- Downloads estava vazio no runtime real. Empty/loading, summary, filtro, acoes e disabled foram validados visualmente; estados active/paused/error continuam cobertos por `Downloads.test.ts`, sem dados artificiais.
- Dois frames CDP iniciais vieram com tiles pretos do WebView2. O popover da Library e o menu de Downloads foram recapturados isoladamente e somente os frames finais integros foram mantidos.

#### Gates

- Testes focados: 17 arquivos e 79 testes verdes, cobrindo contratos, render, teclado, Library browser-components, Home, Activity, Downloads e navigation.
- `pnpm build`: verde com 6.297 modulos; permanece apenas o aviso conhecido de chunk acima de 500 kB.
- `git diff --check`: verde.
- Nenhum componente Svelte, layout, API, store, fila de downloads ou comportamento foi alterado.

### Marco 28C.3a - Browse

#### Escopo e derivacao

- O lote `browse` foi separado de Sources/Taste para respeitar o limite: 138 declaracoes/156 ocorrencias no fallback e 140/158 no Nocturne, totalizando 278/314.
- Restam zero cores literais nos 443 component tokens `--component-browse-*` de ambos os CSS.
- Oito declaracoes de cor que ainda dependiam de `--n-primary`, `--n-on-primary` e `--n-gradient-primary` foram migradas para `--accent`, `--color-on-accent-strong` e `--gradient-accent-primary`.
- `--n-hud-scale`, `--n-topbar-height`, `--n-search-width` e `--n-search-width-focus` permanecem apenas para geometria responsiva Legacy.
- Foram adicionadas 3 fontes semanticas genericas para accent soft, superficie mais profunda e input profundo, mais 25 papeis locais de Browse para catalog, sidebar, search, insight cards, NSFW e controles. Todas sao alcancaveis por component tokens ativos.
- As fontes compartilhadas substituem duplicacoes anteriores de Detail e Library sem alterar seus valores Nocturne.

#### Validacao visual real

- Before: `docs/screenshots/marco28-preflight/before-browse.png`, `before-browse-focus.png` e baselines reais de `docs/screenshots/marco11-browsev3/`.
- After em `docs/screenshots/marco28c3a-browse/`: Search inicial, Search com resultados/foco, Discover real e dropdown de Language.
- O app foi reiniciado pelo launcher gerenciado apos o CDP anterior degradar o handshake. A nova sessao abriu em Nocturne com os mesmos dados persistidos.
- Search carregou recomendacoes reais, taste profile, rails, insights e diversity; Discover carregou 48+ resultados reais, sidebar, status segments, toggles, genre list e dropdown.
- Geometria, scroll containers, cards, surfaces, borders, shadows, contraste, active/hover/focus e hierarquia permaneceram equivalentes. Nenhum resultado ou estado foi fabricado.
- `Discover.svelte`, `Extensions.svelte`, `SourceBrowse.svelte` e `SourceList.svelte` Legacy nao foram ativados, removidos ou editados.

#### Gates

- Testes focados: `componentColorDerivation.test.ts`, `BrowseV3ThemeTokens.test.ts` e `BrowseV3.test.ts`; 3 arquivos e 16 testes verdes.
- `pnpm build`: verde com 6.297 modulos; permanece apenas o aviso conhecido de chunk acima de 500 kB.
- `git diff --check`: verde.
- Nenhum componente Svelte, API, store, GraphQL, busca, filtros ou navegacao foi alterado.

### Marco 28C.3b - Sources e Taste

#### Escopo e derivacao

- Prefixos migrados: `sources` e `taste`, com 98/106 e 38/42 declaracoes/ocorrencias respectivamente; total de 136 declaracoes e 148 ocorrencias, todas antes nos overrides Nocturne.
- Restam zero cores literais nos 133 tokens Sources e 51 tokens Taste de fallback e Nocturne.
- `--component-sources-control-hover-fg` deixou de usar `--n-primary`; `--component-taste-insights-fg` deixou de usar `--n-on-surface` com fallback literal. `--n-sidebar-width` permanece somente como geometria Legacy.
- Foram adicionadas 6 fontes genericas para scrims e superficies profundas/insights, 12 papeis locais de Sources e 7 de Taste. Browse e Shell passaram a referenciar os papeis genericos equivalentes sem alteracao visual.
- Warning, danger, repository rows, fields e status de Sources permanecem papeis semanticos do dominio. A paleta analitica positiva/negativa de Taste tambem permanece funcional, sem virar token global de marca.

#### Acessibilidade

- O teste WCAG de Taste aceitava apenas white `rgba` literal. Ele passou a usar `resolveCssColor`, mantendo o mesmo background, composicao alpha e minimo 4.5:1.
- O modal continua isolando o background, prendendo foco, fechando com Escape e restaurando o foco do disparador; esses comportamentos passaram no teste existente.

#### Validacao visual real

- Before: `docs/screenshots/marco7-sources/`, `docs/screenshots/marco22-taste-insights/` e Search do preflight.
- After em `docs/screenshots/marco28c3b-sources-taste/`: Sources com 10 extensoes reais, overlay Manage repositories com 5 feeds reais e Taste Insights calculado de 634 entradas da Library.
- Nenhuma extensao ou repository foi instalada/removida; o overlay foi apenas aberto e fechado.
- Sources preservou table, tabs, search, status badges, actions, repository overlay, backdrop, borders, shadows e hierarchy. Taste preservou modal, cards, charts, positive fills, badges, scroll e foco.
- `ExtensionSettingsPanel` nao estava exposto pelas extensoes instaladas nesta sessao e nao foi forçado; sua cobertura estatica permanece no contrato Sources/BrowseV3.

#### Gates

- Testes focados: `componentColorDerivation.test.ts`, `SourcesThemeTokens.test.ts`, `TasteInsightsThemeTokens.test.ts` e `BrowseV3.test.ts`; 4 arquivos e 21 testes verdes.
- `pnpm build`: verde com 6.297 modulos; permanece apenas o aviso conhecido de chunk acima de 500 kB.
- `git diff --check`: verde.
- Nenhum componente Svelte, API, store, extensao, repository ou comportamento foi alterado.

### Marco 28D.1 - Reader

#### Escopo e derivacao

- Prefixo migrado: `reader`, cobrindo os 50 tokens do HUD compartilhado e os 115 tokens do Reader Core usados por `Reader.svelte`, `BookReader.svelte` e `NovelReader.svelte`.
- O inventario corrigido possui 65 declaracoes e 73 ocorrencias de cor direta: 5/5 no fallback e 60/68 no Nocturne. A estimativa anterior 66/74 contava incorretamente `black` dentro do identificador `--font-weight-black`.
- Restam zero hex/rgb/rgba/hsl/hsla/oklch ou cores nomeadas nos component tokens `--component-reader-*`. Nenhum alias `--n-*` e usado pelo Reader migrado.
- Foram adicionadas 19 fontes semanticas para void/layers, paineis, texto, accent, focus, papel PDF, paleta prose e resume banner. Todas sao alcancaveis transitivamente pelos component tokens; nenhuma primitiva de cor nova foi necessaria.
- Sombras, alpha, gradients e stops foram preservados por `color-mix()` com fontes semanticas. `--font-weight-black` foi definido como token tipografico para resolver o alias que ja era consumido no fallback.
- Nenhum componente Svelte foi alterado. Paginacao, fullscreen, TTS, atalhos, adapters, progresso, GraphQL, cache e renderizacao permaneceram intactos.

#### Contratos e acessibilidade

- O detector progressivo passou a reconhecer `black`/`white` apenas como palavras CSS completas; identificadores como `--font-weight-black` e `--black-level` nao geram falso positivo, com casos positivos e negativos cobertos por teste.
- `ReaderHud.test.ts` agora exige o inventario completo 50/50 do HUD, confirma que os 29 overrides Nocturne sao todos consumidos e calcula contraste a partir dos tokens reais resolvidos pela cascata.
- `ReaderCoreThemeTokens.test.ts` valida referencias do fallback e do Nocturne em grafos de definicoes separados, impedindo que uma declaracao disponivel somente no tema mascare alias ausente no fallback.
- Os cinco foregrounds principais do HUD continuam acima de WCAG AA 4.5:1 sobre a superficie real do painel.

#### Validacao visual real

- Before: `docs/screenshots/marco28-preflight/before-book-reader.png`, `before-novel-reader.png` e `before-manga-reader.png`.
- After em `docs/screenshots/marco28d1-reader/`: BookReader EPUB, BookReader PDF reflow com settings, PDF canvas, NovelReader com HUD, manga MangaDex com 54 imagens reais carregadas e popover de brilho.
- EPUB e NovelReader mantiveram geometria, painel prose, tipografia, HUD, superficies, bordas, sombras e hierarquia visual aparentes. PDF foi validado tanto em reflow quanto no canvas nativo; o modo reflow foi restaurado ao final.
- O manga reader foi aberto com a obra MangaDex real `My Stepmother's Love isn't Going How I Thought!`; 54 imagens estavam carregadas e nenhuma fixture/dado artificial foi criado.
- A primeira tentativa apos o relaunch coincidiu com o bootstrap do perfil e gerou um frame preto/loading. Esses diagnosticos foram removidos; somente capturas finais estaveis foram mantidas.

#### Gates

- Testes focados: `componentColorDerivation.test.ts`, `ReaderCoreThemeTokens.test.ts`, `ReaderHud.test.ts`, `TtsControls.test.ts` e `tts.test.ts`; 5 arquivos e 30 testes verdes.
- `pnpm build`: verde com 6.297 modulos; permanece apenas o aviso conhecido de chunk acima de 500 kB.
- `git diff --check`: verde.
- Risco remanescente: nao existe teste browser automatizado do Reader; a cobertura visual continua dependendo do app Tauri real/CDP e do conteudo persistido disponivel.

### Marco 28D.2 - Superficies especializadas

#### Escopo e derivacao

- Prefixos migrados: `migration` (88 tokens), `migrate` (19), `updater` (49) e `novel` (98, sendo 9 do NovelMigrateModal e 89 do NovelRepositoriesPanel).
- Foram derivadas 149 declaracoes e 170 ocorrencias de cor direta: 30/31 no fallback e 119/139 no Nocturne. Restam zero cores literais nos 254 component tokens desses quatro prefixos em ambos os CSS.
- Foram adicionadas 45 fontes semanticas para Migration, Updater e superficies Novel. Todos os novos sources sao alcancaveis transitivamente pelos component tokens; nenhuma primitiva nova foi criada.
- Quatro dependencias invalidas/Legacy foram consolidadas: `--n-primary` passou a `--color-accent`; `--border` a `--color-border`; `--text` a `--text-primary`; e `--line-soft` a `--color-border` nos badges danger/warning de Novel Repositories.
- Sombras, gradients, alpha e geometria foram preservados. Nenhum componente Svelte, API, store, journal, updater runtime, instalacao, migration flow ou persistencia foi alterado.

#### Validacao visual real

- Baselines: Mass Migration em `docs/screenshots/marco8-mass-migration/`, migration modal em `docs/screenshots/marco12-migration-modals/` e Updater em `docs/screenshots/marco9-updater/`.
- After em `docs/screenshots/marco28d2-specialized/`: Mass Migration com MangaDex e 29 titulos reais, MigrateModal de `The Greatest Estate Developer` com fontes instaladas reais e Updater/About com Suwayomi `v2.1.1867 - managed-bundled` no estado `Up to date`.
- Mass Migration e MigrateModal preservaram modal/backdrop, blur, surfaces, dividers, steps, source rows, borders, focus, buttons e hierarquia. Nenhuma busca de matches ou migracao foi executada.
- O painel de releases do Updater retornou `GitHub API returned 404 Not Found` no runtime real; trata-se de estado externo de dados. A geometria, status card, pill `Up to date`, surfaces, borders e hierarquia permaneceram equivalentes.
- `NovelMigrateModal` continua bloqueado pelo cohort de seguranca no runtime real e nao foi forcado. `NovelRepositoriesPanel` permanece Legacy preparado, sem host ativo em Settings. Ambos foram validados por contrato/render jsdom, sem fixtures persistidas.

#### Acessibilidade e riscos

- Focus visivel, teclado e render dos modais/painel continuam cobertos pelos testes existentes; as capturas reais confirmam foco visivel no close control do Mass Migration.
- Os contrastes alpha-aware historicamente limítrofes foram preservados neste lote: Migration eyebrow ~3.38:1 e muted ~4.37:1; NovelRepositories Legacy field ~2.31:1, muted ~2.88:1 e badge muted ~4.15:1. O ajuste pertence ao gate WCAG do Marco 28E para evitar misturar derivacao pixel-equivalente com correcao visual.
- O focus trap/inert de Mass Migration e a semantica modal/focus trap incompleta de `MigrateModal`/`NovelMigrateModal` continuam registrados como riscos funcionais separados e nao foram alterados.

#### Gates

- Testes focados: gate progressivo, Mass Migration, migration modals, MigrateModal, Browse/Sources host, Updater e Novel Repositories; 9 arquivos e 42 testes verdes. O stderr `Repository timeout` e esperado pelo caso de falha parcial de update-all.
- `pnpm build`: verde com 6.297 modulos; permanece apenas o aviso conhecido de chunk acima de 500 kB.
- `git diff --check`: verde.

### Marco 28E - Gate global de derivacao

#### Contrato global

- O gate terminal varre dinamicamente todos os `--component-*`, sem depender da lista incremental de prefixos. Resultado: zero cor literal no fallback e zero em todos os component tokens Nocturne fora da allowlist explicita `--component-syncd-*`.
- Syncd permanece fora do plano por decisao de escopo: seus 18 tokens Nocturne com 19 ocorrencias diretas nao foram alterados nem reclassificados.
- Gradients, shadows e `color-mix()` dos componentes ativos usam somente variables semanticas/componentes e `transparent`; nenhuma excecao de branding/asset foi necessaria em component tokens.
- O gate de aliases agora valida fallback e Nocturne separadamente. Ele encontrou e corrigiu `--radius-xs`, `--color-toast-surface-hover-source` e os fallbacks geometricos ativos `--n-hud-scale`, `--n-topbar-height`, `--n-search-width` e `--n-search-width-focus`, antes disponiveis apenas sob Nocturne.
- Os aliases geometricos `--n-*` foram preservados e ganharam apenas defaults theme-neutral; nenhuma compatibilidade foi removida.

#### Theme probe e compatibilidade

- Foi criado `src/test/themeProbe.ts`, paleta sintetica oposta ao Nocturne e disponivel somente para testes. Ela implementa os 47 `ThemeTokens` e 15 `HudThemeTokens`, sem criar tema builtin ou opcao de UI.
- O teste Chromium aplica cada token individualmente via `style.setProperty` e confirma por computed style que 13 superficies representativas (base, shell, Settings, Detail, Home, Activity, Downloads, Library, Browse, Sources, Reader, Migration e Updater) ficam resolvidas, nao transparentes e diferentes do Nocturne.
- O inventario permanece: 62 aliases `--n-*`, sendo 53 Ativos por compatibilidade e 9 Legacy; 13 aliases `--activity-*` Legacy. Todos continuam definidos e nenhum ganhou consumidor novo.

#### WCAG AA

- O gate alpha-aware compoe foreground, surface e canvas reais e valida 11 pares em Nocturne e no theme probe, sempre com minimo 4.5:1.
- Foram corrigidos somente os cinco papeis comprovadamente abaixo do minimo: Migration eyebrow/muted e NovelRepositories Legacy field/muted/badge-muted. Eles agora usam `--text-tertiary` (alpha Nocturne 0.62), preservando a identidade e elevando o contraste para aproximadamente 4.5:1 ou mais.
- Percentuais binarios espurios produzidos pela derivacao mecanica (`56.00000000000001%`, por exemplo) foram normalizados sem alterar os valores visuais.

#### Validacao visual real

- Comparacao final contra `docs/screenshots/marco28-preflight/` e os after de 28A-28D nao mostrou regressao aparente de layout, superficies, bordas, sombras, blur, radius, tipografia ou hierarquia.
- Capturas finais em `docs/screenshots/marco28e-gate/`: Library Books, Browse/Search, Settings General e NovelReader real.
- A recaptura do MigrateModal apos o ajuste WCAG encontrou o estado conhecido de tiles pretos do WebView2 em cinco tentativas identicas; todos os frames diagnosticos foram removidos. A captura integra do Marco 28D.2 permanece valida para geometria, e os foregrounds alterados sao cobertos pelo teste de contraste computado.

#### Gates

- Testes unitarios: `themeGate.test.ts`, `componentColorDerivation.test.ts`, `AppThemeCompatibilityTokens.test.ts` e `contract.test.ts`; 4 arquivos e 29 testes verdes.
- Teste browser Chromium: `themeProbe.browser.test.ts`; 1 arquivo e 1 teste verde.
- `pnpm build`: verde com 6.297 modulos; permanece apenas o aviso conhecido de chunk acima de 500 kB.
- `git diff --check`: verde.

### Marco 29 - ThemeEditor V4

#### Contrato de autoria

- O contrato persistido passou a aceitar `ThemeDocumentV4`: `version: 4`, id `custom:*`, nome, tema builtin base, primitive overrides, semantic overrides opcionais, HUD parcial e preset de motion.
- Os 22 primitive keys e 25 semantic keys formam uma particao exata dos 47 `ThemeTokens`. `--component-*` nao faz parte do documento, nao e editavel e e rejeitado tanto como chave quanto como referencia.
- Documentos v1, v2 e v3 continuam armazenados sem alteracao. O runtime e o editor os migram somente em memoria, usam Nocturne como base historica e removem valores iguais ao base; o item persistido so vira V4 durante um save explicito.
- Import e autoria rejeitam chaves desconhecidas, regras CSS, `url()`, comentarios, caracteres de injecao, expressoes, valores que nao sejam cores, variables desconhecidas, ciclos e unidades HUD invalidas.
- Parse, import, serialize, round-trip, materializacao do contrato e criacao sparse estao centralizados em `src/lib/theme/document.ts`.

#### Aplicacao e persistencia

- O antigo `<style id="aethon-custom-theme">` construido por concatenacao foi removido. O provider aplica exclusivamente os 47 ThemeTokens, 15 HudThemeTokens, 3 motion vars e o alias de sidebar via `style.setProperty`; a troca para builtin remove a mesma allowlist via `removeProperty`.
- O `data-theme` permanece no builtin base do documento, preservando toda a camada de component tokens derivada daquele tema. `data-custom-theme` registra apenas o documento ativo; nenhum componente depende dele.
- O ThemeEditor continua sendo a interface oficial. A aba Colors mantem primitives e o grupo avancado Semantic; HUD mantem presets, geometria, cores e motion. Preview e swatches tambem passaram a usar `setProperty`, sem CSS gerado como string.
- O save persiste o V4 completo antes de trocar o estado em memoria e antes de ativa-lo. Se `localStorage` falhar, o documento antigo e a selecao anterior permanecem intactos e o editor mostra erro em vez de `Saved`.
- Export sempre produz V4 sparse. Import aceita V1-V4, valida/migra em memoria e nao grava nem ativa ate o usuario salvar.

#### Validacao visual real

- Before: baseline real `docs/screenshots/marco14-theme-editor/theme-editor-before-existing-baseline.png` e capturas Colors/HUD do mesmo marco.
- After: `docs/screenshots/marco29-theme-editor/theme-editor-after-colors.png` e `theme-editor-after-hud-motion.png`, capturadas no app Tauri real em Nocturne.
- Colors, Semantic list, preview, swatches, HUD presets, motion, sliders, foco, backdrop, shell, tipografia, spacing e hierarquia permaneceram visualmente equivalentes. O runtime confirmou `data-theme="nocturne"`, ausencia do style tag legado e preview resolvido com `--accent: #d3c4ff`.
- Nenhum tema foi salvo durante o smoke real para nao modificar os dados do usuario. Import/export, falha de persistencia e ativacao customizada ficaram cobertos por testes puros/provider; o seletor nativo de arquivos nao foi automatizado.

#### Gates

- Testes focados: contrato, V1/V2/V3 -> V4, round-trip, import invalido, injecao, ciclos, HUD, provider, persistencia, ThemeEditor e Settings; 6 arquivos e 52 testes verdes.
- Teste browser Chromium: `themeProbe.browser.test.ts`; 1 arquivo e 1 teste verde apos a troca do provider.
- `pnpm build`: verde com 6.299 modulos; permanece apenas o aviso conhecido de chunk acima de 500 kB.
- `git diff --check`: verde.
- Syncd, `--n-*`, component tokens, layout, i18n e logica funcional fora do tema permaneceram intocados.

### Marco 30 - Gate de autoria

#### Contrato final

- `authoringGate.test.ts` materializa o theme probe como V4, exige round-trip identico, resolucao dos 47 ThemeTokens e 15 HudThemeTokens, e zero `component-*` no documento serializado.
- O mesmo gate repete a garantia de migracao imutavel de V1/V2/V3, confirma que runtime e preview usam apenas CSSOM allowlisted e transforma `docs/theme-authoring.md` em parte testada do contrato.
- `themeGate.test.ts` permanece o gate de WCAG AA para 11 pares em Nocturne e no theme probe, alem de preservar 53 aliases `--n-*` Ativos, 9 Legacy e 13 aliases `--activity-*` Legacy.
- O fluxo oficial documentado e `ThemeEditor -> export -> validation -> promotion`. Um futuro tema exige documento V4, metadados e evidencia visual; nenhuma folha CSS de componente deve ser criada.

#### Browser e validacao visual real

- Browser Chromium: Theme probe (1), LibraryCardGrid (7) e Settings (6), total de 14 testes verdes.
- O baseline `settings-advanced-about.png` estava 0,1605% atras do estado tokenizado atual apenas no pill `Failed` do Updater. Baseline e actual foram inspecionados: geometria, texto e hierarquia eram identicos; somente o danger border/background atual diferia. O baseline foi consolidado e a suite passou 6/6 na repeticao.
- Capturas reais finais em `docs/screenshots/marco30-authoring/`: Library Books, Browse com 83 recomendacoes reais, Settings Appearance, BookReader PDF, ThemeEditor modal, Display popover e toast persistente do refresh real da Library.
- O refresh usado para o toast foi interrompido pela propria acao `Stop` apos a captura e o runtime drenou os trabalhos ja iniciados. Nenhuma fixture, tema ou dado artificial foi criado.
- A comparacao com o preflight e os after dos Marcos 28-29 nao mostrou regressao aparente em layout, superficies, borders, shadows, blur, radius, tipografia, foco ou hierarquia.

#### Gates finais

- Gate unitario: 7 arquivos e 63 testes verdes.
- Gate browser: 3 arquivos e 14 testes verdes nas execucoes finais.
- `pnpm build`: verde com 6.299 modulos; permanece apenas o aviso conhecido de chunk acima de 500 kB.
- `git diff --check`: verde.
- Artefatos `.actual` e screenshots diagnosticos do runner foram removidos; somente o baseline valido e as sete evidencias reais finais permanecem.

## Marco 31 - Legacy Surface Proof/Quarantine

### Escopo

- Marco de evidencia, sem alteracao visual, sem remocao de codigo e sem criacao de tema novo.
- Revalidar as superficies classificadas como Legacy apos o Marco 30 contra imports ativos, shell real, rotas antigas, aliases de navegacao, hosts de diagnostico e contratos de teste.
- Syncd permaneceu fora do escopo por decisao de produto. Ele e ativo em Settings, mas a validacao visual com sessao persistida real continua como trabalho futuro separado.

### Evidencias de rota ativa

- `src/main.ts` monta diretamente `App.svelte` e nao importa `src/routes.ts`.
- `Layout.svelte` carrega somente `Home.svelte`, `Library.svelte`, `Search.svelte`, `Downloads.svelte` e `Settings.svelte` como paginas principais.
- `Search.svelte` renderiza `BrowseV3.svelte`; a superficie antiga `Discover.svelte` nao participa desse caminho.
- `state.svelte.ts` normaliza navs persistidas antigas `explore`, `extensions` e `sources` para `search`, mantendo compatibilidade sem reativar `Extensions.svelte`.

### Inventario de quarentena

| Superficie | Classificacao | Evidencia atual | Decisao |
| --- | --- | --- | --- |
| `Discover.svelte` | Legacy | Hospeda `SourceBrowse.svelte`, mas a rota ativa de Search usa `BrowseV3.svelte`. | Manter. Nao migrar/remover sem prova de deep link ou reativacao. |
| `Extensions.svelte` | Legacy de rota antiga | Importado por `routes.ts`; `main.ts` nao usa `routes.ts` e nav antiga `extensions` normaliza para `search`. | Manter como compatibilidade ate auditoria de entrypoints/deep links. |
| `SourceBrowse.svelte` | Legacy acoplado | Host estatico encontrado em `Discover.svelte`. | Manter junto da decisao sobre `Discover.svelte`. |
| `SourceList.svelte` | Legacy incerto | Sem host ativo comprovado; ainda mantido por conservadorismo. | Nao classificar como morto sem validacao runtime/deep links. |
| `NovelSources.svelte` | Legacy preparado | Possui testes e renderiza `NovelSourceStatusDetails.svelte`, mas nao aparece no shell ativo. | Manter ate existir rota/flag real. |
| `NovelSourceCheckModal.svelte` | Legacy acoplado | Host em `NovelRepositoriesPanel.svelte`. | Manter junto da decisao sobre Novel Repositories. |
| `NovelSourceStatusDetails.svelte` | Legacy acoplado | Host em `NovelRepositoriesPanel.svelte` e `NovelSources.svelte`. | Manter junto dos hosts. |
| `NovelRepositoriesPanel.svelte` | Legacy preparado | Migrado no Marco 18; `Settings.svelte` ativo nao o importa. | Manter, sem remover nem reanexar automaticamente. |
| `NovelsLibraryBody.svelte` | Legacy | Library ativa usa `LibraryShell` e corpos atuais, nao este componente antigo. | Manter ate fechar ownership de novels na Library. |
| `Tracking.svelte` | Legacy | Tracking ativo acontece pelos paineis `TrackingPanel`/`NovelTrackingPanel`; pagina antiga sem rota ativa comprovada. | Manter ate auditoria de integrações/rotas. |
| `GenreDrillPage.svelte` | Legacy | Sem caminho ativo comprovado no shell atual. | Manter ate auditoria de navegacao indireta a partir de Browse/Search. |
| `routes.ts` | Legacy de navegacao | Continua importando `Extensions.svelte`, mas nao e usado pelo entrypoint atual. | Manter ate prova de ausencia em entrypoints externos. |

### Tokens e compatibilidade

- Nenhum token Legacy foi removido.
- A camada `--n-*` permanece mista: 53 aliases Ativos por compatibilidade e 9 Legacy documentados no Marco 24/28E.
- Os 13 aliases `--activity-*` continuam Legacy de compatibilidade.
- `nocturne-port.css` segue como camada port/compat com valores diretos historicos. O gate final de component tokens continua exigindo zero cor literal em `--component-*` ativos, salvo allowlist documentada.

### Testes

- `AppThemeCompatibilityTokens.test.ts` foi reforcado para:
  - preservar `--n-hud-scale` como publicador ativo de compatibilidade;
  - garantir que superficies Legacy auditadas nao entrem no shell ativo;
  - garantir que aliases de navegacao antigos continuam normalizados para `search`;
  - registrar explicitamente hosts Legacy acoplados (`Discover -> SourceBrowse`, `NovelRepositoriesPanel -> NovelSourceCheckModal/NovelSourceStatusDetails`, `NovelSources -> NovelSourceStatusDetails`);
  - manter `NovelRepositoriesPanel` fora de `Settings.svelte` ativo.

### Validacao

- Marco sem mudancas visuais. Screenshots reais nao foram recapturadas porque nenhum componente visual, token, layout, superficie ou tema foi alterado.
- Teste focado: `pnpm test:unit -- src/AppThemeCompatibilityTokens.test.ts`; 1 arquivo e 6 testes verdes.
- `pnpm build`: verde com 6.299 modulos; permanece apenas o aviso conhecido de chunk acima de 500 kB.
- `git diff --check`: verde, com avisos esperados de normalizacao LF/CRLF no Windows.

### Riscos restantes

- Nenhuma superficie da quarentena deve ser removida ate haver prova de ausencia em deep links, estado persistido, entrypoints alternativos, flags e runtime real com backend disponivel.
- Se alguma superficie Legacy for reativada, ela deve virar um marco proprio de migracao ou reanexacao, com screenshots reais antes/depois.
- Syncd continua fora deste plano e deve receber validacao propria somente quando houver sessao persistida real disponivel.

## Marco 32 - Legacy Runtime Entrypoint Audit

### Escopo

- Marco exclusivamente de evidencia e contrato: nenhum componente, token, tema, layout, comportamento ou codigo Legacy foi alterado/removido.
- Foram auditados o bootstrap web/Tauri, o grafo de imports, navegacao persistida, argumentos internos de auditoria, WebViews auxiliares, callbacks OAuth, protocolos de assets e o bundle de producao.
- Syncd permaneceu fora do escopo.

### Bootstrap e navegacao ativos

- O caminho de bootstrap comprovado e `src-tauri/src/main.rs -> aethon_lib::run() -> index.html -> src/main.ts -> App.svelte -> Layout.svelte`.
- `Layout.svelte` continua sendo o router efetivo do shell, com `home`, `library`, `search`, `downloads` e `settings`; detalhes e readers sao carregados pelos loaders ativos de `Layout.svelte`/`App.svelte`.
- A navegacao inicial vem do estado persistido normalizado. Os aliases `explore`, `extensions` e `sources` convergem para `search`; pathname, hash e History API nao alimentam `NavPage`.
- O argumento interno `--audit-open=` aceita somente `library`, `manga`, `reader`, `books`, `book`, `book-reader`, `settings` e `settings-security`. Nenhum alvo Legacy pode ser aberto por esse caminho.

### Entry points externos e auxiliares

- Nao existe dependencia/configuracao Tauri para deep link ou single instance, protocolo externo de navegacao registrado, listener `RunEvent::Opened`, `onOpenUrl` ou handler equivalente no frontend.
- As WebViews externas de reader e tracker OAuth nao importam o shell nem o mapa de rotas: a primeira navega apenas no host permitido e a segunda intercepta o callback e publica um evento interno.
- Os protocolos `book:` e `cover:` servem assets locais para a WebView e nao sao entrypoints de navegacao do app.
- A janela auxiliar de novels usa URL/query interna e um label proprio para montar somente `NovelRuntimeHost`; ela nao consome `src/routes.ts`.

### Grafo Legacy e bundle

- O teste agora calcula os importadores de todas as superficies em quarentena. O unico importador de `Extensions.svelte` e `src/routes.ts`; `SourceBrowse.svelte` pertence apenas a `Discover.svelte`; os dois diagnosticos Novel pertencem somente aos hosts Legacy ja documentados.
- `Discover.svelte`, `SourceList.svelte`, `NovelSources.svelte`, `NovelRepositoriesPanel.svelte`, `NovelsLibraryBody.svelte`, `Tracking.svelte` e `GenreDrillPage.svelte` seguem sem importador de producao ativo.
- `src/routes.ts` nao tem importador em nenhum entrypoint web/Tauri. Ele ainda referencia `History.svelte` e `Explore.svelte`, arquivos que nao existem; portanto, o modulo tambem nao resolveria caso fosse reativado sem migracao explicita.
- O build de producao nao emitiu chunks com os nomes das superficies Legacy auditadas, incluindo `Discover`, `Extensions`, `SourceBrowse`, `SourceList`, `NovelSources`, `NovelRepositoriesPanel`, `Tracking`, `GenreDrillPage`, `History` e `Explore`.

### Classificacao e decisao

- As superficies permanecem **Legacy**, nao Mortas. A ausencia foi comprovada para o repositorio e bundle atuais, mas nenhum arquivo ou token foi removido nesta etapa.
- Qualquer novo importador, target de auditoria ou suporte a deep link que referencie uma superficie em quarentena faz o contrato falhar e exige um marco explicito de reativacao/migracao.
- `routes.ts` permanece preservado como evidencia historica ate uma etapa futura autorizar limpeza de codigo Legacy.

### Validacao

- `pnpm test:unit -- src/AppThemeCompatibilityTokens.test.ts`: 1 arquivo e 9 testes verdes.
- `pnpm build`: verde com 6.299 modulos; permanece apenas o aviso conhecido de chunk acima de 500 kB.
- Inspecao dos chunks de `dist/assets`: zero chunk das superficies Legacy auditadas.
- `git diff --check`: verde, com avisos esperados de normalizacao LF/CRLF no Windows.
- Nenhuma screenshot foi recapturada porque o marco nao altera superficie visual, CSS ou runtime.

### Riscos restantes

- Entry points mantidos fora deste repositorio (atalhos antigos ou builds instalados anteriores) nao podem ser provados por analise do source atual; o build produzido neste marco, contudo, nao empacota as superficies em quarentena.
- A classificacao Legacy continua conservadora. Remocao futura exige marco proprio, busca global repetida e validacao de upgrade antes de excluir arquivos ou aliases.
- `nocturne-port.css`, os 53 aliases `--n-*` Ativos, 9 `--n-*` Legacy e 13 `--activity-*` Legacy permanecem intocados e devem ser tratados em auditoria separada.

## Marco 33 - Nocturne Port Compatibility Inventory

### Escopo e cascata

- Marco de inventario/contrato, sem alteracao em CSS de producao, componentes, tokens, layout ou comportamento.
- `global.css` importa, nesta ordem, `tokens.css`, `nocturne-theme.css`, `animations.css` e por ultimo `nocturne-port.css`. Portanto, o port participa da cascata final e pode sobrescrever os niveis anteriores.
- Ele e o ultimo import, nao a ultima regra absoluta: declaracoes posteriores de `global.css` e estilos scoped dos chunks Svelte ainda participam da especificidade. Nao existe `@layer` para explicitar essa precedencia.
- O arquivo possui 3.803 linhas e quatro blocos visualmente ativos: Splash, shell/base, Settings e metric/rating banners.
- Os hosts reais foram confirmados em `SplashScreen.svelte`, `App.svelte`/`Layout.svelte`, `Settings.svelte`, `LibraryCard.svelte` e `BrowseV3.svelte`.

### Classificacao dos tokens locais

- Foram encontradas 59 declaracoes correspondentes a 46 custom properties unicas.
- **Ativos (43):** os aliases semanticos/Settings comprovados, tokens geometricos locais, `--splash-ink`, `--splash-ink-soft` e `--state-accent` possuem consumidor de producao e resolvem no contexto dos hosts ativos.
- **Legacy (3):** `--splash-error` e `--splash-ink-muted` permanecem sem referencia comprovada; `--color-info-bg` participa apenas do ciclo fallback `--color-info-bg -> --component-settings-info-bg -> --color-info-bg`, quebrado hoje pelo override Nocturne, mas nao seguro para temas futuros.
- **Mortos (0):** nenhum token foi classificado como Morto e nenhum token foi removido. Os tres casos duvidosos permanecem Legacy por conservadorismo.
- O port referencia exatamente 41 aliases `--n-*`; a lista completa e fixa no contrato `nocturnePortCompatibility.test.ts`. A validacao de hosts mostrou que 6 dessas referencias pertencem somente a seletores Legacy sem host ativo (`.n-btn-secondary` e toolbar cluster/divider).
- O inventario global corrigido e **45 Ativos / 17 Legacy** entre os 62 aliases `--n-*`. Dos 17 Legacy, 11 nao possuem referencia e 6 aparecem somente nos seletores Legacy citados. O inventario anterior 53/9 contava referencia textual como atividade visual.

### Valores visuais diretos

- O port contem 189 ocorrencias de cor direta sob o detector global (`hex`, `rgb/rgba`, `hsl/hsla`, `oklch`, `color-mix`, `white` e `black`), incluindo ramos ativos e seletores Legacy preservados.
- Distribuicao: Splash 61, shell/base 58, Settings 49 e metric/rating banners 21.
- Essas ocorrencias nao sao uma nova allowlist permanente. Elas foram classificadas como divida ativa da camada port e devem ser derivadas para primitive/semantic/component tokens antes de considerar a infraestrutura integralmente portavel entre temas.
- O teste usa tetos regressivos por secao (61/58/49/21 e 189 total): reducoes sao aceitas; qualquer aumento falha.

### Computed style e validacao

- O teste Chromium monta os mesmos hosts/classes reais e confirma que Splash, Sidebar, Settings card e metric pill recebem pintura resolvida da cascata final.
- O teste tambem confirma que `--splash-ink` e `--settings-card-radius` aparecem em computed style, distinguindo tokens ativos de declaracoes apenas textuais.
- Teste unitario: `pnpm test:unit -- src/lib/theme/nocturnePortCompatibility.test.ts`; 1 arquivo e 5 testes verdes.
- Teste browser: `pnpm test:browser -- src/lib/theme/nocturnePortCompatibility.browser.test.ts`; 1 arquivo e 1 teste verde.
- `pnpm build`: verde com 6.299 modulos; permanece apenas o aviso conhecido de chunk acima de 500 kB.
- `git diff --check`: verde, com avisos esperados de normalizacao LF/CRLF no Windows.
- Nenhuma screenshot foi recapturada porque este marco nao altera CSS nem superficie visual.

### Proximo lote recomendado

- Marco 34: derivar as 189 ocorrencias ativas de `nocturne-port.css` para primitive/semantic/component tokens, mantendo o arquivo e a camada `--n-*`.
- O lote pode permanecer unico porque ha 189 ocorrencias, abaixo do limite de 350 declaracoes. Se o diff ultrapassar 900 linhas, deve ser dividido automaticamente por bloco visual sem ampliar escopo.
- Gates visuais obrigatorios do Marco 34: Splash, Sidebar/Topbar/Search dim, Settings, Library metric banner e Browse recommendation rating, todos before/after em Nocturne.

### Riscos restantes

- Apesar do gate global dos component tokens estar verde, a existencia dessas 189 ocorrencias na ultima folha da cascata impede afirmar que qualquer tema futuro depende somente do documento V4 em todas as superficies.
- O port nao e envolvido por `[data-theme="nocturne"]`; portanto, seus literais e aliases locais tambem atingem temas builtin claros e custom themes, salvo tres overrides claros pontuais. Este e o principal bloqueio atual para autoria realmente theme-only.
- O port contem overrides para estados/light selectors e aliases herdados por componentes. A derivacao deve preservar especificidade, ordem, alpha, gradients e geometria; mover seletores ou reordenar folhas seria mudanca de comportamento visual.
- Syncd continua fora do escopo. Os aliases Legacy e `--n-*` nao devem ser removidos durante a derivacao.

## Marco 34 - Nocturne Port Color Derivation

### Escopo e arquitetura

- As 189 ocorrencias diretas inventariadas no Marco 33 foram migradas sem alterar seletores, ordem da cascata, geometria, blur, radius, z-index, opacidade, motion ou comportamento.
- A camada agora segue `semantic source -> component alias -> nocturne-port.css`: foram adicionados 44 sources semanticos com fallback theme-neutral e 44 aliases `--component-*` consumidos pelo port.
- Os valores Nocturne dos 44 sources ficam em `nocturne-theme.css`; nenhum valor especifico do Nocturne permanece em `nocturne-port.css`.
- Nenhum primitive novo foi criado: os novos valores representam funcoes visuais locais de Splash, controles compartilhados, Settings e source metrics, nao entradas de paleta reutilizadas por tres ou mais grupos.
- A camada `--n-*`, os 3 tokens locais Legacy do port e todos os componentes Legacy foram preservados. Syncd permaneceu integralmente fora do escopo.

### Contagem e consumo

- Cores diretas no port: **189 -> 0** para hex, `rgb/rgba`, `hsl/hsla`, `oklch` e cores nomeadas.
- `color-mix()` permanece permitido somente com variables de source/componente e `transparent`; nenhum argumento usa cor literal.
- Sources novos: **44 definidos / 44 implementados no Nocturne / 44 alcancados por component tokens / 0 sem consumo**.
- Component aliases novos: **44 definidos / 44 consumidos pelo port / 0 sem consumo**.
- Os 46 tokens locais do port mantiveram a classificacao: **43 Ativos, 3 Legacy, 0 Mortos**. Nenhum token foi removido.
- O inventario `--n-*` permanece **45 Ativos / 17 Legacy**, e os 13 aliases `--activity-*` continuam Legacy.

### Superficies migradas

- Splash: canvas visual CSS, starfield, aura, estados, erro, progresso e acoes.
- Shell/base: botoes globais, segmented controls, chips, pills, density controls e Library cards.
- Settings: density rail, value/readout states, listening state, theme preview, brand card e danger action.
- Source metrics: flags, unread pill, rating star e recommendation pill, incluindo os overrides claros existentes.

### Validacao visual real

- App Tauri real em Nocturne, WebView2/CDP estavel em `127.0.0.1:9223`, viewport 1280x800 e dados persistidos reais. Nenhuma fixture ou dado do usuario foi criado ou alterado.
- O baseline foi capturado com reversao temporaria apenas do patch de `nocturne-port.css`, recompilado pelo Vite/HMR na posicao original da cascata; o patch foi reaplicado em `finally` antes das capturas after.
- Evidencias em `docs/screenshots/marco34-nocturne-port/`: `before/after-library.png`, `before/after-search-dim.png`, `before/after-settings.png` e `before/after-splash.png`.
- Search dim: body `aethon-browse-search-engaged` confirmado nos dois lados; diferenca acima de 2 niveis RGB: **0,000%**, media **0,000**.
- Library: header, filtros, chips e toolbar (faixa y=0..259) tiveram **0,000%** de pixels acima de 2 niveis RGB. A diferenca no frame completo veio de covers que terminaram de carregar entre capturas, nao de CSS.
- Settings: **0,005%** acima de 2 niveis RGB, media **0,001**; diferenca residual restrita a antialias/estado temporal, sem mudanca aparente.
- Splash: **0,060%** acima de 2 niveis RGB, media **0,167**; diferenca residual corresponde a stars/FPS e fase da animacao. Background, logo, aura, tipografia e hierarquia permaneceram equivalentes.
- A revisao visual nao encontrou regressao aparente de contraste, superficies, bordas, shadows, blur, radius, tipografia, hover/focus ou hierarquia.

### Contratos e testes

- `nocturnePortCompatibility.test.ts` passou a exigir zero literal em cada um dos quatro blocos e 44/44 sources implementados e consumidos via component alias.
- `componentColorDerivation.test.ts` passou a reconhecer Splash, soft controls e chips como familias migradas; o gate continua proibindo cor direta e `--n-*` fora da allowlist nos component tokens.
- Testes unitarios finais: 6 arquivos, 39 testes verdes, incluindo derivacao, inventario do port, gate global, autoria, contrato e provider.
- Testes browser Chromium: port e theme probe, 2 arquivos e 2 testes verdes; o primeiro comprova pintura computada nos quatro hosts ativos e o segundo preserva o gate global existente.
- `pnpm build`: verde com 6.299 modulos; permanece apenas o aviso conhecido de chunk acima de 500 kB.
- `git diff --check`: verde, com avisos esperados de normalizacao LF/CRLF no Windows.

### Riscos restantes

- Os 44 sources sao papeis semanticos de tema e possuem fallback compartilhado, mas nao fazem parte das 47 chaves editaveis de `ThemeDocumentV4`. Um tema builtin futuro pode implementa-los somente por tokens, sem CSS de componente; um tema custom baseado no ThemeEditor herda os detalhes do tema-base para esses papeis.
- Antes de afirmar que todo detalhe do port responde somente ao documento V4, o proximo gate deve aplicar o theme probe especificamente a Splash, density/preview de Settings e source metrics e decidir entre derivacao estrita das 47 chaves atuais ou extensao controlada do contrato sem expor component tokens.
- Os aliases `--n-*` e os seletores Legacy continuam preservados e exigem auditoria separada. Syncd continua adiado por decisao de escopo.

## Marco 35 - Custom Nocturne Port Derivation

### Escopo e correcao

- O gate do Marco 34 confirmou que os 44 sources do port tinham fallback semantico, mas os valores exatos declarados no seletor geral `[data-theme="nocturne"]` continuavam vencendo quando um documento V4 usava `base: nocturne`.
- Os 44 valores canônicos foram isolados em `[data-theme="nocturne"]:not([data-custom-theme])`. O Nocturne builtin preserva os valores exatos; quando o provider aplica `data-custom-theme`, os mesmos papéis passam a resolver pelos fallbacks de `tokens.css` e pelas 47 chaves editáveis do contrato V4.
- Tres fallbacks indiretos foram alinhados ao contrato editável: action accent de Splash usa `--accent-bright`, selection ink de Settings usa `--text-inverse` e rating star usa `--color-warning`.
- Nenhum token foi adicionado/removido, nenhum component token virou campo editável e `ThemeDocumentV4`, provider, ThemeEditor, componentes, `--n-*`, aliases Legacy e Syncd permaneceram inalterados.

### Contagem e gates

- Sources do port: **44 exatos no Nocturne builtin / 44 fallbacks semanticos / 44 component aliases / 0 sem consumo**.
- O contrato unitário exige que todas as 44 declarações exatas existam somente no seletor builtin sem `data-custom-theme`.
- O probe browser simula o fluxo real do provider (`data-theme="nocturne"`, `data-custom-theme="custom:probe"` e as 47 variáveis V4 inline). Dezesseis papéis representativos de Splash, controles, Settings e source metrics resolveram por computed style e mudaram em relação ao Nocturne builtin.
- O teste browser agora restaura atributos e inline properties em `finally`, evitando vazamento do probe entre casos.

### Validacao visual real

- App Tauri real em Nocturne builtin, launcher gerenciado, WebView2/CDP `127.0.0.1:9223`, viewport 1280x800 e dados persistidos reais. Nenhum tema ou fixture foi salvo.
- Evidencias em `docs/screenshots/marco35-custom-port-derivation/`: `before/after-library.png`, `before/after-search-dim.png`, `before/after-settings.png` e `before/after-splash.png`.
- Os arquivos `before-*` reutilizam os `after-*` estáveis do Marco 34, imediatamente anteriores a esta alteração. As novas capturas foram feitas na mesma superfície Nocturne após a mudança de seletor.
- Search manteve a barra acima do dim e `aethon-browse-search-engaged` ativo durante a captura. Settings manteve surfaces, cards, toggles, tipografia, borders e hierarquia. Splash manteve background, logo, aura e estados. Library preservou shell, toolbar, cards e geometria; capas/ordenação e contagem de atividade variaram por dados runtime.
- A comparação visual não encontrou regressão aparente. Diferenças residuais correspondem a scroll/data loading, badge de atividade e animação/FPS do Splash.

### Testes e riscos restantes

- Testes focados unitários: 4 arquivos, 46 testes verdes (`nocturnePortCompatibility`, derivação de cores, provider e documentos V4).
- Gate unitário ampliado: 7 arquivos, 70 testes verdes, incluindo `themeGate`, `authoringGate` e contrato público.
- Testes browser Chromium: 2 arquivos, 3 testes verdes (`themeProbe` e computed compatibility do port).
- `pnpm build`: verde; permanece apenas o aviso conhecido de chunk acima de 500 kB.
- `git diff --check`: verde, com avisos esperados de normalização LF/CRLF no Windows.
- A correção é deliberadamente incremental: a varredura ainda encontra **188** outros `--color-*-source` literais no seletor geral do Nocturne, excluindo os 44 agora condicionados. Eles continuam herdados por documentos custom baseados em Nocturne e devem formar o próximo lote auditável; não foram movidos sem validar fallback e consumidores.
- A preview interna do ThemeEditor continua usando o contrato V4 já testado, mas não monta todas as superfícies do port. O gate browser cobre a cascata real no elemento raiz, sem persistir um tema de teste.

## Marco 36 - Custom Nocturne Semantic Source Derivation

### Escopo e arquitetura

- A varredura do Marco 35 identificou 188 `--color-*-source` literais ainda declarados no seletor geral do Nocturne. Todos possuíam fallback em `tokens.css` e referência comprovada no grafo de component tokens/port.
- As 188 declarações foram movidas mecanicamente, sem alteração de valor ou nome, para o mesmo seletor builtin `[data-theme="nocturne"]:not([data-custom-theme])` que já continha os 44 papéis do port.
- O bloco builtin agora possui **232 sources exatos / 232 fallbacks compartilhados / 232 consumidos / 0 sem consumo**. Fora desse bloco existem **0 `--color-*-source` com cor literal**.
- O probe encontrou uma dependência semântica intermediária: `--color-on-accent-strong` ainda fixava três sources em `#352660` para custom themes. O valor também foi condicionado ao Nocturne builtin; o fallback compartilhado continua `var(--text-inverse)`.
- Nenhum componente, documento V4, provider, store, API, layout, comportamento, `--n-*`, alias Legacy ou Syncd foi alterado.

### Contratos e computed style

- `themeGate.test.ts` exige 232 nomes únicos no bloco builtin, fallback presente para todos, referência de consumo para todos, zero source literal fora do bloco e `--color-on-accent-strong` igualmente restrito ao builtin.
- `themeProbe.browser.test.ts` descobre os 232 nomes pela CSSOM e compara três estados: Nocturne builtin, custom V4 com `base: nocturne` e o mesmo contrato test-only em `data-theme="probe"`.
- Para os 232 sources, o custom Nocturne resolveu valor não vazio e exatamente igual ao fallback compartilhado. Pelo menos 220 papéis mudaram materialmente em relação à paleta builtin; papéis absolutos/valores coincidentes continuam permitidos quando o fallback correto é o mesmo.
- O teste inicialmente revelou os três mismatches de ink (`browse`, `sources`, `migration`) e passou somente após a correção da dependência compartilhada; o gate não foi relaxado.

### Validacao visual real

- App Tauri real em Nocturne builtin, launcher gerenciado, WebView2/CDP `127.0.0.1:9223`, viewport 1280x800, `data-theme="nocturne"` e sem `data-custom-theme`. Nenhuma fixture ou preferência foi persistida.
- Evidências em `docs/screenshots/marco36-custom-nocturne-sources/`: `before/after-home.png`, `before/after-library.png`, `before/after-browse.png`, `before/after-downloads.png` e `before/after-settings.png`.
- Browse ficou pixel-equivalente acima da tolerância de 2 níveis RGB (**0,0000%**, média **0,0000**). Settings ficou em **0,0079%**, média **0,0002**.
- Home ficou em **0,2683%**, média **0,0406**; Downloads em **0,0808%**, média **0,0620**. As diferenças são badges/tooltips/estado temporal do runtime, sem mudança aparente de surfaces, borders, radius, tipografia ou hierarquia.
- Library ficou em **12,6628%**, média **1,4320**, por carregamento/ordenação real de covers entre capturas. Shell, filtros, cards, spacing e geometria permaneceram visualmente equivalentes.
- A revisão das cinco superfícies não encontrou regressão aparente. Estados especializados não foram forçados; eles mantêm as evidências dos marcos próprios e agora são cobertos pelo gate computed de todos os sources.

### Testes e riscos restantes

- Testes unitários focados: 3 arquivos, 28 testes verdes (`themeGate`, compatibilidade do port e derivação de component colors).
- Gate unitário ampliado: 7 arquivos, 71 testes verdes, incluindo autoria V4, provider, documentos e contrato público.
- Testes browser Chromium: 2 arquivos, 4 testes verdes (`themeProbe` e computed compatibility do port).
- `pnpm build`: verde; permanece apenas o aviso conhecido de chunk acima de 500 kB.
- `git diff --check`: verde, com avisos esperados de normalização LF/CRLF no Windows.
- Os sources agora respondem integralmente ao contrato V4, mas ainda existem papéis semânticos Nocturne sem sufixo `-source` e aliases compostos no seletor geral. O próximo gate deve comparar os component tokens ativos entre custom Nocturne e probe, inventariar apenas os bloqueios reais e condicioná-los sem mover geometria, motion ou component aliases.
- A camada `--n-*`, aliases Legacy e componentes Legacy continuam preservados; Syncd permanece fora do plano atual.

## Marco 37 - Custom Nocturne Derived Semantics

### Escopo e consolidacao

- O preflight separou os valores diretos remanescentes do seletor geral em quatro classes: 47 propriedades editáveis do contrato V4, 2 propriedades HUD editáveis, 4 shadows do tema-base e 56 papéis semânticos derivados com fallback compartilhado.
- Somente os 56 papéis derivados foram movidos para `[data-theme="nocturne"]:not([data-custom-theme])`, mantendo exatamente os valores Nocturne. Somados a `--color-on-accent-strong` do Marco 36, o bloco possui **57 semantic colors exatas / 57 fallbacks / 57 consumidas / 0 sem fallback**.
- Fora do bloco builtin permanecem exatamente **47 ThemeTokens + 2 HudThemeTokens + 4 shadow tokens** com valores diretos. Os 49 tokens editáveis são sobrescritos por CSSOM no fluxo V4; os shadows preservam a composição/alpha do tema-base e não foram transformados sem necessidade comprovada.
- Nenhum component token, componente Svelte, contrato persistido, provider, store, layout, comportamento, alias `--n-*`, código Legacy ou Syncd foi alterado.

### Gates de contrato e browser

- `themeGate.test.ts` importa a allowlist pública `THEME_TOKEN_KEYS` e exige **57/57** papéis derivados únicos no bloco builtin, fallback presente para todos e zero cor semântica derivada literal fora dele.
- `themeProbe.browser.test.ts` descobre os 57 nomes pela CSSOM, aplica um contrato V4 custom baseado em Nocturne e compara com o mesmo probe fora do seletor Nocturne.
- Todos os 57 valores custom resolveram exatamente como o fallback compartilhado; pelo menos 50 mudaram materialmente em relação ao Nocturne builtin.
- A composição dos component tokens do tema-base permanece ativa. O que mudou foi apenas a origem dos valores semânticos quando `data-custom-theme` está presente.

### Validacao visual real

- Baseline imediato do Marco 36 e novas capturas do app Tauri real, Nocturne builtin, viewport 1280x800, sem `data-custom-theme` e sem alteração de dados persistidos.
- Evidências em `docs/screenshots/marco37-custom-nocturne-semantics/`: `before/after-home.png`, `before/after-library.png`, `before/after-browse.png`, `before/after-downloads.png` e `before/after-settings.png`.
- Browse permaneceu essencialmente pixel-equivalente (**0,0000%** acima de 2 níveis RGB, média **0,0002**). Settings ficou em **0,0106%**, média **0,0008**.
- Home ficou em **0,1558%**, média **0,0338**; Downloads em **0,0592%**, média **0,0213**. As diferenças são estado temporal/tooltip/badge, sem regressão aparente.
- Library ficou em **10,5827%**, média **1,2172**, novamente por carregamento e ordenação de covers reais. Geometria, surfaces, cards, filtros, tipografia e hierarquia permaneceram equivalentes.

### Testes e riscos restantes

- Testes unitários focados: 2 arquivos, 23 testes verdes (`themeGate` e derivação de component colors).
- Gate unitário ampliado: 7 arquivos, 72 testes verdes, incluindo autoria V4, provider, documentos, port e contrato público.
- Testes browser Chromium: 2 arquivos, 5 testes verdes (`themeProbe` e computed compatibility do port).
- `pnpm build`: verde; permanece apenas o aviso conhecido de chunk acima de 500 kB.
- `git diff --check`: verde, com avisos esperados de normalização LF/CRLF no Windows.
- O próximo gate deve medir component tokens coloridos em computed style no estado custom Nocturne. Valores imutáveis por geometria, motion, alpha de shadow ou cores absolutas documentadas não devem ser confundidos com falha de derivação.
- A camada `--n-*`, aliases Legacy e componentes Legacy permanecem preservados; Syncd continua fora do plano atual.

## Marco 38 - Theme Contract Coverage Gate

### Escopo e classificacao global

- O marco adiciona gates de contrato, evidencias visuais e uma unica correcao de infraestrutura: `--shadow-focus` agora deriva de `--accent-bright` com alpha de 18%. O valor renderizado do Nocturne permanece equivalente a `rgba(184, 167, 234, 0.18)`, mas futuros documentos passam a controlar o focus ring pelo accent.
- O grafo da cascata relevante do custom Nocturne possui **1.443** component colors, excluindo deliberadamente Syncd. A classificacao exclusiva e **1.175 editaveis / 258 somente absolutos / 10 neutros / 0 unresolved**.
- Entre os 1.175 editaveis, **29** tambem compoem tinta absoluta de shadow/highlight e **6** aceitam override runtime do Reader (`--prose-bg`/`--prose-text`) com fallback tematico. Essas intersecoes sao registradas explicitamente e nao sao contadas como categorias exclusivas.
- As raizes somente absolutas permitidas sao `--primitive-absolute-black`, `--primitive-absolute-white`, `--color-shadow-source`, `--color-highlight-source`, `--shadow-sm`, `--shadow-md` e `--shadow-lg`. Elas representam tinta absoluta, highlight ou composicao de shadow; `--shadow-focus` deixou essa allowlist.
- O teste extrai somente os blocos que participam da cascata custom Nocturne, percorre referencias `var()` transitivamente, reconhece a lista completa de CSS named colors e aceita neutral apenas em gramaticas integrais documentadas (`transparent`, `none`, zeros ou border transparente). Novos literals ou dependencias sem classificacao falham o gate.
- Syncd permanece excluido conforme o plano; a camada `--n-*`, aliases Legacy e componentes Legacy nao foram removidos ou reclassificados.

### Gates de computed style e probe real

- O gate unitario confirma que os 13 tokens representativos sao alcancados por consumidores reais em `src/components` ou `nocturne-port.css`: menu, sidebar, Settings, detail, Home, Activity, Downloads, Library, Browse, Sources, Reader, Migration e Updater.
- O gate browser usa o provider real `applyCustomTheme` para aplicar um `ThemeDocumentV4` custom baseado em Nocturne e verifica os mesmos 13 grupos por computed style. Todos mudaram em relacao ao Nocturne builtin e resolveram valores validos com o probe.
- O helper de teste inicialmente aplicava um gradient em `background-color`; ele foi corrigido para testar a propriedade composta `background`. A revisao independente tambem detectou que a primeira versao injetava propriedades diretamente; o teste final passa pelo provider V4 e restaura todas as propriedades administradas pelo provider em `finally`.
- O probe sintetico tambem foi aplicado temporariamente no app Tauri/WebView2 real, sem salvar tema ou modificar dados do usuario. Library, Browse e Settings responderam a paleta oposta; atributos e inline properties foram restaurados em `finally`, deixando `data-theme="nocturne"` e removendo `data-custom-theme`.
- Evidencias reais em `docs/screenshots/marco38-theme-contract-gate/`: `probe-library.png`, `probe-browse.png`, `probe-settings.png` e `nocturne-settings-focus.png`. As tres capturas probe comprovam resposta ao contrato customizado; a captura Nocturne confirma Settings com a Search focada acima do dim apos restart do app.
- A revisao visual nao encontrou surfaces transparentes, quebra de geometria ou perda de hierarquia. Browse estava sem resultados por estado real de dados/runtime, mas shell, filtros, painel lateral, status e controles permaneceram integros.
- Na captura final real, a raiz estava em `data-theme="nocturne"`, sem `data-custom-theme`, e `--shadow-focus` resolveu para `color-mix(in srgb, #b8a7ea 18%, transparent)`. A Search permaneceu acima do dim, sem reintroduzir a regressao corrigida nos marcos anteriores.

### Testes e riscos restantes

- Testes unitarios focados: 2 arquivos, **31 testes verdes** (`themeGate` e derivacao de component colors).
- Testes browser Chromium: 2 arquivos, **6 testes verdes** (`themeProbe` e computed compatibility do port).
- Gate unitario ampliado: 7 arquivos, **80 testes verdes**, incluindo autoria V4, provider, documentos, port e contrato publico.
- `pnpm build`: verde; permanece apenas o aviso conhecido de chunk acima de 500 kB.
- `git diff --check`: verde, com avisos esperados de normalizacao LF/CRLF no Windows.
- Shadows e highlights absolutos continuam intencionalmente fora da autoria V4; focus shadow agora acompanha o accent. Uma futura decisao de editar as demais tintas absolutas exige ampliar o contrato, migracao de documentos e validacao de contraste.
- O literal preexistente suspeito em `tokens.css` (`--text-disabled: #b0ac a4`) foi separado para correcao isolada apos este gate, sem misturar escopos.
- Syncd, `--n-*`, aliases Legacy e componentes Legacy continuam fora deste marco e preservados para a auditoria futura ja registrada.

## Correcao isolada - Light Contrast split hex

- Escopo: corrigir apenas a declaracao builtin `--text-disabled` de `light-contrast`, que estava escrita como `#b0ac a4` e portanto era invalida.
- Correcao: o valor passou a `#b0aca4`, alinhado ao token de borda da mesma paleta e sem alterar Nocturne.
- Gate adicionado: `themeGate.test.ts` agora rejeita hex quebrado por espaco em declaracoes de tema, evitando regressao semelhante.
- Nenhum token Legacy, `--n-*`, Syncd ou componente visual foi removido ou migrado nesta correcao.

## Marco 39 - Semantic Compatibility Alias Gate

### Escopo e classificacao

- O marco preserva integralmente a camada `--n-*` e troca apenas a origem de oito aliases de cor referenciados pelo `nocturne-port.css`: `--n-surface-container-high`, `--n-surface-container-highest`, `--n-primary`, `--n-primary-container`, `--n-on-primary`, `--n-on-surface`, `--n-on-surface-variant` e `--n-gradient-primary`.
- Seis aliases participam de hosts ativos. Os dois aliases de surface permanecem **Legacy selector-only**, ligados a `.n-btn-secondary`/Discover Legacy; nao foram removidos nem reclassificados como Mortos.
- Os oito aliases agora derivam de `--color-modal`, `--color-surface-secondary`, `--color-accent`, `--accent-bright`, `--color-on-accent-strong`, `--text-primary`, `--text-secondary` e `--gradient-accent-primary`. Os **33 usos** no port alcançam transitivamente o contrato V4 sem acessar valores Nocturne diretamente.
- O Nocturne builtin preserva exatamente os oito valores computados anteriores: `#2a2a2a`, `#353534`, `#d3c4ff`, `#b8a7ea`, `#352660`, `#e5e2e1`, `#cac4d0` e `linear-gradient(135deg, #b8a7ea 0%, #d3c4ff 100%)`.

### Gates corrigidos

- `nocturnePortCompatibility.test.ts` exige o mapa exato dos oito aliases e prova que cada destino alcanca `THEME_TOKEN_KEYS` pelo fallback compartilhado.
- `themeProbe.browser.test.ts` verifica os oito aliases tanto no probe direto quanto pelo provider real `applyCustomTheme`; todos respondem ao documento V4 customizado.
- A classificacao do Reader agora inclui `--prose-page-bg` e `--reader-accent` junto de `--prose-bg`/`--prose-text`. A medicao correta e **9 component tokens runtime**, mantendo **1.443 component colors / 1.175 editaveis / 258 somente absolutos / 10 neutros / 0 unresolved**.
- O gate passou a detectar hex percent-encoded, inclusive duplamente codificado, e fixa o inventario atual em cinco ocorrencias: o SVG de progresso da Library, os selects ativos de `TrackingPanel`/`NovelTrackingPanel` e duas ocorrencias no `Tracking.svelte` Legacy. Elas permanecem documentadas para migracao no Marco 41; nenhuma foi ocultada por uma allowlist generica.

### Validacao visual real

- App Tauri real em Nocturne builtin, WebView2/CDP `127.0.0.1:9223`, viewport `1280x800`, sem `data-custom-theme` e sem alteracao de dados persistidos.
- Baselines before reutilizados de `docs/screenshots/marco37-custom-nocturne-semantics/after-home.png` e `after-settings.png`; capturas after em `docs/screenshots/marco39-nocturne-aliases/after-home.png` e `after-settings.png`.
- Home e Settings mantiveram geometria, surfaces, gradients, bordas, controles, tipografia e hierarquia. A unica diferenca de estado foi o contador de atividade real (34 no baseline e 81 na captura atual) e o tooltip de navegacao presente em frames diferentes; nao ha regressao visual aparente.
- A primeira tentativa de captura ocorreu durante uma transicao e foi sobrescrita pelas duas capturas finais estabilizadas; nenhum screenshot diagnostico foi mantido.

### Validacao e riscos restantes

- Testes unitarios focados: 4 arquivos, **46 testes verdes**.
- Testes browser Chromium: 2 arquivos, **6 testes verdes**.
- Permanecem para o Marco 40 a ativacao completa dos 15 HudThemeTokens e a unificacao do motion contract. Permanecem para o Marco 41 os SVGs codificados e demais valores visuais embutidos ativos.
- Syncd, aliases Legacy, componentes Legacy e a camada `--n-*` permanecem preservados.

## Marco 40 - HUD And Motion Contract

### Preflight e classificacao HUD

- Os 15 `HudThemeTokens` sao lidos, migrados e aplicados pelo provider V4, mas a auditoria de consumidores comprovou apenas **4 Ativos** fora do preview: `hud-icon-button-size` como fallback da LibraryToolbar, `hud-popover-radius` no Reader HUD, `hud-toast-radius` no Toaster e `hud-progress-height` no Reader/TTS.
- `hud-toast-radius` era aplicado na raiz, mas bloqueado pelo literal Nocturne `--component-toast-radius: 12px`; o override agora consome `var(--hud-toast-radius)`, preservando 12px no builtin e respondendo a documentos customizados.
- Permanecem **11 Legacy de autoria/preview**: `hud-control-height`, `hud-control-radius`, `hud-chip-radius`, `hud-status-radius`, `hud-chapter-row-radius`, `hud-surface-opacity`, `hud-sidebar-width`, `hud-toolbar-gap`, `hud-reader-chrome-opacity`, `hud-selection-bg` e `hud-selection-border`.
- Esses 11 tokens nao foram removidos, ocultados ou conectados por coincidencia de valor. Sidebar, Reader, chapters e status possuem geometrias especializadas diferentes; forcar aliases alteraria layout/opacidade do Nocturne e violaria o contrato de migracao incremental.

### Contrato de motion

- O provider agora aplica cinco raizes estruturadas allowlisted: `--motion-duration-fast`, `--motion-duration-normal`, `--motion-duration-slow`, `--motion-easing-standard` e `--motion-easing-emphasized`.
- `--t-fast/base/slow`, `--duration-fast/normal/slow` e `--easing-standard/emphasized` derivam dessas raizes. Assim, os presets `minimal`, `soft` e `expressive` controlam as duas familias de transition sem construir CSS dinamico.
- O preset `soft` preserva exatamente o baseline Nocturne: **80ms / 140ms / 220ms**, easing standard `ease` e easing emphasized `cubic-bezier(0.16, 1, 0.3, 1)`.
- O shorthand `--component-reader-core-resume-in-animation` combinava `var(--t-slow)` (que ja continha easing) com um segundo `cubic-bezier`, produzindo uma animacao invalida. Ele agora usa somente `var(--motion-duration-slow)` com o easing especializado existente e resolve para `220ms cubic-bezier(0.16, 1, 0.3, 1) both`.
- `--t-fast/base/slow` antigos permanecem na lista de limpeza do provider para remover inline styles deixados por sessoes anteriores, mas nao sao mais gravados diretamente.
- `--n-duration-fast: 140ms`, `--n-duration-normal: 200ms` e `--n-ease-spring: cubic-bezier(0.34, 1.56, 0.64, 1)` permanecem Legacy ativos e inalterados.

### Gates e validacao visual

- `hudMotionGate.test.ts` fixa a classificacao **4 Ativos / 11 Legacy**, as pontes reais, as cinco propriedades de cada preset, os aliases de motion e a preservacao da familia `--n-*`.
- `provider.test.ts` valida aplicacao somente das novas raizes e limpeza das propriedades antigas. `contract.test.ts` exige que os tres presets possuam exatamente a mesma allowlist.
- O probe browser aplica um documento V4 custom `minimal` e confirma Toast 8px, durations 40/80/140ms e mudanca dos aliases computados; o estado e restaurado em `finally`.
- App Tauri real em Nocturne builtin, WebView2/CDP `127.0.0.1:9223`, sem tema custom ou dados artificiais. Before imediato: `docs/screenshots/marco39-nocturne-aliases/after-home.png` e `after-settings.png`. After: `docs/screenshots/marco40-hud-motion/after-home.png` e `after-settings.png`.
- Home e Settings preservaram geometria, surfaces, controls, radius e hierarquia. A lista real `Recently Finished` mudou entre frames por estado de dados, nao por regressao visual.

### Testes e riscos restantes

- Testes unitarios focados: 6 arquivos, **74 testes verdes**.
- Testes browser Chromium: 2 arquivos, **6 testes verdes**.
- A autoria dos 11 HUD Legacy continua aceita para compatibilidade de documentos, mas seus efeitos permanecem limitados ao preview ate existir ownership visual coerente. O Marco 43 deve decidir como apresenta-los sem prometer efeito runtime inexistente.
- Syncd, componentes Legacy e toda a camada `--n-*` permanecem fora do escopo e preservados.

## Marco 41 - Embedded Visual Values And Global Allowlist

### Escopo e migracoes ativas

- O preflight globalizou a varredura de hex, `rgb/rgba`, `hsl/hsla`, `oklch` e hex percent-encoded fora dos tres arquivos de tema. Valores ativos foram separados de branding/assets, canvas, swatches, documentos de tema, export HTML, Syncd excluido e superficies Legacy.
- `App.svelte` passou a consumir 11 tokens `--component-app-fullscreen-exit-*`; border, surface, foreground, shadow, radius e z-index preservam os valores Nocturne anteriores sem literais no componente.
- Os dois color pickers de `Settings.svelte` mantem os defaults funcionais `#ffffff`/`#131316`, mas todo o chrome visual agora consome cinco tokens `--component-settings-color-picker-*`.
- O link injetado no documento EPUB de `BookReader.svelte` resolve `--component-reader-core-epub-link-fg` por computed style antes de preencher a stylesheet e a API do rendition. O fallback e a paleta de prosa selecionada; o literal independente `#c9b5ff` foi removido.
- `TrackingPanel.svelte` e `NovelTrackingPanel.svelte` substituem o SVG com stroke `%23888` por um chevron de duas gradients derivadas de `--component-tracking-record-select-indicator-bg`. `Tracking.svelte` permanece Legacy com suas duas ocorrencias intactas.
- A onda da barra de progresso da Library deixou de carregar `fill='%23d8ccff'`. A geometria SVG sem tinta virou `mask-image`; `--component-library-card-progress-liquid-wave-bg` fornece a cor e `--color-library-progress-wave-source` preserva o Nocturne exato `#d8ccff`.
- Nenhum token, alias Legacy ou `--n-*` foi removido. Syncd e superficies Legacy nao foram editados.

### Gate global e classificacao

- `directVisualValuesGate.test.ts` percorre producao e exige allowlist exata por arquivo, contagem, status e justificativa. Qualquer arquivo novo, literal novo ou mudanca de quantidade falha o gate.
- Excecoes Ativas documentadas: assets de marca, cores oficiais de providers em BrowseV3, export HTML standalone, paletas/swatches funcionais de Reader/Settings/ThemeEditor, canvas do splash, fallback de icone e documentos builtin/custom em `contract.ts`.
- Legacy preservado: `Discover.svelte`, `Extensions.svelte`, `Tracking.svelte`, `NovelSourceCheckModal.svelte` e `NovelSourceStatusDetails.svelte`. Syncd QR permanece Excluded pelo plano atual.
- O inventario percent-encoded caiu de **5 para 2**, ambas em `Tracking.svelte` Legacy. App, LibraryCard, TrackingPanel e NovelTrackingPanel agora medem zero valor visual direto.
- O grafo atualizado possui **1.455 component colors / 1.184 editaveis / 260 somente absolutos / 29 editaveis-absolutos / 9 runtime Reader / 11 neutros / 0 unresolved**. O bloco builtin possui **233 sources exatos / 233 fallbacks / 0 sem consumo**.

### Validacao visual real

- App Tauri real em Nocturne, WebView2/CDP `127.0.0.1:9223`, sem fixtures ou alteracao persistida de dados.
- Evidencias em `docs/screenshots/marco41-embedded-visuals/`: Library Comics before/after, Settings before/after, color pickers, fullscreen exit, Tracking real sem vinculo e BookReader before/after.
- Library manteve cards, filtros, covers, progressos, spacing e hierarquia. Em computed style, **80** instancias da nova wave mask estavam montadas; a tinta resolveu `rgb(216, 204, 255)` e progressos reais nao-zero preservaram a mascara.
- Settings preservou rows, cards, toggles e os dois swatches de 24px. O botao de fullscreen manteve geometria, contraste, shadow e posicao. Tracking abriu no estado real `Not tracking this manga yet`; sem registro vinculado, o `<select>` com chevron nao foi reproduzivel visualmente e fica coberto pelo contrato de 117/117 tokens.
- BookReader abriu o shell real, mas o ambiente continuou exibindo a falha preexistente de import dinamico de `epubjs.js`. O estado before/after e equivalente; a cor de link interna nao foi visualmente reproduzivel e foi validada pelo teste de token/injecao.
- A revisao das capturas nao encontrou regressao aparente de surface, border, radius, shadow, tipografia, dim, hierarquia ou geometria.

### Testes e riscos restantes

- Gate unitario: `directVisualValuesGate` + `themeGate`, **30/30** verdes.
- Contratos jsdom: Settings, App, Library, Reader Core e Detail/Tracking, **38/38** verdes.
- Browser Chromium: theme probe e LibraryCardGrid, **12/12** verdes.
- `pnpm build`: verde; permanece somente o aviso conhecido de chunks acima de 500 kB.
- `git diff --check`: verde, com avisos esperados de normalizacao LF/CRLF no Windows.
- Riscos mantidos: o runtime atual nao expos um tracking record com selects; EPUB nao renderizou conteudo por falha ambiental preexistente. Nenhum dado artificial foi criado para contornar essas limitacoes.
- Proximo lote recomendado: autoria semantica de shadow/highlight. A camada Legacy, Syncd e `--n-*` continuam explicitamente fora desse escopo.
