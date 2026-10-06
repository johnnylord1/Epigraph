# TASKS — Sincronização (syncd) e pareamento Epigraph Core

Plano vivo que substitui o antigo `../DIAGNOSTICO_SYNC.md` (F1.x/F2.x/F3).
Fonte de verdade dos contratos: desktop em `ForkMoku/Aethon/src-tauri/src/syncd`
(somente leitura a partir deste workspace).

Legenda: `[x]` concluído · `[ ]` pendente · `[~]` depende do desktop físico / fora do escopo mobile.

## 0. Correções ao plano antigo (`DIAGNOSTICO_SYNC.md`)

- Pacotes `aethon.*` foram renomeados para `epigraph.sync.core.*`; tabelas `aethon_*`,
  nomes de work `aethon-core-sync-*` e chaves de preferência permanecem (identificadores persistidos).
- Porta padrão do syncd é **4777** (não 4795); serviço mDNS `_epigraph-sync._tcp.`
  (legado `_aethon-sync._tcp.`); variáveis `AETHON_SYNCD_*` não existem mais no mobile.
- F1.1 (reset de checkpoint após pareamento), F1.5 (relink de fontes com pacote desconhecido),
  F1.6 e F1.7 já estavam implementados.
- F1.2 ("sync fica em retry eterno") tinha causa real diferente: `/v1/sync/status` com
  `blocked > 0` e nada pendente → ver B3.
- F1.4 / parte de F2.2 (status de sync na UI) não existiam → M3.
- O plano antigo não cobria: PIN de pareamento, código de verificação, `deviceName` no QR,
  sincronização de categorias e de estado de capítulo fora do leitor (B1, B4, B5, M1, M2).

## 1. Estado verificado (já feito e coberto por testes)

- [x] Parser de bundle QR com validação estrita, TLS pinado no SHA-256 da folha.
- [x] Fluxo claim → WebSocket de status → claim final → credencial cifrada → reset de checkpoint.
- [x] SSE com `Last-Event-ID`; worker renova escopos via `/v1/session`.
- [x] Paridade de DTOs: capabilities, session, sync status, inventário de extensões Suwayomi
      (`CoreExtensionInventory/Descriptor/Source` = `routes/suwayomi_extensions.rs`).
- [x] Outbox Core v1 para biblioteca (favoritos, categorias atribuídas), livros, anotações,
      progresso do leitor (novel/comic) e fila Suwayomi legada (6 operações).
- [x] Réplica de inventário de extensões e réplica de plugins LNReader.

## 2. Bugs

- [x] **B1 (crítico)** — o QR do desktop inclui `deviceName`; o parser estrito rejeita
      com `FIELD_SET_MISMATCH` e `BootstrapPayloadResponse` não tem o campo.
- [x] **B2** — `CoreLiveEventSupervisor` fica em loop de 10 s quando o token foi revogado
      (NeedsUserAction) e reutiliza escopos antigos.
- [x] **B3** — `CoreOutboxSyncRunner`: `/v1/sync/status` com `pending == 0 && inFlight == 0 &&
      blocked > 0` devolve `Retry(OUTBOX_PENDING)` para sempre; deve virar
      `NeedsUserAction(REMOTE_PROJECTION_BLOCKED)`.
- [x] **B4** — renomear / reordenar / excluir categoria (comic e novel) não gera comando no
      outbox (viola "toda mutação sincronizável grava outbox na mesma transação").
      Ordem de categoria comic deve ser rank 1-based (Suwayomi rejeita posição 0).
      Excluir categoria novel exige tombstones de atribuição antes do `DeleteEntity`.
      *Feito:* `EpigraphCategoryMutationRouter` (novel/livro/quadrinho) chamado por
      `CategoryRepositoryImpl`; sem pareamento a edição fica só local.
- [x] **B5** — marcar lido/não lido e favoritar capítulo fora do leitor (detalhes, biblioteca,
      recentes, notificação) não passa pelo outbox.
      *Feito:* `EpigraphReaderProgressRouter.setChapterStates` grava a linha do capítulo e os
      comandos (`comic.chapter_state` só com campos alterados; `novel.chapter` + `novel.bookmark`)
      na mesma transação; `SyncedChapterStateWriter` é usado por detalhes, biblioteca, recentes,
      notificação e duplicatas do leitor. Refresh de fonte, restore e trackers seguem locais.

## 3. Funcionalidades faltantes

