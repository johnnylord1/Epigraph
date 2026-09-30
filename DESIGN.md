# Epigraph Mobile — Design System

Fonte única de verdade para decisões visuais. Nenhuma cor, raio, tamanho de fonte ou duração
fora deste arquivo. Se faltar um token, ele é adicionado aqui primeiro — nunca inline no código.

Escopo: estes tokens definem o tema padrão **Nocturne** (claro, escuro e AMOLED). Os demais temas
selecionáveis continuam existindo como paletas alternativas: trocam apenas `accent`, `on-accent` e
`accent-soft`; estrutura, tipografia, raio, espaçamento e movimento são os daqui.

---

## 1. Direção

**Clima:** grafite, editorial, preciso.

| Referência | O que copiar |
|---|---|
| Readwise Reader | Hierarquia só por tipografia e peso; cromo quase invisível; um único acento para estado. |
| Mihon | Densidade de lista para quem tem biblioteca grande; badges curtos e legíveis. |
| Apple Books | A capa é a protagonista — é ela que traz cor para a tela, não a UI. |

**Princípios**
1. A capa é a cor. Superfícies são neutras; o acento marca estado (selecionado, progresso, foco, não lido) e os
   controles de ação da Biblioteca (ordenar, pular categoria, contagem) — nunca fundo de área grande nem decoração.
2. Hierarquia por tipo, não por caixas. Menos cards, menos contornos, mais alinhamento.
3. Uma ação principal por tela, na zona do polegar (terço inferior).
4. Sóbrio em todo lugar, exceto em **um** momento memorável por fluxo (definido na direção escolhida).

**Proibido:** fundo creme/off-white, gradiente roxo, grade de cards idênticos como layout de seção,
botões/campos/chips/menus/indicadores em pílula, rótulos numerados 01/02/03, rótulos em monoespaçada, ícones emoji,
sombras pesadas, glows, textura de grão/ruído, brilho (sheen) sobre botões, dock de navegação flutuante,
itálico como destaque, qualquer coisa com cara de template. Gradiente só no véu da capa (§6).

**Ousadia permitida** (redesign 2026-09): camadas de tom (§6), escala expressiva do Outfit (§3), cor derivada da
capa em Detalhes/Leitor (§2) e movimento com mola (§9). Riqueza vem daqui — nunca de textura ou geometria de pílula.

---

## 2. Cor

Um acento só (matiz lilás 256°, continuidade com o Nocturne do desktop). Cores de status
(`danger`, `success`) são semânticas, não acentos: aparecem só com significado de erro/concluído.

| Token | Escuro (padrão) | AMOLED | Claro | Uso |
|---|---|---|---|---|
| `bg` | `#131313` | `#000000` | `#FFFFFF` | Fundo de página |
| `surface` | `#1B1A20` | `#0E0E10` | `#F4F3F6` | Barra de navegação, sheets, menus, snackbar |
| `surface-high` | `#25242A` | `#1B1A20` | `#EAE8EE` | Campo de busca, chip, estado pressed de linha |
| `line` | `#2E2D33` | `#232228` | `#E2E0E6` | Divisores, contorno de capa |
| `line-strong` | `#4A4851` | `#4A4851` | `#B9B6C0` | Contorno de input/botão secundário (≥3:1) |
| `text` | `#E5E2E1` | `#E5E2E1` | `#1C1B1F` | Texto principal, ícones ativos |
| `text-2` | `#A9A5AE` | `#A9A5AE` | `#57535E` | Metadados, ícones inativos |
| `text-3` | `#827E88` | `#827E88` | `#6F6B76` | Dicas, placeholder, disabled (≥4.5:1 sobre `bg`) |
| `accent` | `#C9B5FF` | `#C9B5FF` | `#4A3091` | Estado: selecionado, progresso, foco, links, não lido |
| `on-accent` | `#352660` | `#352660` | `#FFFFFF` | Texto/ícone sobre `accent` |
| `accent-soft` | `#2B2540` | `#221D33` | `#ECE6FA` | Fundo de item selecionado, indicador da nav |
| `danger` | `#CF8AA0` | `#CF8AA0` | `#B3261E` | Erro, ação destrutiva |
| `success` | `#8FD1A6` | `#8FD1A6` | `#1E7A43` | Baixado, sincronizado |
| `scrim` | `#99000000` | `#B3000000` | `#66000000` | Por trás de sheets/diálogos |

