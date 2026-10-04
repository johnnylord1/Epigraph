# Passagem: branch `claude/audit-fixes`

Nota para a próxima sessão continuar o trabalho da auditoria de 3/out/2026.
Leia inteira antes de mexer no código.

## Regras combinadas com o dono do projeto

- Escreva o código você mesmo. A delegação ao Qwen local não vale aqui.
- **Não faça build de release** nem publique versão sem pedido explícito.
- Desktop (Tauri v2 + Svelte 5 + Rust) fica na raiz do repositório; o
  Android (Epigraph Mobile, Kotlin/Compose/SQLDelight) fica em `mobile/`,
  que é um build Gradle separado (rode `./gradlew` de dentro de `mobile/`).
- Nunca versione cache, banco com dados, perfil de usuário, backups,
  APK/AAB, keystore ou arquivos de configuração locais. Quem clonar não
  pode receber obras, artefatos ou configurações de outra pessoa.
- Teste tudo junto, numa rodada só, e corrija o que falhar antes de
  propor merge no `main`.

## Estado

Os dois commits `WIP:` desta branch **nunca foram compilados nem
testados** (a sessão anterior não tinha acesso a cargo, pnpm nem Gradle).
O primeiro passo é verificar.

### Desktop (commit "WIP: syncd fixes, animation setting, ...")

- **syncd**
  - `db.rs`: após as migrações, `preserve_change_log_sequence` impede que
    `server_version` volte para 1 quando `change_log` é recriada vazia.
  - Recibos de mutação são podados após 90 dias.
  - `replay.rs` e `routes/events.rs`: um cursor à frente do servidor
    responde `REPLAY_WINDOW_EXPIRED` (`reasonCode: CURSOR_AHEAD_OF_SERVER`),
    o que força um bootstrap completo.
  - `routes/mutations.rs`: falha transitória de armazenamento de asset
    volta como `retryable`, sem gravar recibo.
  - `suwayomi_projection.rs`: o outbox respeita a ordem por perfil
    (no máximo 3 tentativas antes de liberar os próximos).
  - `routes/audit.rs`: as rotas de auditoria aceitam só loopback.
  - Testes novos em `db.rs` e `app.rs`.
- **Animações**
  - Switch "Animações" em Configurações › Aparência (`settings.uiAnimations`).
    Quando não está definido, segue o sistema.
  - As regras `prefers-reduced-motion` viraram
    `html[data-epigraph-reduced-motion="true"]`.
  - O modo "motion idle" não reestiliza mais o app inteiro.
- **Travadas**
  - `persist()` no store faz escrita adiada (250 ms) e por campo.
  - `LibraryCard` usa o observer compartilhado de visibilidade.
  - As barras de progresso animam com `transform`.
- **Grade da biblioteca**
  - `VirtualLibraryCardGrid.svelte` foi reescrita: cada card é posicionado
    com `translate3d` e tem chave por id.
  - Há animação de entrada, saída e reposicionamento ao filtrar.
- **Navegação**
  - `Layout.svelte` mantém Início, Biblioteca e Buscar vivos (keep-alive),
    com transição de saída.
- **Traduções**: as strings novas estão em `messages/*.json`.

### Mobile (commit "WIP: recover from a rewound Core history, ...")

- `SnapshotCoreReplicaSync`: se o Core publicar versão menor que o
  checkpoint, reseta o histórico local e refaz o snapshot.
- O inbox da réplica é podado depois de aplicado.
- Alterações `blocked:*`:
  - `EpigraphMutationCoordinator` ganhou `blockedMutations`, `retryBlocked`
    e `discardBlocked`.
  - Em Configurações › Epigraph Core há uma tela para reenviar ou descartar.
  - As strings estão em `base` e `pt-rBR`.

## Verificação (fazer primeiro)

Desktop, na raiz:

```
pnpm install
pnpm test:unit
pnpm build
cd src-tauri && cargo test syncd
```

Mobile, dentro de `mobile/`:

```
./gradlew :app:testDevDebugUnitTest :data:testAndroidHostTest :data:verifySqlDelightMigration assembleDevDebug
```

Pontos de atenção:
- Os testes de `BooksLibraryBody` e `LibraryCardGrid` esperam
  `.virtual-grid`, que foi mantido.
- Testes que contam re-renderizações da grade ou dependem de
  `prefers-reduced-motion` podem precisar de ajuste.

## Resultado da verificação (sessão de 3/out, nuvem Linux)

- `pnpm test:unit`: 1870 passam, nenhum falha. Os 4 testes do First Run que
  já falhavam na `main` foram atualizados: desde "Restore modal: short pages
  and bulk dependency actions" os painéis de dependências inspecionam ao
  abrir. Isso revelou um bug: com dois backups, o segundo painel desistia de
  inspecionar enquanto o primeiro estava ocupado. Corrigido.
- `pnpm build`: ok.
- `cargo test syncd` (com `pnpm syncd:prepare-sidecar` antes): 362 passam,
  incluindo os testes novos de `db.rs` e `app.rs`. Falham 3 testes de
  `syncd::autostart`, que usam caminhos do Windows e só passam no Windows.
- Regressões dos commits WIP corrigidas: testes de contrato de animação
  (splash, paleta de busca, bundle, inventário de tema), `motionWake`
  removido (o idle não pausa mais o app inteiro), Toaster segue o switch
  Animações, indentação das regras de reduced motion.