- [x] **M1** — Pareamento por PIN de 6 dígitos: descoberta NSD, `POST /v1/pairing/pin/resolve`
      pinado, mapeamento de `PAIRING_PIN_NOT_FOUND` / `PAIRING_PIN_LOCKED` / 400, diálogo na UI.
- [x] **M2** — Código de verificação de 4 dígitos (FNV-1a sobre o fingerprint hex minúsculo)
      exibido durante o pareamento, idêntico ao do desktop.
- [x] **M3** — Status de sync em Configurações: estado do WorkManager, comandos pendentes no
      outbox, botão "Sincronizar agora"; nunca mostrar "sincronizado" com pendências.
      *Feito:* grupo "Sincronização" em Configurações › Epigraph Core. `CoreSyncStatusMonitor`
      combina pareamento, WorkManager (tag `aethon-core-sync`; wakes imediatos marcados com
      `aethon-core-sync-wake`), outbox + replica wait e bloqueados, e o último resultado do worker
      (`CoreSyncRunStore`, SharedPreferences `epigraph_core_sync_status`). `CoreSyncStatus.Synced`
      não carrega contagens e só é produzido com zero pendências. "Sincronizar agora" libera o
      backoff transitório (queries nomeadas `blockedMutationCount`/`releaseMutationBackoff`, sem
      mudança de schema; linhas `blocked:*` continuam paradas) e enfileira `MANUAL`.

## 4. Depende do desktop físico / rede real

- [~] F1.3 `sourcesRegistered` — não implementado no desktop.
- [~] F2.4 E2E em LAN real (QR, PIN, mDNS, TLS pinado).
- [~] F2.6 / F3 — projeção real no Suwayomi (categorias, capítulos) e comportamento SSE A-01/A-02.

## 5. Itens de baixa prioridade (concluídos)

- [x] F2.1 rótulo da ponte nas fontes: detalhes do mangá mostram "via Epigraph Core
      (aguardando <extensão>)" enquanto a extensão não está instalada no aparelho
      (`EpigraphCoreBridgeLabeler`, `EpigraphCoreBridgeLabelerTest`).
- [x] F2.3 alerta de novel sem capítulos: Configurações › Epigraph Core lista as novels da réplica
      que chegaram sem nenhum `novel.chapter` (`NovelChapterCoverageCheck`, só consultas novas em
      `aethon_sync.sq`, sem migração).
- [x] F2.5 gate de contrato no CI: `scripts/core_contract_fixture.py` compara
      `app/src/test/resources/epigraph/contract/syncd_capabilities.json` com o desktop; o job
      `syncd-contract` de `.github/workflows/android_ci.yml` roda quando a variável
      `EPIGRAPH_DESKTOP_REPO` (e, se privado, o segredo `EPIGRAPH_DESKTOP_TOKEN`) existe.

## 6. Ambiente

- `com.github.arkon.FlexibleAdapter:c8013533` não está mais disponível no JitPack; o catálogo
  `gradle/libs.versions.toml` fixa `3268efe423` (fontes idênticas). Não é mais preciso init script.

## 7. Validação

- [x] `:app:testDevDebugUnitTest --tests "epigraph.*"` verde (367 testes, 0 falhas; suíte
      completa do `app`: 501, 0 falhas).
- [x] Testes do módulo `data` afetados verdes (`:data:testAndroidHostTest --tests "epigraph.sync.*"`:
      65, 0 falhas).
- [x] Build único (`assembleDevDebug`) + inspeção visual em emulador API 36 de Configurações ›
      Epigraph Core: status "Não pareado", QR / PIN / colar bundle, grupo "Sincronização" com o
      estado "Pareie um desktop…" ("Sincronizar agora" fica oculto sem pareamento, como os demais
      itens desabilitados); diálogo de PIN sem host mostra "nenhum desktop encontrado";
      bundle inválido mostra `MALFORMED_JSON`. Fluxo pareado exige o desktop físico (seção 4).

## 8. Smoke test de fluxos (mangá / novel / livros / configurações)

Emulador API 36, build debug `dev`. Novel via plugin estático próprio servido em
`127.0.0.1:8765` (sem código de terceiros). EPUB/PDF de teste gerados localmente.

Bugs encontrados e corrigidos:

- [x] Mangá: cabeçalho de detalhes não atualizava o botão da biblioteca ao adicionar
      (`MangaDetailsController` → `notifyItemChanged(0)`).