Contraste verificado (WCAG): `text-3`/`bg` escuro 4.7:1 · `accent`/`bg` escuro 10.2:1 ·
`on-accent`/`accent` escuro 7.2:1 · `accent`/`bg` claro 9.8:1 · `text-3`/`bg` claro 5.2:1.

**Estados interativos** (sobreposição da cor do conteúdo): hover/foco 8%, pressed 12%, arrastando 16%.
Disabled: conteúdo em `text-3`, fundo `surface-high`, sem opacidade sobre o componente inteiro.

**Mapeamento no código**
- XML: `res/values/color_nocturne.xml` (claro) e `res/values-night/color_nocturne.xml` (escuro) +
  atributos em `Theme.Tachiyomi.Nocturne` (`themes.xml`). AMOLED via `ThemeOverlay.Tachiyomi.Amoled`.
- Compose: herda via `createMdc3Theme` em `yokai/presentation/theme/Theme.kt` — não declarar cores em Compose.

| Token | Atributo de tema |
|---|---|
| `bg` | `background`, `android:colorBackground`, `colorSurface` (o app pinta app bar e páginas com ele) |
| `bg` / `surface` / `surface-high` | `colorSurfaceContainerLowest`, `colorSurfaceDim` / `colorSurfaceContainerLow`, `colorSurfaceContainer`, `colorSurfaceContainerHigh` / `colorSurfaceContainerHighest`, `colorSurfaceBright` (Compose herda via `withSurfaceContainers` em `Theme.kt`) |
| `surface-high` | `colorSurfaceVariant`, `searchFieldSurface`, `colorPrimaryVariant` |
| `line` / `line-strong` | `colorOutlineVariant` / `colorOutline` |
| `text` | `colorOnBackground`, `colorOnSurface`, `actionBarTintColor` |
| `text-2` | `android:textColorSecondary`, `tabBarIconInactive` |
| `accent` | `colorPrimary`, `colorSecondary`, `tabBarIconColor` |
| `on-accent` | `colorOnPrimary`, `colorOnSecondary` |
| `accent-soft` | `colorPrimaryContainer`, `colorSecondaryContainer` |
| `danger` | `colorError` |

`Color(0x…)` literal em Kotlin e `#hex` em layout são proibidos em código novo ou redesenhado.

**Paleta derivada da capa** (Detalhes e Leitor, só com `themeMangaDetails` ligado — global ou por obra):
- `cover-accent`: cor vibrante da capa (`Palette`) ajustada em luminância até ≥4.5:1 sobre `bg` do tema atual
  (`epigraph.ui.color.CoverPalette.accentFor`). Substitui `accent` em FAB, links, progresso, capítulo não lido e HUD do leitor.
- `on-cover-accent`: preto ou branco, o que der maior contraste sobre `cover-accent` (≥4.5:1).
- `cover-veil`: a própria capa borrada a 20% de alpha no topo de Detalhes (blur 24dp no API 31+, sem blur abaixo),
  fundindo em `bg` por gradiente vertical. Independe do toggle: é a imagem da capa, não uma cor de UI.
- Toggle desligado: acento do tema; véu continua. Movimento reduzido não altera cor.

---

## 3. Tipografia

Família única: **Outfit** (já no projeto, `res/font/outfit*`). Nada de itálico para ênfase — ênfase é peso ou cor `accent`.
Sempre `sp`; nada abaixo de 12sp.