- Mobile: `:app:testDevDebugUnitTest :data:testAndroidHostTest
  :data:verifySqlDelightMigration assembleDevDebug` passa (824 testes, nenhuma
  falha), com o Android SDK oficial. Falta só o teste no aparelho.

## Testes visuais e de sync (3/out)

- **Sync de ponta a ponta** com o `epigraph-syncd` real (Linux, perfil
  descartável): pareamento, mutação, idempotência, `/v1/changes`, stream ao
  vivo, cursor à frente, recriação do `change_log` e rotas de auditoria —
  16/16 nesta branch. O mesmo roteiro contra a `main` falha em 4 pontos
  (`server_version` volta de v2 para v1, celular perde a mudança nova, cursor
  à frente aceito em silêncio, auditoria aceita pela rede local).
- **Celular real contra o syncd real**: o cliente Kotlin do app (TLS com
  pinning, `SnapshotCoreReplicaSync`, réplica SQLDelight) sincronizou por
  snapshot, depois por `/v1/changes`, e continuou recebendo mudanças depois
  da recriação do `change_log`. Contra um Core antigo já rebobinado o
  celular não se recupera sozinho (o snapshot desse Core é inconsistente):
  a solução é atualizar o desktop.
- **Desktop no navegador** (build de produção, Suwayomi real, Chromium):
  revelou que a revalidação das sessões do syncd entrava em laço apertado
  quando falhava e congelava a UI — corrigido com nova tentativa após 30 s
  (`src/App.svelte`, teste `src/lib/syncdRevalidationRetry.test.ts`).
  Switch Animações confirmado (`data-epigraph-reduced-motion` e
  `uiAnimations`).
- **Mobile sem emulador**: `DiscoverScreenshotTest` (Robolectric +
  Roborazzi). `./gradlew :app:testDevDebugUnitTest --tests
  '*DiscoverScreenshotTest*' -Proborazzi.record=true` grava os PNGs em
  `mobile/app/build/outputs/roborazzi`.

## Feito nesta sessão

- Aba **Descobrir** no mobile (compilada e com testes; falta testar no aparelho):
  - Barra inferior: Biblioteca · Descobrir · Recentes · Explorar.
  - Sub-abas Para você / Catálogo, com Quadrinhos / Novels.
  - Catálogo: `buildDiscoverCatalog` em `DiscoverCatalog.kt`, rolagem
    infinita via `loadMore(HIGH_CONFIDENCE)` e badges dos trackers.
  - Cards `DiscoverEntryItem` removidos de Explorar e Recentes.
  - Menu de 3 pontos (`showOverflowDialog`) no topo da aba.
- **Seletor de tipo de conteúdo** num só lugar em todas as telas: a pílula
  `SegmentedSwitch` (`yokai/presentation/component/SegmentedSwitch.kt`) fica
  na barra do topo, logo antes do ⋮ (ou no fim das ações quando não há ⋮).
  Telas View usam `MenuItem.setSegmentedSwitchActionView`; os itens que não
  podem sumir ficam `showAsAction="always"`, porque a pílula consome o
  orçamento `ifRoom` da Toolbar. Biblioteca, Descobrir, Explorar, folha de
  Extensões, Repositórios, Próximos lançamentos e Configurações › Leitor.
- **Configurações** reorganizadas em subpáginas existentes (ver CHANGELOG
  do mobile).

## Pendente depois da verificação

1. **Aba Descobrir no mobile** (implementada e compilada; falta testar no aparelho)
   - A aba "For you" passa a se chamar **Descobrir** (en: Discover) e vira
     uma aba da barra inferior: Biblioteca · Descobrir · Recentes · Explorar.
   - **Não** criar aba "Mais": o menu de 3 pontos no topo, que leva às
     configurações, continua.
   - Descobrir tem duas sub-abas:
     - **Para você**: recomendações baseadas na biblioteca e nos trackers,
       no mesmo comportamento da aba Browse do desktop (`BrowseV3.svelte`
       e `src/lib/recommendations`).
     - **Catálogo**: todas as obras que as extensões instaladas permitem
       listar, com badges de nota dos trackers.
   - Remover os cards `DiscoverEntryItem` que hoje ficam no topo de
     Explorar e Recentes.
   - Pontos de partida: `DiscoverController.kt`, `DiscoverScreen.kt`,
     `BrowseController.kt`, `RootTabsController.kt` e
     `res/menu/bottom_navigation.xml`.
2. **Visual do mobile**: as telas estão simples demais. Redesenhar sem
   perder a praticidade do Mihon/J2K (grade, seleção em lote, filtros
   rápidos) e cobrindo os recursos novos (livros, novels, sync).
3. Depois de tudo verde, abrir PR de `claude/audit-fixes` para `main`.

## Contexto da auditoria

- **Desktop sem animação**: o WebView2 segue "Efeitos de animação" do
  Windows. O switch novo resolve.
- **Desktop com lag**: as causas eram o idle-motion global, o
  `persist()` regravando o blob inteiro do localStorage, as medições por
  card e a grade com chave por linha.
- **Sync**: a falha mais grave era a sequência de `server_version`
  reiniciar após recriar `change_log`, o que fazia o celular ignorar as
  mudanças novas. Está corrigida nesta branch, mas falta testar.