- [x] Capítulos: linha deslizada (swipe) ficava presa aberta após a ação
      (`BaseChapterAdapter.releaseSwipedRow()` em detalhes e recentes).
- [x] Histórico: `time_read` gravado como ~0 ms (timer zerado antes da escrita assíncrona) e
      capítulo abandonado no scroll infinito de novel não recebia linha de histórico
      (`ReaderViewModel.flushReadTimer` / `setNovelVisibleChapter`, `ReadSessionDurationTest`).
- [x] Novel: ao fechar o leitor perto do topo do capítulo, o resize do WebView disparava um
      prepend do capítulo anterior e o capítulo ativo oscilava (2 → 1 → 2), gravando histórico
      para um capítulo não lido (às vezes ficando como o mais recente em Recentes). Callbacks de
      troca de capítulo / carga infinita ignorados com o leitor saindo, e compensação de scroll do
      prepend feita na mesma task JS (`NovelWebViewViewer`). Verificado por log + testes; não
      reinstalado no emulador (build único já consumido).
- [x] EPUB: parser XML seguro (`SafeXml`) falhava no Android por feature não suportada, então
      título/autor caíam para o nome do arquivo. Reimportação confirma "Epigraph Test Book" /
      "Epigraph QA" (`SafeXmlTest`).
- [x] Configurações: controller empilhado sob o cross-fade do Android 14+ vazava busca/ajuda para
      a toolbar da tela seguinte (`SettingsLegacyController.setHasOptionsMenu`).
- [x] PDF: swipe/pinça não chegavam ao `PdfPageView` (ImageView filho clicável consumia toques).
- [x] Livros: página de detalhes não recarregava o progresso ao voltar do leitor (activity
      separada) — `LocalBookDetailsController.onActivityResumed`.
- [x] EPUB: largura do conteúdo em % era passada como px (sem margens) — mapeada para
      `pageMargins` do Readium (`epubPageMarginsForContentWidth`, `EpubContentWidthTest`).
- [x] EPUB: rótulo "Capítulo N / T" deslocado em um (Readium usa k/n, catálogo usava k/(n-1)) —
      índice resolvido pelo `href` do locator, com fallback `floor(p·n)`
      (`BookChapterMetrics.epubChapterIndex`, `BookChapterMetricsTest`).
- [x] Logs de diagnóstico removidos de `NovelRepoIndexValidatorImpl`.

Verificado sem defeitos: todas as telas de Configurações abrem (Geral … Sobre, incluindo
Epigraph Core não pareado), sumário do EPUB, retomada de posição EPUB/PDF, importação por SAF.

Títulos de capítulo EPUB no catálogo de detalhes vêm do nav (EPUB 3) ou NCX (EPUB 2), com o nome
do arquivo do spine como fallback (`EpubTocTitles`, `EpubTocTitlesTest`).

Validação: `:app:testDevDebugUnitTest` 513 testes, 0 falhas; `:data:testAndroidHostTest --tests
"epigraph.sync.*"` 63 testes, 0 falhas.

## 9. Prontidão para release

Feito nesta rodada:

- [x] QuickJS com limite de memória (128 MiB, `NovelRuntimeLimits.maxHeapBytes`).
- [x] Manifesto: `allowBackup=false` + regras de extração de dados; removida
      `UPDATE_PACKAGES_WITHOUT_USER_ACTION`; atualização de extensão sempre passa pelo instalador
      visível (`USER_ACTION_REQUIRED`).
- [x] CI: `android_ci.yml` com os gates que rodam em runner Linux (migrações, testes, lint,
      `assembleDevDebug`) e o gate de contrato do syncd.
- [x] Imagens remotas em novels: `NovelRemoteImageBroker` (só HTTPS, DNS público-apenas contra
      rebinding, sem cookies/cache, tipos raster, limite de 8 MiB, timeouts, cancelamento no
      `destroy`). O sanitizer reescreve `img` HTTPS para `epigraph-novel-remote-image://` só no
      leitor de novels; EPUB continua sem imagens remotas. Respeita "bloquear mídia".
- [x] `NovelNetworkPolicy.publicOnlyDns` também no bridge de plugins (redirects + rebinding);
      bloqueio de `0.0.0.0/8` e IPv6 ULA.