| Token | Tamanho / altura de linha | Peso | Tracking | Slot M3 | Uso |
|---|---|---|---|---|---|
| `display` | 32 / 40 | SemiBold 600 | −0.25 | `headlineLarge` | Título grande de aba (Biblioteca, Recentes, Explorar) |
| `title-l` | 22 / 28 | SemiBold 600 | 0 | `titleLarge` | Título de tela interna, título de obra |
| `title-m` | 16 / 24 | Medium 500 | 0 | `titleMedium` | Cabeçalho de seção/categoria, título em lista |
| `body` | 16 / 24 | Regular 400 | 0 | `bodyLarge` | Texto corrido, descrições |
| `body-s` | 14 / 20 | Regular 400 | 0 | `bodyMedium` | Metadados, texto secundário, título de capa na grade |
| `label` | 14 / 20 | Medium 500 | 0 | `labelLarge` | Botões, abas, chips |
| `caption` | 12 / 16 | Medium 500 | 0 | `labelSmall`, `bodySmall` | Badges, contagem, carimbo de data |

Mapeamento de valores legados em XML: 11/12/13sp → `caption` ou `body-s`; 14/15sp → `body-s`;
16/17/18sp → `title-m` ou `body`; 20sp → `title-l`. Em XML, usar `textAppearance` com os estilos
`TextAppearance.Epigraph.*` (criados na etapa 3), não `textSize` direto.

---

## 4. Espaçamento — grade de 8pt

| Token | Valor | `Size` (Compose) | Uso |
|---|---|---|---|
| `space-0` | 0 | `none` | — |
| `space-½` | 4dp | `tiny` | Só dentro de componentes: ícone↔texto, padding de badge |
| `space-1` | 8dp | `small` | Gap entre capas na grade, entre ícone e rótulo |
| `space-2` | 16dp | `medium` | Margem lateral da tela, padding de linha, gap entre blocos |
| `space-3` | 24dp | `large` | Separação entre seções |
| `space-4` | 32dp | `extraLarge` | Antes de título grande, topo de estado vazio |
| `space-6` | 48dp | `huge` | Respiro de estado vazio/erro |
| `space-8` | 64dp | — | Máximo; áreas de respiro em tela grande |

- Margem lateral: 16dp (<600dp de largura), 24dp (600–839dp), 32dp (≥840dp).
- `Size.extraTiny` (2dp), `Size.smedium` (12dp) e `dimens.xml` com 5/6/10/28dp são legado: não usar em código redesenhado.
- Largura máxima de coluna de texto em tela grande: 640dp.

---

## 5. Raio

| Token | Valor | Uso |
|---|---|---|
| `r-xs` | 4dp | Badges, indicador de progresso em capa |
| `r-s` | 8dp | Botões, campos, chips, capas, indicador da navegação |
| `r-m` | 12dp | Cards, menus, snackbar, miniaturas grandes |
| `r-l` | 16dp | Topo de bottom sheets, diálogos |

Círculo (50%) só em elementos funcionalmente circulares: radio, thumb de switch, avatar, spinner.
Botões, campos, chips e indicador de aba **nunca** em pílula.
Compose: `MaterialExpressiveTheme(shapes = AppShapes)` com `extraSmall=r-xs, small=r-s, medium=r-m, large=r-l, extraLarge=r-l`.
XML: `shapeAppearanceCornerSmall/Medium/Large` no tema + `cornerRadius` dos estilos de botão.

---

## 6. Elevação e bordas

Profundidade por tom de superfície e por camada, não por sombra.

| Camada | Tratamento | Uso |
|---|---|---|
| 0 página | `bg`, sem borda | Página, listas |
| 1 cromo | `surface` | Barra de navegação, barra superior ao rolar, sheets, HUD do leitor |
| 2 flutuante | `surface` + contorno 1dp `line` + sombra 3dp (`elevation=3dp`, única permitida) | FAB, snackbar, menus, popups, barra de seleção |
| 3 modal | `surface` `r-l` sobre `scrim` | Diálogos, sheets modais, momento memorável |

Cada camada acima entra depois da de baixo estar parada (um movedor primário por vez, §9).
Capas: contorno 1dp `line` (evita capa clara "sumir" no fundo branco). Nada de glow, sombra colorida ou blur decorativo.
**Véu da capa** (Detalhes e Leitor): única exceção a blur e gradiente — ver §2 `cover-veil`. Ao rolar, o véu faz
parallax a 0.25× e o blur aumenta até 32dp (API 31+); abaixo do 31, só o alpha cai.

