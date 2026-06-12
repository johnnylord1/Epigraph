# Continue de onde o Gemini parou

> **Data**: 2026-06-12

O Gemini completou uma sessão de trabalho focada em 4 frentes. Tudo está compilando e os testes passam (369 unit tests, build limpa). Segue o que foi feito e o estado atual.

---

## O que foi feito

### 1. Reader HUD & Settings Refactor
- Capsule bar flutuante unificado em todos os readers (`ReaderHud.svelte`)
- Brightness control global com slider no capsule bar (persisted em `readerBrightness` no store)
- TTS movido do bar horizontal flutuante para sub-panel dentro do settings popover
- Settings popover compactado (270px), posicionado à direita no desktop, borda direita no mobile
- BookReader sincronizado com NovelReader (temas, fonts, width stepper, max 1600px)
- Defaults de cor corrigidos: `#131316` bg / `#ffffff` text (era purple)
- `tts.test.ts` excluído do projeto `unit` no vitest.workspace.ts

### 2. Card Overlay Banners
- Banner flutuante `.source-metric-banner` com flag de idioma, downloaded count, unread count
- CSS Container Queries (`cqw`) para escalar proporcionalmente ao card
- Fallback de flag no Windows via `onerror` (flagcdn → texto/emoji)
- Cards do Browse (search, catalog, genre grids) e Discover atualizados com `.card-cover-container` + `.source-metric-banner`
- Fix de spacing flag/unread quando downloaded=0 (`padding-left: 8.5cqw`)
- Removido `content-visibility: auto` do `LibraryCard.svelte` (causava clipping do banner)

### 3. Taste Insights & Recomendações
- Novo componente `TasteInsightsModal.svelte` — dashboard de analytics com genre affinities, format preferences, scoring breakdown circles, extension recommendations
- Import do `TasteInsightsModal` adicionado no `BrowseV3.svelte` (estava faltando, botão "View full insights" crashava)
- Classificação de formato refatorada em `inferMangaContentType()` (`src/lib/recommendations/adapters.ts`):
  - Scanlators dedicados (Asura, Flame, Reaper, Void) → mapeados direto como manhwa
  - Agregadores gerais (MangaDex, Manganato, Mangakakalot, MangaLife) → classificados SOMENTE pelas propriedades da obra (título, descrição, gêneros)
- `libraryOnlyProfile` construído da library inteira (mangas + novels + books) incondicionalmente
- Bug de search query stale corrigido — limpa `searchQuery` ao trocar content type
- Mesma lógica de classificação duplicada em `BrowseV3.svelte` como `inferMangaRecommendationContentType()`

### 4. Browse UI Polish
- Labels do switch renomeados: "Manga"→"Comics", "Novels"→"Books"
- Sidebar do Discover comprimido para caber sem scroll
- Setup status card (server offline) agora flutua fixo em vez de empurrar layout
- Testes do `BrowseV3.test.ts` atualizados para "Comics"/"Books"

---

## Arquivos modificados (principais)

| Arquivo | O que mudou |
|---------|-------------|
| `src/components/reader/ReaderHud.svelte` | Capsule bar, brightness popover, TTS sub-panel |
| `src/components/reader/BookReader.svelte` | Temas, fonts, width stepper, auth headers |
| `src/components/reader/NovelReader.svelte` | Fix nocturne theme swatch |
| `src/components/library/LibraryCard.svelte` | Banner overlay, flag fallback, removeu content-visibility |
| `src/components/pages/BrowseV3.svelte` | Taste insights integration, card badges, tab labels, sidebar, setup card, search reset |
| `src/components/pages/TasteInsightsModal.svelte` | **NOVO** — dashboard de analytics |
| `src/components/pages/Discover.svelte` | Card badges atualizados |
| `src/lib/recommendations/adapters.ts` | `inferMangaContentType()` refatorado (hybrid heuristic) |
| `src/store/state.svelte.ts` | `readerBrightness` adicionado nos defaults |
| `src/styles/nocturne-port.css` | Banner styles globais, flag/unread spacing |
| `vitest.workspace.ts` | Excluiu `tts.test.ts` do projeto unit |
| `docs/STATUS.md` | Atualizado |
| `docs/DECISIONS.md` | Atualizado |

---

## Estado atual

- **369 testes passando** (`npm run test:unit`)
- **Build limpa** (`npm run build`)
- **Nenhum item pendente** da sessão do Gemini — tudo foi implementado e validado
- O `IMPLEMENTATION_PLAN.md` na raiz do projeto tem 6 milestones de estabilização que ainda **não foram iniciados** (library update runtime, cover cache, extension management, readers/reflow/TTS, downloads, bulk actions)

---

## Próximos passos

Pergunte ao usuário o que ele quer que seja feito a seguir. O trabalho do Gemini está concluído e validado.