- [x] Backup: segredos nunca entram nem saem (`BackupSecretPolicy`: chaves `__PRIVATE_` e nomes de
      credencial — tokens, cookies, senhas, API keys de tradução, `APIKEY` de fontes); opção
      "incluir configurações sensíveis" removida (arrays antigos do WorkManager continuam
      decodificando). Backup automático escrito como `.part`, validado, renomeado e só então
      rotacionado. Restauração limita arquivo e descompressão a 256 MiB.
- [x] Títulos de capítulo EPUB pelo TOC.
- [x] Novel: o placeholder de imagem (spinner animado em `background`) continuava girando atrás de
      imagens transparentes. Listeners `load`/`error` em fase de captura (cobrem capítulos
      anexados pelo scroll contínuo) marcam `epigraph-img-loaded` (remove o fundo) e
      `epigraph-img-failed` (oculta a imagem). Verificado no API 36: PNG HTTPS aparece sem spinner
      e a imagem HTTP é descartada.
- [x] Smoke em API 24 (emulador 1080x1920, APK debug): instalação, onboarding + pasta SAF, fonte
      Local, adicionar/remover da biblioteca (atualização reativa — a falha de refresh vista uma
      vez não se reproduziu), leitor de mangá CBZ, importação EPUB (diálogo SHA-256 mesmo com MIME
      genérico; 3 capítulos renderizados) e PDF (miniatura; paginação vertical 1/3 → 2/3). Nenhum
      `FATAL` no logcat. No API 24 o DocumentsUI ignora toques em itens; para testes manuais use
      "Mostrar armazenamento interno" + busca + teclado.
- [x] Release assinada: `:app:assembleStandardRelease -Pepigraph.requireSigning=true` gera as 5
      APKs (arm64, armeabi-v7a, x86, x86_64, universal); `apksigner verify --min-sdk-version 24`
      e `zipalign -c -P 16 4` passam em todas. Release x86_64 no API 36: cold start 7,8 s
      (primeira execução) / 3,5 s (segunda), contra 14,3 s / 8,2 s do debug; onboarding sem crash
      de R8 até o passo de permissões.
- [x] Gates: `:app:lintDevDebug` verde; `:app:testDevDebugUnitTest` 535 testes, 0 falhas;
      `:data:testAndroidHostTest` 65, 0 falhas; `:data:verifySqlDelightMigration` verde.

Biblioteca e UI (verificado no API 36, build debug):

- [x] Novels saem da biblioteca Quadrinhos (só aparecem em Livros e novels) e são reclassificadas
      quando os plugins de novel terminam de carregar (`SourceManager.catalogueSources`).
- [x] Livros e novels é uma seção única: sem título "Default", sem recolher, sem botão de
      atualizar sem efeito, sem hopper de categorias e sem "Agrupar por" no filtro. Título da tela
      e do botão de alternância traduzidos ("Quadrinhos" / "Livros e novels").
- [x] Cards EPUB/PDF: selo com o formato em vez de uma contagem "1" enganosa; botão de começar a
      ler abre o livro. Novel sem capa mostra o título na grade e um ícone de livro na lista.
- [x] Estado vazio de livros com texto próprio e ação "Importar EPUB ou PDF"; diálogo de importação
      mostra título, autor, formato e tamanho legível (sem bytes crus nem SHA-256).
- [x] Chip de ordenação alinhado à barra de busca na grade e na lista.
- [x] Explorar: cabeçalho "Last used" aparece uma vez só.
- [x] Leitor de PDF: swipe horizontal pagina também no modo vertical; fling com zoom só move a
      página.
- [x] Indicador de página/progresso dos leitores (mangá, novel, EPUB, PDF) ganhou fundo discreto
      (raio xs, sem pílula); antes o "0%" da novel e o "Chapter 1/3" do EPUB ficavam por
      cima do texto.
- [x] Onboarding: "instalar apps desconhecidos" passou a opcional. O instalador de extensões já
      trata `STATUS_PENDING_USER_ACTION` abrindo a tela do sistema, que pede a permissão sob
      demanda.
- [x] Gates depois das mudanças: `:app:testDevDebugUnitTest`, `:data:testAndroidHostTest`,
      `:data:verifySqlDelightMigration` e `:app:lintDevDebug` verdes.
- Observado e mantido: a busca da biblioteca é aproximada (FuzzyMatcher, 70%) por herança do
  upstream, então "novelzzq" ainda encontra "Epigraph Test Novel".