---

## 7. Toque e zona do polegar

- Alvo mínimo 48×48dp (atende 44pt iOS). Ícone de 24dp centrado num alvo de 48dp.
- Linhas de lista: mín. 56dp (uma linha) / 72dp (duas linhas).
- Botão principal: altura 48dp. Botão compacto: 40dp de altura visual com área de toque de 48dp.
- Ação principal da tela no terço inferior (barra inferior, FAB ou botão fixo no rodapé). Ações de topo são secundárias.

---

## 8. Ícones

- Uma família: Material Symbols, estilo **Outlined**, peso 400, 24dp. Estilo **Filled** só para o item ativo da navegação inferior.
- Cor: `text` (ativo), `text-2` (inativo), `accent` (estado selecionado). Nunca ícone decorativo colorido.
- Ícone sozinho sempre com `contentDescription`; ações de primeiro nível de telas redesenhadas têm rótulo visível.
- Estado vazio usa ícone de 48dp em `text-3`, não ilustração de 128dp.

---

## 9. Movimento

Código: `yokai/presentation/theme/Motion.kt` (Kotlin, Views e Compose), `res/values/epigraph_design.xml`
(durações/distâncias) e `res/interpolator/ease_*.xml`. Nenhum número de movimento solto fora desses três.

**Durações e curvas** (animações de janela, crossfades, tudo que não é físico)

| Token | Valor | Uso |
|---|---|---|
| `dur-instant` | 90ms | Feedback de press, ripple, troca de cor, saída do fade through |
| `dur-quick` | 150ms | Fade, troca de ícone, badge, saída de modal/menu, movimento reduzido |
| `dur-standard` | 250ms | Troca de aba, entrada de diálogo/menu, expandir seção, entrada de lista |
| `dur-medium` | 300ms | Push/pop (shared axis X) |
| `dur-emphasized` | 400ms | Voo da capa (container transform) |
| `dur-long` | 600ms | Só dentro do momento memorável (fase de pico) |
| `ease-standard` | `cubic-bezier(0.2, 0, 0, 1)` | Movimento dentro da tela |
| `ease-enter` | `cubic-bezier(0, 0, 0, 1)` | Elemento entrando |
| `ease-exit` | `cubic-bezier(0.3, 0, 1, 1)` | Elemento saindo (use ~60% da duração de entrada) |
| `ease-emphasized` | `cubic-bezier(0.05, 0.7, 0.1, 1)` | Voo da capa, momento |
| `ease-overshoot` | `cubic-bezier(0.3, 1.25, 0.5, 1)` | Escala de diálogo/menu/popup ao entrar (≈4% de overshoot — squash sutil) |

**Molas** (tudo que acompanha gesto ou pode ser interrompido; `Motion.Spring*` em Kotlin)

| Token | Amortecimento / rigidez | Uso |
|---|---|---|
| `spring-snappy` | 0.9 / 1400 | Press (escala 0.96), thumb de switch, chip, ícone pequeno |
| `spring-default` | 0.85 / 700 | Menus, HUD do leitor, assentamento de sheet, reordenar |
| `spring-gentle` | 0.9 / 300 | Superfícies grandes: voo de volta da capa, parallax, cabeçalho |
| `spring-effects` | 1.0 / 1600 | Alpha, cor, blur (nunca oscila) |
| `spring-moment` | 0.6 / 380 | Só o pico do momento memorável (overshoot visível) |

Compose: `MaterialExpressiveTheme(motionScheme = MotionScheme.expressive())`, que já traz as molas M3
nos componentes; o código próprio usa `Motion.Spring*`. Views: `SpringAnimation` (DynamicAnimation, via MDC) com os mesmos valores.

**Vocabulário por relação de navegação**

