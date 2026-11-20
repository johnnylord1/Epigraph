# Auditoria das opções de customização dos readers (2026-11-17)

Mapeamento de cada opção mostrada nas configurações dos readers (mangá, novel, EPUB, PDF),
com o consumidor de cada preferência e o estado encontrado. Chaves de preferência não foram
renomeadas (contrato de compatibilidade).

## Mangá (`ReaderActivity` + viewers pager/webtoon)

Todas as opções das abas Geral, Paginado, Webtoon, Filtros e Controles têm consumidor
(`ReaderActivity`, `PagerConfig`, `WebtoonConfig`, `ReaderFilterView`). Sem defeito de fiação
encontrado. Emulador (fonte local): modo paginado e faixa longa, fundo preto, escala de cinza,
inverter cores e brilho personalizado aplicam; o slider de Filtros acompanha o gesto de brilho.

## Novel (`NovelWebViewViewer`)

| Opção | Onde aparece | Estado | Correção |
|---|---|---|---|
| Tamanho/fonte/altura de linha/margens/alinhamento/recuo/espaçamento de parágrafo | Aparência | OK (CSS injetado) | — |
| Tema/cores | Aparência | OK | — |
| Normalizar texto / limpeza agressiva | Leitura | OK (`applyRegexReplacements`) | — |
| **Dividir parágrafos automaticamente** + nº de palavras | Leitura | **Sem efeito** — preferência lida por ninguém | Dividir `<p>` só de texto acima de N palavras em limites de frase, antes da indexação (TTS continua alinhado) |
| **Aplicar estilos EPUB** | Aparência + config. global | **Sem efeito** — o sanitizador remove `<style>` e `style=""` sempre; por isso “prioridade do CSS da fonte” também não muda nada | Quando ligado, manter `<style>`/`style` filtrados (sem `url(`, `@import`, `expression`, `behavior`, `-moz-binding`, `@font-face`, `<`) |
| **Executar JavaScript EPUB** | Aparência + config. global | **Sem efeito**, e não pode ter: a WebView expõe a ponte `Android`; executar JS remoto viola a regra de segurança do projeto | Ocultar o interruptor |
| **Mostrar HTML bruto (debug)** | Aparência | **Sem efeito** | Renderizar o HTML escapado em `<pre>` |
| **Brilho personalizado negativo** (-75..-1) | Filtros / Aparência | **Parcial** — só põe a tela em 1%, sem a camada escura que o mangá usa | Usar o `brightnessOverlay` da `ReaderActivity` |
| **Toque para rolar desligado** | Controles | **Toques nas zonas anterior/próximo não fazem nada** | Tocar fora do menu alterna o menu quando a rolagem por toque está desligada |
| Filtro de cor, escala de cinza, inverter | Filtros | OK | — |
| Navegação por deslize, ações de duplo toque/toque longo, rolagem automática, TTS, tradução | Controles / TTS / Tradução | OK | — |

## EPUB (`LocalBookReaderActivity`, Readium 3.2.0)

| Opção | Estado | Correção |
|---|---|---|
| Família de fonte | OK — Serif, Sans serif e Monospace mudam a fonte no emulador (a suspeita das aspas do Readium não se confirmou) | — |
| Tamanho, altura de linha, espaçamento de parágrafo, largura do conteúdo, alinhamento, tema, rolagem/paginação | OK no emulador | — |
| Orientação, tela cheia, tela ligada, número de página, filtros, brilho | OK (`applyBookReaderSettings`/`applyBookFilters`) | — |

## PDF

Opções (orientação, tela cheia, tela ligada, tema/filtros, brilho, modo de rolagem) consumidas por
`applyBookReaderSettings`. Emulador: paginação horizontal e modo reflow (com as opções de texto)
funcionam. EPUB e PDF compartilham as preferências de brilho.

## Nova funcionalidade: brilho por gesto na borda esquerda

Como no Moon+ Reader Pro: arrastar o dedo para cima/baixo na faixa esquerda da tela (~15% da
largura) ajusta o brilho. Grava nas mesmas preferências de brilho personalizado (ativa o modo e
atualiza o valor), então o slider das configurações fica sincronizado e o valor persiste. Mostra um
indicador com a porcentagem. Toques, rolagem e seleção continuam funcionando: o gesto só é
capturado depois que um arrasto vertical começado na borda esquerda é detectado.
Readers: novel, mangá (pager/webtoon), EPUB e PDF. Pode ser desligado em Controles.

## TTS: velocidade, tom e idioma (2026-11-17)

| Reader | Sintoma | Causa | Correção |
|---|---|---|---|
| EPUB/PDF | Lista de voz só com “Padrão do sistema”; idioma impossível de trocar | A lista vinha de `LocalBookReaderActivity.availableTtsVoiceNames()`, que lia um `TextToSpeech` da activity nunca criado (o TTS real vive em `BookTtsPlaybackService`); mesmo populada, filtrava só o idioma do aparelho | `TtsVoiceCatalog` sonda o motor de forma assíncrona e lista vozes instaladas de todos os idiomas (“Idioma (País) · voz”); botão para instalar vozes nas configurações de TTS do sistema; diálogo legado morto removido |
| EPUB/PDF (config. global) | Voz era campo de texto livre | — | Lista de vozes do mesmo catálogo + atalho para as configurações de TTS |
| EPUB/PDF | Velocidade e tom | Funcionavam (medido no emulador: 1,57 s/segmento a 2,7× contra ~6 s a 0,5×) | — |
| Novel | Velocidade, tom e voz só mudavam no parágrafo seguinte | As frases já enfileiradas no motor mantêm os parâmetros antigos; `ReapplySettings` só reconfigurava o motor | Com leitura em andamento, `ReapplySettings` reinicia o parágrafo atual com os novos valores |
| Novel | Vozes que falhavam em silêncio | A lista incluía vozes com dados não baixados (`notInstalled`) | Mesmo filtro do catálogo |

## Validação (2026-11-17)

- Testes unitários: `NovelHtmlSanitizerTest` + testes do reader — 11 passaram, 0 falhas; `assembleDevDebug` OK.
- Emulador (`Epigraph_ReleaseSmoke_20261103`, via ADB): gesto de brilho validado no EPUB (−75% com
  camada escura, 13% subindo; conteúdo não rola; toque na borda continua chegando ao reader), PDF,
  mangá paginado e webtoon (arrasto na borda não rola; no centro rola). Com o menu aberto o gesto
  fica desativado, por design.
- Novel: sem fonte de novel instalada no AVD (sem plugins/rede), então as correções de novel foram
  verificadas por testes unitários e revisão de código; o gesto usa o mesmo caminho da
  `ReaderActivity` validado no mangá.