Pendente (exige ação do usuário ou está fora do escopo mobile):

- [~] E2E real com o syncd do desktop (pareamento por PIN/QR, edição nos dois lados,
      offline/reconexão, revogação, convergência de dois aparelhos). O syncd estava ativo na
      4777, mas o pareamento exige aprovar no app desktop. Roteiro em `docs/audit/GO_NO_GO.md`.
- [~] Smoke manual da build de release além do onboarding (leitores, backup, pareamento) num
      aparelho real. O bloqueio anterior (permissão "instalar apps desconhecidos" obrigatória no
      onboarding) foi removido: veja "Biblioteca e UI" acima. Sem aparelho real e sem build de
      release autorizada; o mesmo roteiro passou no emulador com a build de debug do CI.
- [x] Restauração de backup transacional/retomável e bytes de EPUB/PDF no backup (P1): veja a
      Fase 6.
- [x] Seleção de texto/OCR em PDF (P2): veja a Fase 6.
- [x] Testes de morte de processo no download de mangá (P2): `DownloadFinalizerTest` cobre o
      processo morto no meio de uma página (o `_tmp` não publica) e a retomada na execução seguinte
      (publica uma vez completo); a contagem de páginas virou `DownloadFinalizer.countPageFiles`.
- [x] Trackers sincronizam com o desktop (vínculos e login), conforme a Fase 3 abaixo.
- [x] Importação de backup do LNReader no fluxo normal de restauração: novels, capítulos,
      progresso e categorias; obras de plugins que não existem mais ficam na biblioteca para
      migrar; os repositórios de plugins instalados ou usados são validados e adicionados, e o
      diálogo de restauração lista quais serão adicionados.
- [x] CI: `.github/workflows/build-android.yml` (na raiz do repositório) roda a verificação de
      migrações, os testes de sync e unitários, o lint e a `assembleDevDebug` no GitHub, e guarda
      o APK de debug como artefato. A release assinada e o smoke no emulador continuam manuais.
- Versão: `0.1.0-alpha.1` / `versionCode 1` é a primeira release; não precisa de bump.

## 10. Onda de paridade com o desktop (plano)

Decisões do usuário (2026-09-28):

- Trackers sincronizam entre apps (vínculos obra → tracker e login). O lado mobile só liga quando
  o syncd anuncia a capacidade, o que o syncd do desktop passou a fazer (2026-10-05); a
  especificação fica em `docs/audit/TRACKER_SYNC_CONTRACT.md`.
- Tokens de tracker trafegam só pelo canal TLS pareado e ficam cifrados no Android Keystore.
  Continuam fora do backup. A regra do `AGENTS.md` foi ajustada para essa exceção.

Fase 1 — Biblioteca

- [x] Botão de atualizar em Livros e novels: atualiza os capítulos das novels da biblioteca
      (cabeçalho, puxar para atualizar e por grupo; só aparece em grupos com novels).
- [x] Livros e novels agrupados por categoria quando existe mais de uma categoria; com uma só,
      seção única sem título. Grupos colapsam (persistido), "expandir/colapsar tudo" funciona e
      EPUB/PDF ganham "Mover para categorias". Posição de categoria no sync passou a ser o rank
      local (o editor numera a partir de -1, o que o Core recusava).

Fase 2 — Leitores (verificar e corrigir)

- [x] Mangá (paginado e webtoon), novel, EPUB (páginas e rolagem). Verificado no emulador:
      mangá local em RTL paginado (toque e arrasto) e faixa longa com transição de capítulo e
      capítulos marcados como lidos; EPUB rolagem e paginado (o arrasto passou a virar página e a
      seleção ganhou "Destacar", que limpa a seleção depois de gravar); novel restaurada do LNReader com capítulos, progresso e
      marcador. Sem o plugin da fonte, o leitor de novel agora diz qual fonte instalar em vez de
      "ainda carregando".
- [x] PDF nos dois modos do desktop: página original (vertical, horizontal, duas páginas) e
      texto refluído (com OCR quando a página não tem texto). Em duas páginas a seleção da página
      da direita grava o destaque nela (`PdfSelectionSegments`); segurar uma página do spread
      mostra só o texto dela, sem mover a página atual.

Fase 3 — Trackers

- [x] Backup: obras (mangá e novel) restauram com os trackers; teste de ida e volta
      (`BackupTrackingRoundTripTest`).