| Relação | Transição | Tokens | Voltar / interrupção |
|---|---|---|---|
| Aba raiz ↔ aba (Biblioteca/Recentes/Explorar) | Fade through: sai alpha em `dur-instant`; entra alpha + escala 0.94→1 no resto de `dur-standard` | `ease-exit`, `ease-enter` | Toque novo reinicia do estado atual (contador de geração) |
| Tela → subtela (push/pop) | Shared axis X: 30dp, quem sai some nos primeiros 35%, quem entra aparece depois | `dur-medium`, `ease-standard` | Predictive back arrasta a tela **junto com a barra do topo** (escala 0.92, 30dp, cantos `r-l`); soltar continua do ponto atual |
| Subpáginas de Configurações (Views e Compose) | Shared axis X, mesmos tokens | idem | idem nas Views; no Voyager (`EpigraphScreenTransition`) o voltar dispara o shared axis sem prévia de arrasto |
| Capa → Detalhes | Container transform: a capa viaja no overlay, raio `r-s`→`r-m`, tela entra em fade | `dur-emphasized`, `ease-emphasized` | Voltar (`CoverReturnChangeHandler`): telas em shared axis (o predictive back segue igual) e a capa do cabeçalho voa de volta até a célula, `r-m`→`r-s`, se as duas pontas estiverem na tela. Cancelado se a tela sair |
| Diálogo | Cresce do centro: escala 0.9→1 + alpha; sai com alpha + 0.96 | `dur-standard` `ease-overshoot` / `dur-quick` `ease-exit` | Scrim em fade junto |
| Menu, popup, ⋮ | Cresce do canto do âncora (pivô no canto de origem) | idem diálogo | — |
| Bottom sheet | Sobe da base; arrasto herda a velocidade e faz snap (BottomSheetBehavior); scrim em fade | `dur-standard` | Predictive back recolhe a sheet |
| Entrada de lista | Escalonada: alpha + 8dp em Y, 20ms por item, até 10 itens; só na primeira carga | `dur-standard`, `ease-enter` | Mudança de dados cancela |
| HUD do leitor | Barra do topo desliza da borda com mola (`epigraph.ui.motion.HudSpring`); alpha com `spring-effects` | `spring-default` | Toque novo inverte do ponto atual |
| Página do leitor (paginado) | Deslizar (padrão), profundidade (a página de baixo sobe de 0.85 com alpha) ou fade (cruzado, escala 0.94); velocidade escala a duração do próprio pager (virada por toque ≈200ms): lenta ×1.6, normal ×1, rápida ×0.6 (`epigraph.reader.PageTransitions`) | quíntica do pager | Arrasto segue o dedo; movimento reduzido força fade rápido |

**Regras**
1. Máquina de estados fechada por animação (ex.: `Idle → Entering → Shown → Exiting → Idle`); estado novo cancela o anterior do ponto atual.
2. Um movedor primário por vez; o resto só faz fade. Loops param quando o estado muda ou a tela sai.
3. Telas de baixo uso (Configurações profundas, debug, sobre) só usam shared axis e fade — sem mola extra.
4. Nada aloca por frame; animar só `alpha`, `translation`, `scale`, `outline` e `RenderEffect`.
5. Movimento reduzido (`ReducedMotion`, `yokai/presentation/theme/ReducedMotion.kt`): toda transição vira um fade de
   `dur-quick`; molas viram snap; momento vira fade do cartão final.

**Momento memorável — 5 fases** (`epigraph.ui.moment.MomentOverlay`; um por fluxo: obra concluída, marco de leitura,
importação concluída, backup concluído)
1. Antecipação (`dur-instant`): scrim `scrim` em fade; o selo encolhe a 0.85 (squash).
2. Impulso (`spring-moment`): selo cresce a 1.0 com overshoot; forma faz morph círculo → flor de 8 pétalas (`RoundedPolygon`).
3. Pico (`dur-long`): ícone desenha; contador rola até o valor; um toque háptico `confirm`.
4. Assentamento (`spring-default`): forma volta a círculo; texto `body text-2` sobe 8dp em fade.
5. Repouso: fica até toque ou 2,4s (ou o tempo pedido pela acessibilidade); sai em fade `dur-quick`. Toque ou voltar em
   qualquer fase pula para o repouso; no repouso, fecha.

