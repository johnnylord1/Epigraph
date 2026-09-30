# UI redesign — plano

**Diagnóstico.** Os tokens de cor, tipo e raio do Nocturne já existem, mas o movimento não tem sistema. Há só quatro
durações e nenhuma mola. Os pushes usam três handlers diferentes: fade antes do Android 14, crossfade só no 14+ e
SimpleSwap em 14 lugares. Diálogos, sheets e popups usam a animação padrão da plataforma. Detalhes e Leitor desligam
a cor da capa no Nocturne, e as listas aparecem sem entrada. O único momento com assinatura é o voo da capa, que não
tem volta nem morph. Nas telas Compose, `YokaiTheme` não passa `motionScheme`, e o Voyager faz crossfade genérico.

**Versões verificadas.** Compose BOM 2026.05.01, material3 1.5.0-alpha21 (`MaterialExpressiveTheme`,
`MotionScheme.expressive()`) e graphics-shapes transitivo (`RoundedPolygon`/`Morph`). Também material-motion-compose
2.0.1 (shared axis/fade through), MDC 1.14 (`MaterialSharedAxis`/`MaterialContainerTransform`) e Conductor
4.0.0-preview-4 (`AnimatorChangeHandler`). DynamicAnimation vem via MDC (`SpringAnimation`). Nenhum bump nem lib nova.

**Restrição do usuário (memória).** Nada de pílula, grão, ruído, brilho (sheen) ou dock flutuante texturizado. A
ousadia vem de camadas de tom, tipografia, cor da capa e movimento.

## Direção visual e movimento por família
| Família | Visual | Movimento |
|---|---|---|
| F0 Global | Camadas 0–3 (página, barra/sheet, flutuante, modal+scrim); estados completos; alvos 48dp | Fade through entre abas; shared axis X em push/pop com predictive back; modais crescem da origem com mola; sheets físicas |
| F1 Biblioteca | Grade limpa, cabeçalhos por tipo, badges `r-xs` | Entrada escalonada na 1ª carga; reordenar animado; hopper com mola |
| F2 Detalhes | Véu da capa (blur ≥31, gradiente abaixo) + paleta da capa se `themeMangaDetails` | Container transform capa↔detalhes (ida e volta, morph de raio); parallax, título sobe, blur progressivo |
| F3 Leitor | HUD `surface` com acento da capa (toggle) | HUD entra/sai com mola; transição de página com tipo e velocidade configuráveis; momentos (obra concluída, marco) |
| F4 Recentes | Linhas densas, cartão Para você `r-m` | Entrada escalonada; expandir grupos; sheet de downloads física |
| F5 Browse | Lista de fontes por tipo; extensões em sheet | Shared axis em subtelas; entrada escalonada |
| F6 Configurações | Linha de preferência única (V e C); cabeçalho de seção `label accent` | Shared axis X entre subpáginas (Conductor e Voyager); switch/slider físicos; contido |
| F7 Outros | Onboarding/erros com a mesma pele | Momentos de backup/importação concluídos; resto contido |

## Ordem de implementação
1. Tokens: DESIGN.md §6/§9 (camadas, molas, vocabulário por relação, háptica), `Motion.kt` e `epigraph_design.xml`.
2. Componentes compartilhados: `SharedAxisChangeHandler` (substitui CrossFade/Fade nos pushes) e fade through das abas
   via tokens. Depois, animações de janela de diálogo e popup, sheet base, entrada escalonada de lista, `EpigraphScreenTransition`
   (Voyager), `MotionScheme.expressive()`, `Haptics` e `MomentOverlay` (5 fases).
3. Biblioteca, depois Detalhes (voo de volta, véu e paleta), Leitor, Recentes, Browse, Configurações e demais telas, e por fim modais e sheets restantes.
4. Em cada família: build, depois testes, autochecagem no emulador (`preview-prints/<família>/`), checklist e commit local.

## Mudanças no DESIGN.md (antes → depois)
- §6 Elevação: 3 níveis só por tom → 4 camadas (0 página, 1 barra/sheet, 2 flutuante, 3 modal+scrim) e o véu da capa.
- §6 "Detalhes sem fundo derivado da capa" → véu da capa em Detalhes/Leitor (a própria capa, borrada, a 20%). O gradiente
  vertical é permitido *só* como transição véu→`bg`; o acento da capa depende de `themeMangaDetails` e de contraste ≥4.5:1.
- §9 Movimento: 4 durações + 4 curvas → mais 4 molas nomeadas e `dur-long`. Entra o vocabulário por relação (aba, push, modal,
  sheet, capa, leitor, momento), a interrupção e a redução de movimento (só fade `dur-quick`).
- §1 Proibido: explicita grão/ruído, sheen, glow e dock flutuante. O gradiente fica proibido fora do véu.
- Novo §13 Háptica: tick/confirm/reject via `performHapticFeedback`, sem ignorar a configuração do sistema.

## Riscos e limitações previstas
- A transição View↔Compose usa uma cópia da capa no overlay do container, e não o `SharedTransitionLayout`, porque
  a Biblioteca e os Detalhes são Views.
- Diálogos Compose usam a janela do próprio Compose. A entrada é animada no conteúdo, não na janela.
- O instalador de extensão é o Package Installer do sistema (AGENTS), e a UI dele fica fora do alcance.
- Blur progressivo só no API 31+. Abaixo disso, o fallback é alpha.