- [x] Sync dos vínculos (`comic.track`, `novel.track`) pelo outbox, na mesma transação, só quando
      o Core anuncia as entidades; o mais recente vence contra a réplica.
- [x] Sync do login (`tracker.credential`) só pelo canal pareado, cifrado no Keystore; nunca em
      backup; apagado ao desparear (`CorePairingEndedListener` → `TrackerCredentialSyncer.wipe`).
- [x] Contrato para o desktop (`docs/audit/TRACKER_SYNC_CONTRACT.md`), implementado no syncd
      (migração 0026, rotas de credenciais de tracker).

Fase 4 — Tema, HUD e configurações

- [x] Tema "Epigraph Nocturne" com a paleta do desktop, padrão em instalações novas (escuro,
      `PreferencesHelper.lightTheme/darkTheme/nightMode`).
- [x] HUD dos leitores mais próximo do desktop: folha inferior plana e larga, sem pílula (o usuário
      rejeitou botões e barras em pílula e texturas).
- [x] Testar todos os temas (claro/escuro) e as telas de configurações; corrigir o que quebrar.
      Todas as telas de configurações abertas nos dois temas sem crash; o carregamento do leitor
      de livros mostrava o spinner esticado na tela inteira e agora fica centralizado.

Fase 5 — Explorar

- [x] Reorganizar: Descobrir virou aba própria (com sub-abas e o seletor Quadrinhos / Novels na
      mesma linha); Fontes e a busca global ficam em Explorar.
- [x] Recomendações baseadas na biblioteca (port do motor do desktop: perfil de gosto por tags,
      notas e status dos trackers, seções "Por causa da sua biblioteca", "Alta confiança",
      "Fora do habitual").

Fase 6 — Itens adiados

- [x] Restauração de backup transacional e retomável.
- [x] Bytes de EPUB/PDF no backup (opcional, com verificação SHA-256). Backup criado no emulador
      com os arquivos nomeados pelo SHA-256 e somas conferidas; restaurado numa instalação limpa,
      os dois arquivos voltaram com o mesmo SHA-256. Títulos de PDF salvos com o BOM cru
      ("þÿ...") por builds antigas são corrigidos no reparo da abertura.
- [x] PDF: seleção de texto e OCR verificados nos dois modos.
- [x] Testes de morte de processo no download de mangá.

Fase 7 — Gates, smoke no emulador e documentação.

## 11. E2E da release 0.1.0-alpha.1 (2026-09-30)

Fluxo de usuário comum na build `standardRelease` assinada (x86_64, emulador API 36), instalada
por cima da anterior:

- [x] Instalar, onboarding, restaurar `.epigraphbk`, exportar backup (sem segredos), ajustes,
      leitores (mangá, novel, EPUB, PDF) com retomada de posição, Sobre "Release 0.1.0-alpha.1".
- [x] Pareamento com o syncd do desktop por pairing bundle; status de sync nunca mostra
      "synced" com falha ou com o Core fora do ar ("aguardando validação do Core").
- [x] Bug: posições de PDF do desktop são 1-based (`pageIndex == totalPages` na última página) e
      o `ReaderLocator.Pdf` do Android é 0-based. O `require` derrubava o snapshot inteiro de
      `books:global` e o feed ficava em retry a cada 5 s. Corrigido nos dois sentidos (+1 ao
      enviar, −1 com clamp ao receber, registro inutilizável é ignorado) com teste de regressão.
- [x] Bug: `novel.progress` de uma novel removida no desktop (entry com tombstone
      `novel_deleted`) não tinha `aethon_content_identity`, e a FK derrubava o snapshot de
      novels inteiro. A projeção agora garante a identidade (como já fazia para quadrinhos). Os
      testes de projeção passaram a abrir o banco com `foreign_keys` como o app; dois fixtures
      sem a identidade pai foram corrigidos.
- [x] Bug: novels sincronizadas cujo plugin não está instalado no aparelho apareciam em
      Quadrinhos. Fontes de novels conhecidas (plugins carregados e fontes de novels vindas do
      Core, `selectNovelSourceIds`) ficam registradas e a `StubSource` delas se declara fonte de
      novel; a biblioteca reclassifica quando o conjunto muda.
- [x] Fonte não instalada mantém o nome gravado no backup (restauração, detalhes e próximo
      backup) em vez do ID numérico.
- [x] "1 repositories · 2 plugins" virou plural correto.