Gatilhos (só UI, nenhuma preferência nova): **obra concluída** — o último capítulo da obra fica lido e o status é
concluído/publicação encerrada; **marco de leitura** — a obra chega a 50, 100, 250, 500, 1000 ou 2000 capítulos lidos;
**backup concluído** — backup manual gravado (contagem de obras); **importação concluída** — restauração sem erros (com
erros, só a notificação e o log) ou um EPUB/PDF importado em Livros locais (sem contador; o título do livro vai no
detalhe). Backup/restauração chegam por `MomentEvents` e só aparecem com o app na frente; a importação de livro dispara
direto de `LocalBooksController`, que já está na tela.

Título na barra (Detalhes): o título da barra aparece em alpha e sobe 8dp até o lugar conforme o título do cabeçalho passa
por baixo dela (movimento reduzido: só alpha).

Voo da capa: só o fade da tela bloqueia toque; o voo roda no overlay e é cancelado se a tela sair no meio.

Virada de página: duas preferências novas e aditivas (contrato a partir daqui) — `epigraph_page_transition_style`
(0 deslizar, 1 profundidade, 2 fade) e `epigraph_page_transition_speed` (0 lenta, 1 normal, 2 rápida). Ficam no
leitor (configurações → Paginado, abaixo de "Animar transições") e em Configurações → Leitores → Mangá → Paginado;
nenhuma chave existente muda.

---

## 10. Componentes

Componentes existentes que o redesign reaproveita — estilizados pelos tokens acima, sem trocar a implementação.

| Componente | Onde vive hoje | Especificação |
|---|---|---|
| Navegação inferior | `Widget.Tachiyomi.BottomNavigationView`, `menu/bottom_navigation.xml` | `surface`, altura 64dp+inset, indicador `accent-soft` `r-s` (não pílula), ícone Filled e rótulo ativos em `accent`, inativos em `text-2`, rótulo `label` sempre visível. |
| Título de aba + busca | `layout/library_controller.xml`, `yokai/presentation/component/AppBar.kt` | Título `display` com margem 16dp; campo de busca `surface-high`, `r-s`, 48dp, placeholder `text-3`, a 16dp das bordas (alinhado ao conteúdo). |
| Cabeçalho de categoria | `LibraryHeaderHolder`, `layout/library_category_header_item.xml` | Nome em `title-m`, contagem em `accent`; ordenar (ícone + rótulo) em `accent`, atualizar em `text-2`, alvos 48dp, sem contorno. Seletor de categoria flutuante: ícone central em `accent`. |
| Capa em grade | `LibraryGridHolder`, `layout/manga_grid_item.xml` | Capa 2:3 `r-s` + contorno `line`; título `body-s` 2 linhas; gap 8dp horizontal, 16dp vertical. Selecionada: célula em `accent-soft`, contorno 2dp `accent`, camada 12% `accent` sobre a capa, texto sem mudar de cor; a capa assenta em 0.94 com `spring-snappy` (só no toque, nunca no bind). |
| Item de lista | `LibraryListHolder`, `layout/manga_list_item.xml`, `layout/epigraph_local_book_item.xml` | Capa 40×60 `r-xs`, título `title-m`, meta `body-s text-2`, 72dp. Ações da linha como ícones 48dp (`text-2`; recuperar em `accent`); estado de erro só como trecho `danger` na meta, nunca como bloco. |
| Card "For you" | `DiscoverEntryItem`, `layout/browse_discover_item.xml` | Topo de Recentes (Agrupado) e Explorar. `surface`, `r-m`, padding 16dp, sem contorno; ícone 24dp `accent` num poço 40dp `accent-soft` `r-s`; título `title-m`, resumo `body-s text-2`; chevron `text-2`. Pressed: escala 0.98 em `dur-instant`. |
| Seção de Recentes | `layout/recents_header_item.xml`, `recents_footer_item.xml` | Cabeçalho `title-m` `text`, 24dp acima/8dp abaixo. Rodapé "View history →" como link `label` `accent`, alvo 48dp. |
| Linha de Recentes | `RecentMangaHolder`, `layout/recent_manga_item.xml` | Capa 60×80 `r-s` + contorno `line`, placeholder `surface-high`; texto a 16dp da capa; ações em alvos 48dp (`text-2`, download em `accent`). Divisor `line` começa na margem de 16dp. Barra de progresso sobre trilho `line`. |
| Deslizar em linha | `recent_manga_item`, `chapters_item`, `source_item`, `download_item` | Fundo revelado por significado: marcar lido `surface-high` com ícone `text`; marcador `accent`/`on-accent`; ocultar/cancelar `danger` com ícone/`label` em `colorOnError`. Ícone a 24dp da borda. |
| Lista de fontes | `layout/source_header_item.xml`, `source_item.xml` | Grupo ("Last used", "All") em `label text-2`, 16dp acima/8dp abaixo. Linha 56dp: ícone 40dp a 16dp da borda, nome `body`, "Latest" como botão de texto `accent`, fixar 48dp. |
| Badges | `LibraryBadge` | `caption`, `r-xs`, altura 20dp. Não lido: `accent`/`on-accent`. Baixado: `surface-high`/`success`. Total: `surface-high`/`text-2`. |
| Botão principal | `Widget.Tachiyomi.Button.Primary` | 48dp, `r-s`, `accent`/`on-accent`, `label`. Pressed: sobreposição 12% + escala 0.98 em `dur-instant`. Disabled: `surface-high`/`text-3`. |
| Botão secundário | `Widget.Epigraph.Button.Secondary`, `Widget.Tachiyomi.Button.OutlinedButton(.Icon)` | 40–48dp, `r-s`, contorno 1dp `line-strong`, texto `text`. Substitui todo `Widget.Material3.Button` cru em XML (que é pílula). Compose: todo `Button`/`OutlinedButton` passa `shape = MaterialTheme.shapes.small` — o padrão M3 é `CornerFull`. |
| Botão de texto | `Theme.Widget.Button.TextButton` | `label` em `accent`, alvo 48dp. |
| Loading button | `yokai/presentation/component/LoadingButton.kt` | Mesmo do principal; spinner 20dp `on-accent` substitui o rótulo, largura fixa. |
| Chip | `Widget.Tachiyomi.Chip.*` | 32dp visual/48dp toque, `r-s`, `surface-high`; selecionado `accent-soft` + texto `accent`. |
| FAB | `Theme.Widget.FAB` | Estendido, `accent`/`on-accent`, elevação 2. Um por tela, no máximo. Detalhes (celular): "Continue reading Chapter X" fixo no rodapé; em tablet o botão inline do cabeçalho substitui o FAB. |
| Menu ⋮ | `OverflowDialog`, `layout/tachi_overflow_layout.xml` | `surface`, `r-m`, contorno 1dp `line`, elevação 2, divisores `line`. Sem blur nem dim no fundo. Ícone ⋮ sólido. Cresce do canto superior direito. |
| Popup menu | `View.popupMenu`, `Widget.Epigraph.PopupMenu` | Camada 2: `surface`, `r-m`, contorno `line`; itens 48dp `body`; cresce do âncora. |
| Bottom sheet | `BottomSheetDialogTheme`, `TabbedBottomSheet` | `surface`, topo `r-l`, alça 32×4dp `line-strong`, `scrim`. |
| Diálogo | `Theme.Widget.Epigraph.AlertDialog` | `surface`, `r-l`, padding 24dp, título `title-l`; botões de texto `label accent`, destrutivo em `danger`. Entrada/saída por `Animation.Epigraph.Dialog`. |
| Switch | `Widget.Tachiyomi.Switch`, `SwitchPreferenceWidget` | Trilho `r-s`-arredondado (M3), thumb circular (funcional), ligado `accent`/`on-accent`; `haptic-toggle`. |
| Slider | `Widget.Tachiyomi.Slider`, `SliderPreferenceWidget` | Trilho `line`, ativo `accent`, thumb circular; `haptic-tick` por passo. |
| Cabeçalho de seção | `PreferenceGroupHeader`, `Tachiyomi.PreferenceTheme` | `label` `accent`, 24dp acima / 8dp abaixo, alinhado à margem de 16dp; sem divisor. |
| Momento memorável | `epigraph.ui.moment.MomentOverlay` | Camada 3: selo 96dp `accent-soft` com ícone 40dp `accent`, título `title-l`, contador `display`, detalhe `body text-2`. |
| Snackbar | Material Snackbar | `surface-high`, texto `text`, ação `accent`, `r-m`, acima da navegação. |
| Estado vazio | `EmptyScreen.kt`, `widget/EmptyView` | Ícone Outlined 48dp `text-3`, mensagem `body text-2` (máx. 280dp), ação principal como botão secundário. |
| Loading | `CircularProgressIndicator.kt` | Primeiro carregamento: esqueleto de capas `surface-high` estático (sem shimmer); spinner só em ação pontual. |
| Erro | `EmptyView` + `Banners.kt` | Tela: ícone + mensagem + "Tentar de novo". Parcial: banner `surface-high` com barra 4dp `danger` à esquerda. |
| Preferência | `yokai/presentation/component/preference/*` | Linha 56/72dp, título `body`, resumo `body-s text-2`. |
| HUD do leitor | `layout/reader_nav.xml` (`drawable/chapter_nav`), `reader_activity.xml` `page_number` | Barra de páginas `surface` `r-m` (não pílula), trilho `line`, ativo `accent`. Indicador de página preto `r-xs`, texto branco `caption` bold, padding 8×2dp. |
| Onboarding / tela informativa | `yokai/presentation/onboarding/*` (`InfoScreen` também serve a `CrashActivity`) | Passos direto sobre `bg`, uma camada só: nada de caixa em volta dos cards de opção. Texto na margem de 16dp; as linhas de tema rolam de borda a borda. Um botão cheio por tela ("Próximo" no rodapé); a ação do passo cai para secundária quando já está satisfeita (pasta escolhida) e link externo é botão de texto. Divisor `line`. Cards de opção `surface` `r-m`, contorno `line`; selecionado 2dp `accent` + check. Passos trocam em shared axis X. |
| Scroll rápido | `LibraryFastScroll` | Trilho invisível, thumb `accent` 4×48dp `r-xs`, bolha `surface-high` `title-m`. |

---

## 11. Adaptação

- **375dp (pequena):** margem 16dp, grade de 3 colunas, título `display` pode ceder a `title-l` ao rolar.
- **≥600dp (grande):** navigation rail (`Widget.Tachiyomi.NavigationRail`) em vez da barra inferior; grade por largura mínima de capa de 112dp; conteúdo de leitura com largura máxima de 640dp.
- **Texto ampliado (fontScale ≥1.3):** nada com altura fixa em texto; títulos de capa quebram em até 3 linhas; badges crescem na vertical; a barra inferior mantém os rótulos.
- **Escuro:** padrão do app. **Claro:** `bg` branco puro. **AMOLED:** coluna própria na tabela de cores.

---

## 12. Háptica

Sutil, sempre via `View.performHapticFeedback` sem `FLAG_IGNORE_GLOBAL_SETTING` (respeita a configuração do sistema).
Código: `epigraph.ui.Haptics`.

| Token | Constante (fallback < API 30) | Uso |
|---|---|---|
| `haptic-tick` | `CLOCK_TICK` | Passo de slider, snap de sheet, troca de categoria no seletor |
| `haptic-toggle` | `TOGGLE_ON`/`TOGGLE_OFF` API 34 (`CLOCK_TICK`) | Switch |
| `haptic-confirm` | `CONFIRM` (`CONTEXT_CLICK`) | Pico do momento memorável, seleção por toque longo |
| `haptic-reject` | `REJECT` (`LONG_PRESS`) | Ação bloqueada |

Nunca em rolagem contínua, nunca em sequência mais rápida que `dur-instant`.

---

## 13. Regras de trabalho

1. Todo valor visual novo referencia um token daqui.
2. Token faltando → parar, propor aqui, só então usar.
3. Redesign não muda lógica de domínio, sync/outbox, tabelas, chaves de preferência existentes, formatos de backup nem
   dependências. Texto novo entra só em `i18n` (moko, en + pt-BR); preferência nova só com chave nova.
