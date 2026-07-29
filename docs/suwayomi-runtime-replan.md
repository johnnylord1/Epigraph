# Replanejamento do runtime Suwayomi

Status: SR3-SR8 implementados.

## Resultado desta etapa

O SR3 experimental baseado em AppContainer, MSIX, ACL de sandbox e bloqueio de
rede foi removido seletivamente. Ele falhou no primeiro requisito funcional:
o Suwayomi oficial nao iniciou de forma confiavel dentro do AppContainer cru,
porque a resolucao de `AppDirs` depende de Known Folders do Windows antes de
ler o `server.rootDir`. Isso nao e um motivo para alterar o Suwayomi ou impor
um pacote MSIX ao Aethon.

O supervisor atual usa o modelo convencional observado no ecossistema:

```text
Aethon UI
  -> Aethon Core
  -> SourceRuntime / SuwayomiAdapter
  -> RuntimeSupervisor local
  -> JRE 21 empacotado
  -> Suwayomi-Server oficial
  -> perfil dedicado
```

O runtime local e iniciado somente para URLs loopback. URLs remotas continuam
em modo attach-only e nunca sao administradas pelo updater ou pelo lifecycle
local.

## Referencias estudadas

As referencias foram clonadas em perfil temporario e analisadas no commit
indicado. Nenhum bloco de codigo foi copiado; foram adaptados somente conceitos
de lifecycle e empacotamento.

| Repositorio | Commit | Licenca | Arquivos relevantes | Observacao | Decisao no Aethon |
| --- | --- | --- | --- | --- | --- |
| `moku-project/Moku` | `f6f59524529a9eac6c165c51e1254f667441c1da` | LICENSE do repositorio | `src-tauri/src/commands/server.rs`, `src-tauri/src/server/mod.rs`, `src-tauri/src/server/resolve.rs`, `src-tauri/src/server/conf.rs`, `src-tauri/src/commands/updater.rs`, `src-tauri/tauri.windows.conf.json` | Empacota JRE + JAR, define `server.rootDir`, usa loopback, perfil local e shutdown do processo iniciado pelo app. | Preservar JRE/JAR empacotados, root explicito, attach remoto e lifecycle local; nao copiar o gerenciamento destrutivo por nome global de `java.exe`. |
| `Suwayomi/Suwayomi-JUI` | `d98ae70c91bea02b10d2410e4d0ad3f63f8d1343` | LICENSE do repositorio | fontes do launcher e lifecycle local | Referencia oficial de cliente desktop e de separacao entre servidor local e servidor remoto. | Usar como referencia comportamental, sem importar arquitetura Compose/Java para Rust. |
| `Suwayomi/Suwayomi-Server` | `b3410a214bd0b83363a38b0b60f048c523909582` | LICENSE MPL-2.0 | `server/server-config`, `server/src/main/.../ServerSetup.kt`, `ExtensionStoreService.kt`, `Extension.kt`, `H2Migration.kt`, `CEFManager.kt` | `server.rootDir` e propriedade JVM oficial; Extension Stores sao o fluxo moderno; JCEF e carregado sob demanda. | Delegar extensoes e migrations ao runtime oficial; nao criar scraper, classloader, APK->JAR ou fork. |

Fontes oficiais consultadas:

- https://github.com/Suwayomi/Suwayomi-Server/wiki/Configuring-Suwayomi%E2%80%90Server
- https://github.com/Suwayomi/Suwayomi-Server
- https://github.com/moku-project/Moku
- https://github.com/Suwayomi/Suwayomi-JUI

## Arquitetura atual do Aethon

- O bundle Windows declara `binaries/suwayomi-bundle/bin/Suwayomi-Server.jar`
  e `binaries/suwayomi-bundle/jre/**/*` em `src-tauri/tauri.windows.conf.json`.
- O JRE empacotado observado e Temurin 21.0.8.
- `src-tauri/src/lib.rs` resolve o bundle, aceita um alvo configurado,
  injeta `-Dsuwayomi.tachidesk.config.server.rootDir`, escolhe o working
  directory e inicia o processo pelo shell do Tauri.
- O perfil principal usa `127.0.0.1:4567`; o perfil de teste usa
  `127.0.0.1:4667`. Perfis customizados recebem raiz propria.
- O readiness exige resposta GraphQL, processo vivo, argumento rootDir
  correspondente e listener da porta pertencente ao PID iniciado.
- `server.owner.json` e `server.spawn.lock` evitam duplicacao e permitem
  reanexar apenas a um processo verificavel.
- `src/lib/serverLifecycle.ts` coordena wake, probe e standby. O adapter SR2
  e o unico ponto de acesso GraphQL do frontend.

## SR3 implementado

### Arquivos

- `src-tauri/src/suwayomi_runtime.rs`
- `src-tauri/src/lib.rs`

### Mudancas

- Adicionados estados `STARTING`, `READY`, `MAINTENANCE`, `UPDATING`,
  `RECOVERING`, `UNAVAILABLE` e `INCOMPATIBLE`.
- Adicionado `get_local_runtime_status` para expor o estado do supervisor sem
  expor estruturas GraphQL ao frontend.
- O owner file passou a aceitar `run_id` e identidade opcional do processo:
  creation time, executavel e hash deterministico da linha de comando.
- Reuso de processo valida essa identidade quando presente; owners antigos
  continuam legiveis por campos `serde(default)`.
- Logs de lifecycle removem quebras de linha, credenciais e valores de
  `authorization`, `cookie`, `token`, `password` e `api-key`.
- O fechamento do Aethon encerra apenas o alvo local administrado pelo app.
- O novo modulo possui testes para layout, loopback, hash e redacao de logs.

### Validacao real

`v2.3.2243` foi executado como processo normal, com o JRE empacotado, perfil
descartavel e portas de teste. O script existente `scripts/certify-suwayomi-release.mjs`
baixou o JAR oficial, verificou o SHA-256 publicado, executou startup e restart,
e confirmou:

- GraphQL `__typename`, `mangas`, `sources` e `extensions` disponiveis;
- schema canonico identico entre startup e restart;
- Extension Stores, source preferences e mutations de instalacao/atualizacao
  observadas;
- working set de aproximadamente 500 MB, memoria privada de 531-536 MB,
  76-77 threads e nenhuma imposicao artificial de limite de heap;
- relatorio sanitizado em perfil temporario.

O certificador agora aloca a porta loopback dinamicamente, confirma que o
listener pertence ao PID iniciado e aguarda sua liberacao no shutdown. A saida
e `compatibility-review.json`, marcada como nao promovivel; somente o SR7 pode
produzir evidencia para alterar a allowlist.

A versao ainda nao foi adicionada a `resources/suwayomi-compatibility.json`.
Promocao continua sendo responsabilidade do SR7, depois dos gates de dados,
extensoes, Core e Syncd.

## Impacto no Core

O Core ja diferencia o runtime local do remoto por `serverUrl`/perfil e usa
`ensureServerAwakeFor` antes das operacoes dependentes. O adapter SR2 concentra
contratos, capabilities e normalizacao de erros. Nenhuma mudanca de schema,
ID, persistencia, GraphQL ou API publica foi feita neste SR3.

Estados a preservar nos proximos marcos:

```text
STARTING -> READY
READY -> MAINTENANCE -> READY
READY -> UPDATING -> READY
READY -> RECOVERING -> READY
qualquer estado -> UNAVAILABLE ou INCOMPATIBLE
```

Indisponibilidade nao pode virar biblioteca vazia, exclusao, reset de progresso
ou reset de bookmark. Isso permanece como gate dos proximos marcos.

## Impacto no Syncd

Conclusao: **IMPACTO LIMITADO E CORRIGIDO**.

O Syncd possui SQLite proprio e trabalha com envelopes normalizados de livros,
novels do fluxo LNReader, comics, categorias, progresso, bookmarks, historico,
repositories/plugins de novels e assets. A
replicacao passa por `src-tauri/src/syncd_replication.rs`; nao ha leitura de H2
nem uso de IDs internos do Suwayomi como identidade global no fluxo normal.

`src-tauri/src/syncd/app.rs` registra um proxy GraphQL para clientes autorizados,
mas isso e uma superficie HTTP de transporte e nao uma dependencia do Syncd em
H2 ou no schema do Suwayomi para reconciliar estado. O runtime manifest do Syncd
persiste a propria identidade, porta, fingerprint e executavel.

| Dado | Autoridade | Persistencia | Consumidores | Sincronizado | Risco no restart/update |
| --- | --- | --- | --- | --- | --- |
| biblioteca comics/books | Core/Suwayomi normalizado | Core + snapshot Syncd | Library, Details, Syncd | sim, normalizado | indisponibilidade nao pode emitir exclusao |
| biblioteca novels/LNReader | Core/LNReader normalizado | estado de novels + Syncd | Novel Library, Details, Syncd | sim, normalizado | indisponibilidade do Suwayomi nao pode remover novels |
| categorias | Core | Suwayomi/Core + Syncd | Library, Syncd | sim | merge/tombstone ja tratado no Syncd |
| progresso | Core | Suwayomi/Core + Syncd | Reader, Dashboard, Syncd | sim | preservar durante maintenance |
| bookmarks | Core | Core + Syncd | Reader, Syncd | sim | nao depender do PID/porta |
| historico | Core | Core + Syncd | Dashboard, Syncd | sim | replay idempotente |
| downloads | Core/Suwayomi | runtime local | Downloads | limitado ao escopo local | nao apagar por runtime offline |
| repositories/plugins de novels | Core/LNReader | estado de novels + Syncd quando aplicavel | Novel Sources/Settings | sim quando parte do estado normalizado | runtime de comics nao pode limitar esse fluxo |
| stores/extensoes Suwayomi | Suwayomi | perfil do runtime | Sources/Settings | nao como estado de leitura | update deve preservar package/origem |
| source IDs/URLs | adapter/Core | estado normalizado | Browse/Details/Syncd | URL/identidade normalizada | investigar mudanca de sourceId antes de SR4 |
| PID/porta/caminho/cache | supervisor | local | supervisor | nao | nunca enviados ao Syncd |

## Sistema de extensoes

O pipeline correto e:

```text
Extension Store -> metadados -> Suwayomi -> artefato oficial
-> Extension Manager -> source registrada -> GraphQL -> SourceRuntime
```

O Aethon nao converte APK em JAR, nao possui classloader paralelo e nao deve
manter uma allowlist por package. O runtime moderno `v2.3.2243` expoe
Extension Stores e a mutation `installExternalExtension`, mas o teste de SR3
nao declara nenhuma source de website como permanentemente suportada.

O `AbstractMethodError` anterior ainda nao foi classificado neste marco. A
reproducao deve ser feita em fixture estrutural ou canario controlado em SR5,
separando runtime antigo, API/serialization, cache de artefato, extensao e
website. Cloudflare, login, rate limit e site alterado permanecem limitacoes
externas.

## Updater

Existem dois fluxos distintos:

1. updater do Aethon, configurado pelo plugin Tauri;
2. updater controlado do Suwayomi em `src-tauri/src/suwayomi_update.rs`.

O segundo ja possui allowlist, checksum, staging, lock, snapshot e health checks,
mas o manifesto ainda aprova `v2.1.1867`; `v2.3.2243` e apenas um candidato
certificado pelo script no SR3. Nao ha instalacao silenciosa de `latest` neste
marco. A politica recomendada continua sendo: verificar e notificar para
versoes nao aprovadas, e instalar somente uma versao exata apos SR7.

## Plano revisado SR3-SR8

### SR3 - Supervisor local do Suwayomi

- Objetivo: lifecycle convencional, perfil dedicado, readiness, logs e shutdown.
- Referencias: Moku server lifecycle; Suwayomi `server.rootDir` e bundles.
- Arquivos: `src-tauri/src/lib.rs`, `src-tauri/src/suwayomi_runtime.rs`, testes
  Rust e `src/lib/serverLifecycle.ts` somente se um estado de UI for consumido.
- Core: nenhuma reescrita; manter adapter e wake existentes.
- Syncd: nenhuma alteracao de protocolo; preservar fila, snapshots e todos os
  escopos de novels/LNReader, sem limitar o conjunto de entidades sincronizadas.
- Extensoes: apenas readiness estrutural, sem websites em massa.
- Aceite: startup/restart/shutdown, porta ocupada, processo duplicado, perfil
  dedicado, remoto intacto, logs sanitizados e build verde.
- Commit sugerido: `feat(sources): supervise local suwayomi runtime`.

### SR4 - Stores e pipeline oficial de extensoes

- O `SourceRuntime` agora expoe `listStores`, `addStore` e `removeStore`; os
  componentes nao chamam mais `extensionRepos` diretamente.
- Suwayomi v2.3 usa `addExtensionStore`/`removeExtensionStore` com `indexUrl`;
  Suwayomi v2.1 permanece suportado por um fallback explicitamente marcado como
  `isLegacy`, usando `setSettings` somente no adapter de compatibilidade.
- O helper de repositorio recomendado e o painel manual de Sources usam o
  adapter, preservando stores adicionais e evitando duplicacao por URL
  normalizada.
- O inventario de reconciliacao tambem consulta `runtime.listStores()`, sem
  voltar a ler `settings.extensionRepos` fora dos profiles de compatibilidade.
- A proveniencia registra package, versao, store, tipo de artefato e runtime.
  Digest e assinatura observada permanecem nulos quando nao foram obtidos; o
  sistema usa `verificationMethod: NONE` e nunca apresenta metadata declarada
  pelo store como verificacao criptografica.
- APK oficial continua permitido como artefato de origem; nenhuma conversao
  APK->JAR foi criada.
- Validacao isolada cobriu decodificacao V21/V23, add/remove, deduplicacao,
  proveniencia e contrato GraphQL. Instalacao/update/uninstall do artefato e
  restart do runtime permanecem no SR5/SR7, sem promover v2.3 neste marco.
- Commit: `refactor(sources): stabilize official extension pipeline`.

### SR5 - Saude estrutural e canarios

- Implementado em `src/lib/manga/runtime/health.ts` com dois niveis separados.
  O Level 0 consulta apenas runtime, stores, extensoes e sources registrados no
  GraphQL local; ele nao acessa websites. O Level 1 executa uma unica consulta
  leve somente quando chamado explicitamente, com timeout, cancelamento, cache
  limitado e preservacao temporaria da ultima evidencia saudavel.
- Estados cobertos: runtime ready, manager ready, store available, installed,
  obsolete/update available, loaded, source registered, source reachable,
  login, antibot, offline, rate limited, configuration required e incompatible.
- `AbstractMethodError`, erros de classloader e serialization sao classificados
  como incompatibilidade de extensao. Cloudflare, login, rate limit e falhas de
  rede permanecem estados externos e nao rebaixam o runtime automaticamente.
- O pacote helper `eu.kanade.tachiyomi.extension.all.tachidesk` nao e marcado
  como quebrado por nao registrar uma source de conteudo.
- Falhas transitorias do runtime preservam o ultimo inventario estrutural valido;
  evidencias expiradas nao sao reutilizadas. Cancelamentos do usuario nao sao
  registrados como falha de saude.
- Cobertura automatizada: correlacao estrutural, helper, inventario stale,
  classificacao ABI/serialization/rede/autenticacao, cache, expiracao, timeout,
  cancelamento e smoke opcional contra runtime descartavel via
  `AETHON_SUWAYOMI_LIVE_ENDPOINT`.
- Nenhuma tela, fluxo Syncd, novel/LNReader ou teste automatico em massa contra
  websites foi adicionado neste marco.
- Commit: `feat(sources): add structural extension health`.

### SR6 - Core/Syncd maintenance e recuperacao

- Implementado um coordenador de operacoes com leases compartilhadas para
  mutacoes e lease exclusiva para snapshot, promocao, instalacao e recuperacao.
  O lock em arquivo coordena o processo principal e o sidecar Syncd; o estado
  em memoria drena operacoes iniciadas pela UI antes de parar o runtime.
- Mutacoes GraphQL mantem a lease ate receber e decodificar a resposta e nao
  sao repetidas automaticamente depois de falha ambigua. Migracao, update da
  Library e restore de backup mantem uma lease durante a operacao completa.
- No proxy Syncd, somente documentos GraphQL `mutation` recebem a lease.
  Queries, replicacao Syncd, snapshots normalizados, novels/LNReader,
  repositories de novels e demais rotas do AethonCore nao sao bloqueados.
- O snapshot passou ao schema 2 e inclui recursivamente banco, configuracao,
  `extensions/` e `settings/`, com tamanho e SHA-256 por arquivo. Downloads,
  backups, caches, covers, imports e conteudo local permanecem excluidos.
- O restore valida hashes e caminhos relativos, remove apenas extras das duas
  arvores allowlisted, sincroniza cada arquivo temporario e publica por troca
  atomica. Manifestos schema 1 continuam restauraveis.
- A promocao grava um journal atomico antes da primeira troca de diretorio e
  registra `CURRENT_STOPPED`, `RUNTIME_PROMOTED`, `POST_CHECK_RUNNING`,
  `COMMITTED`, `ROLLBACK_RUNNING` e `ROLLED_BACK`. Startup incompleto executa
  rollback antes de iniciar o runtime; replay repetido distingue o candidate
  pela versao do JAR e nao remove novamente o runtime restaurado.
- O rollback exige encerramento confirmado do processo antes de alterar H2 ou
  diretorios. Comandos externos de start, stop, reset e configuracao respeitam
  o lock; os comandos internos do updater usam um caminho explicitamente
  controlado para evitar deadlock.
- Validacao: 333 testes Rust da biblioteca, incluindo Syncd; 70 testes focados
  do updater; 38 testes TypeScript de client/adapter/migration/update; 37
  testes dos contratos SR2-SR5, com o smoke live condicional ignorado; Settings
  jsdom; build; e `svelte-check` sem erros ou avisos.
- Commit: `fix(sources): coordinate runtime maintenance with core`.

### SR7 - Promocao controlada de v2.3.2243

- Startup, restart, H2 migration, Extension Stores, extensoes canario,
  biblioteca, progresso e rollback foram repetidos em perfil descartavel com
  o JRE 21 empacotado.
- O perfil original foi usado somente como fonte de uma copia allowlisted e
  permaneceu byte a byte inalterado. O gate preservou 4 obras, 1.804 capitulos,
  2 categorias, 4 extensoes instaladas e 37 sources nas quatro fases.
- Todas as extensoes de conteudo instaladas registraram sources no V21, no V23,
  depois do restart e no rollback. Nomes e URLs ficam fora do relatorio; apenas
  hashes e contagens sao persistidos.
- O store Legacy `index.min.json` foi canonicalizado pelo V23 para o store
  protobuf `index.pb`, permaneceu estavel no restart e voltou ao formato Legacy
  no rollback.
- A promocao de producao agora converte `server.extensionRepos` em
  `server.extensionStores` por escrita atomica. Falha de parse/escrita aciona o
  rollback existente, que restaura runtime, H2, extensoes, settings e
  `server.conf` pelo snapshot.
- `v2.3.2243` foi adicionada a allowlist exata pelo SHA-256 publicado e passou a
  ser `maxTestedVersion`. `v2.2.2100` permanece bloqueada.
- Website, login, antibot e JCEF nao foram inferidos do Level 0. Comix foi
  carregada como canario estrutural; Mangakakalot, MangaClash e Asura tinham
  artefatos locais, mas nao estavam instaladas no estado GraphQL do perfil.
- Commit: `test(sources): certify suwayomi 2.3 runtime migration`.

### SR8 - Gate final

- `pnpm release:certify-source-runtime` consolida, em ordem serial, contratos do
  certificador, adapter V21/V23, runtime health, canarios, `svelte-check`, Cargo,
  build, cleanup de JVM/diretorios candidate e whitespace.
- O modo interno `-ContractOnly` e usado pelo `release:verify`, que ja executa
  os gates globais de Svelte, Cargo e build. Isso evita duplicar as cargas mais
  pesadas sem reduzir cobertura.
- O manifesto e testado contra a versao, asset e SHA-256 exatos do SR7 e exige
  que `v2.2.2100` continue bloqueada.
- O gate nunca remove processos ou diretorios desconhecidos: residuos causam
  falha acionavel. CPU, Vitest e Cargo permanecem limitados a um worker/job.
- Limitacoes externas continuam explicitas; nenhuma lista de centenas de
  extensoes ou promessa de disponibilidade de website foi criada.
- Validacao local completa em 27/07/2026: 16 testes do certificador, 37 testes
  de adapter/health (1 smoke live condicional ignorado), `svelte-check` com
  0 erros/0 avisos, Cargo completo com 336 testes da biblioteca mais binarios e
  doc-tests, build frontend e cleanup final aprovados em execucao serial.
- Commit: `test(sources): enforce source runtime compatibility gate`.

## Arquivos preservados fora do SR3

As alteracoes antigas de busca, trackers, Hardcover, i18n, temas, Reader,
Tauri/Cargo fora do teste descartado, Syncd e demais features continuam no
worktree e nao foram staged. O SR3 experimental foi removido sem restaurar
arquivos inteiros ou usar operacoes destrutivas globais.

## Validacao do SR3 e SR4

- `cargo fmt`: aprovado.
- `cargo test --lib suwayomi_runtime`: aprovado.
- Runtime/adapter: `16 passed; 1 skipped`.
- `scripts/certify-suwayomi-release.mjs --version v2.3.2243`: aprovado em
  startup e restart, sem promover allowlist.
- `git diff --check`: aprovado.
- `svelte-check`: 0 erros e 0 avisos.
- Os testes de SR4 exercitam stores legacy e oficiais sem tocar Syncd, Core,
  novels/LNReader ou persistencia de biblioteca.

SR1-SR8 estao concluidos. A `v2.3.2243` esta allowlisted apos a certificacao
controlada do SR7 e protegida pelo gate SR8; websites externos e JCEF permanecem
checks explicitos, sem alterar a compatibilidade estrutural do runtime.

### SR11 - Atualizacoes transacionais de extensoes

- `ExtensionUpdateCoordinator` atua somente como orquestrador tipado. Download
  com limite, staging, snapshot, candidate, ativacao e rollback ficam no comando
  nativo; carregamento e instalacao continuam no Extension Manager oficial.
- Updates individuais e `Update all` da tela ativa de Sources usam um unico
  lote sequencial. Nenhum update e mais ativado pela mutacao direta
  `runtime.updateExtension()`.
- O candidate e o runtime principal nunca executam simultaneamente. O H2 e
  copiado apenas depois de shutdown, porta livre e lock exclusivo comprovados.
- O journal separado de extensoes permite restaurar o snapshot no startup se o
  Aethon for encerrado durante certificacao ou ativacao. Runtime, configuracao e
  perfil voltam como uma unidade antes de novas mutacoes.
- O registro de compatibilidade e atomico, versionado e escopado por perfil. A
  identidade inclui hashes do artefato e do runtime, evitando considerar dois
  binarios equivalentes apenas por package/version.
- O gate real confirmou o APK exato pelo `installExternalExtension` oficial,
  27 source IDs estaveis apos restart e zero requests a websites. A espera
  limitada de readiness evita falso negativo enquanto o Extension Manager
  termina de registrar as sources.
- Nao foram criados classloader, scraper, conversor APK->JAR, formato de
  extensao, manipulacao de classpath ou acesso direto ao H2.

### SR12 - Fronteira padrao e Extension Stores

- Pesquisa, detalhes, capitulos e paginas das surfaces ativas agora atravessam
  `SourceRuntime/SuwayomiAdapter`. A ponte tipada `sourceOperations.ts` preserva
  os DTOs usados pela UI, cache, Reader, Library Update, migration e
  reconciliation sem manter documentos GraphQL live nesses consumidores.
- GraphQL direto permanece permitido para estado local do Suwayomi, downloads,
  categorias, tracking e outras operacoes administrativas. O gate estatico
  reprova qualquer nova referencia de producao a `FETCH_SOURCE_MANGA`,
  `FETCH_MANGA`, `FETCH_CHAPTERS` ou `FETCH_CHAPTER_PAGES` fora da implementacao
  do runtime e do catalogo Legacy de queries.
- O profile V23 usa Extension Stores oficiais. `extensionRepos` permanece
  somente no profile de compatibilidade V21 e no catalogo Legacy; nenhuma UI
  ativa escreve essa configuracao diretamente.
- URLs de stores usam canonicalizacao conservadora compartilhada: scheme, host,
  porta padrao, fragmento e barra final sao normalizados. Paths e query values
  distintos continuam distintos, e URLs com credenciais ou protocolos fora de
  HTTP(S) sao rejeitadas.
- A classificacao separa ABI/classloader, serialization, source obsoleta,
  parser/site, anti-bot, autenticacao, rate limit e rede. Uma falha identica em
  GraphQL e adapter apenas exclui a transformacao do adapter como causa unica;
  nao determina sozinha o proprietario.
- Library, progresso, bookmarks, categorias, downloads, paginacao, cancelamento
  e source IDs nao foram migrados nem reescritos. O Extension Manager oficial
  continua sendo o unico mecanismo de descoberta e instalacao.
- Testes focados cobrem conversao dos DTOs, ordenacao de paginas, fronteira
  estatica, canonicalizacao, classifications, Browse, migration e Library
  Update. Nenhum website real e necessario para o gate do SR12.

### SR13 - Anti-bot delegado e gate final

- O Aethon gerencia somente instalacao, configuracao, disponibilidade e
  lifecycle do FlareSolverr. No dominio manga/Suwayomi, o unico request direto
  do Aethon ao servico e o health check local `sessions.list`; websites,
  cookies, sessoes e parsing continuam exclusivamente sob Suwayomi e suas
  extensoes.
- FlareSolverr so e elegivel quando a classificacao normalizada for
  `ANTIBOT_CHALLENGE`. ABI/classloader, serialization, source obsoleta, parser,
  autenticacao, 404 e falha de rede comum nao habilitam nem sugerem o servico.
- A espera de startup deixou de usar pausa fixa e passou a polling limitado:
  uma instancia, tentativas sequenciais, timeout por probe e ativacao da
  configuracao somente depois de `sessions.list` saudavel.
- O fluxo comum de Settings usa o mesmo coordenador de start, readiness,
  ownership, persistencia e cleanup. Nao existe mais sleep fixo nem ativacao
  depois de um health check ignorado.
- O executavel local agora possui manifesto atomico de ownership com PID,
  creation time e caminho exato. A arvore e atribuida imediatamente a um
  Windows Job Object com `KILL_ON_JOB_CLOSE`; o processo nasce suspenso, entra
  no Job e so depois e retomado. Uma segunda instancia preserva a lease da
  instancia criadora. Processos sem lease podem ser detectados, mas nunca
  adotados ou encerrados; nao existe kill por nome.
- O container usa a imagem `v3.4.6` fixada pelo digest
  `sha256:7962759d99d7e125e108e0f5e7f3cdbcd36161776d058d1d9b7153b92ef1af9e`,
  lease aleatorio por instalacao e validacao integral da policy antes de start
  ou status. Ownership e policy sao verificacoes separadas, permitindo cleanup
  seguro de um container leased que ficou obsoleto sem reutiliza-lo. O bind e
  exclusivo em `127.0.0.1:8191`, nao reinicia automaticamente e fica limitado
  a 1 CPU, 1 GiB e 256 processos. Nome ou label publico isolado nao prova
  ownership.
- Starts concorrentes do mesmo backend sao coalescidos e o lifecycle nativo e
  serializado por mutex e lock de arquivo cross-process em start, status e
  stop. Readiness, ownership do endpoint e persistencia precisam passar nessa
  ordem. Em falha, somente uma instancia criada pela tentativa atual e
  encerrada; uma instancia preexistente nunca e removida como cleanup. Falha de
  cleanup local ou Docker e propagada, nao convertida silenciosamente em
  sucesso.
- O runtime separado de novels/LNReader nao foi alterado. Sua integracao
  existente com FlareSolverr, repositories e Syncd continua independente da
  fronteira manga/Suwayomi.
- O gate deterministico valida classificacao, delegacao, readiness, cleanup,
  ownership de processo/endpoint, policy Docker, imagem por digest e ausencia
  de scraping no controller. Ele nao inicia Chromium, nao usa websites live e
  permanece serial para limitar CPU e memoria. O workflow V23 controlado passou
  em repeticao isolada com restart, 27 source IDs estaveis, fluxo completo de
  Local Source, `websiteRequests=0` e `maxSourcesInParallel=1`. A readiness do
  Extension Manager admite ate 45 segundos apos restart por polling, sem
  aumentar workers, JVMs ou sources concorrentes.

## Estado consolidado apos o SR13

Em 28/07/2026, SR1-SR13 estao implementados e commitados. O ultimo commit da
sequencia e `40f48e5` (`test(sources): enforce extension runtime
compatibility`). O worktree e o indice estavam limpos na verificacao posterior,
sem arquivos untracked ou diff pendente.

Entregas concluidas:

- `SourceRuntime/SuwayomiAdapter` e profiles V21/V23 concentram as operacoes
  ativas de pesquisa, detalhes, capitulos e paginas.
- `v2.3.2243` permanece candidate fixado e certificado pelo SHA-256 exato; nao
  e tratada como latest nem substituida automaticamente.
- Promocao de runtime e atualizacao de extensoes usam maintenance, snapshot,
  journal, rollback e validacao sequencial, sem duas JVMs sobre o mesmo H2.
- `ExtensionUpdateCoordinator` apenas orquestra operacoes oficiais do
  Extension Manager. Nao existem classloader, scraper, conversor APK->JAR ou
  instalador paralelo no Aethon.
- Extension Stores usam canonicalizacao conservadora e preservam stores
  distintas. Proveniencia e registros de compatibilidade incluem hashes do
  runtime e do artefato.
- FlareSolverr continua opcional e desativado por padrao. Para manga, o Aethon
  configura o endpoint e o Suwayomi continua responsavel pelas requisicoes das
  extensions. Para novels, o runtime LNReader separado possui recuperacao
  propria no fetch shim quando identifica um desafio anti-bot.
- O lifecycle local do FlareSolverr valida ownership e mantem a arvore em
  Windows Job Object. O backend Docker usa imagem por digest, loopback e limites
  de CPU, memoria e processos.
- O workflow Suwayomi controlado passou com restart, 27 source IDs estaveis,
  fluxo Local Source completo, uma source por vez e zero acesso a websites.
- Os gates focados passaram com 97 testes de runtime/adapter/anti-bot, 62 testes
  frontend, 12 testes de Settings e 48 testes browser. `svelte-check` terminou
  com 0 erros e 0 avisos; Cargo, formatacao Rust e build frontend passaram.

## Pendencias atuais

### Gate local obrigatorio

- Reexecutar `pnpm release:verify` no HEAD atual para consolidar todos os gates
  de release depois dos commits SR9-SR13. Os testes proporcionais dos marcos
  passaram, mas esta execucao agregada final ainda deve produzir a evidencia
  unica do estado atual.

### Validacoes condicionais ou observacionais

- Exercitar o lifecycle real do container FlareSolverr quando Docker estiver
  disponivel. A policy deterministica passou, mas o Docker CLI nao estava
  instalado no ambiente da validacao SR13.
- Executar canarios live de sources somente como diagnostico observacional.
  Website, Cloudflare, login, rate limit, parser ou source obsoleta nao devem
  reprovar o runtime sem regressao causal comprovada contra a versao anterior.
- Validar instalacao real assinada do updater apenas no processo de release com
  manifesto, pacote e chave de producao.
- Fazer smoke opt-in de Trackers, Hardcover, Discord e proxies com servicos
  reais; transports falsos e servidores locais continuam sendo o gate
  deterministico bloqueante.
- Validar manga/fullscreen com catalogo acessivel e completar auditoria manual
  com leitor de tela.

### Melhorias futuras nao bloqueantes

- Reduzir o tempo dos testes Rust de composicao de capas Discord sem perder
  cobertura.
- Melhorar diagnosticos dos gates de tema, inventario frontend/Tauri e
  capability report.
- Continuar a politica de crescimento limitado de logs, caches, locks e
  manifests.
- Manter a concorrencia do harness Syncd como trabalho futuro, sem limitar a
  replicacao de comics, books e repositorios LNReader pelo AethonCore.

### Publicacao Git

- Na verificacao de 28/07/2026, `main` estava 155 commits a frente de
  `origin/main`. Isso nao representa codigo sem commit, mas a sequencia ainda
  precisa ser enviada ao remoto quando a publicacao for autorizada.

## Marcos 72 - compatibilidade observada e recuperacao

### 72A - Fingerprint e observabilidade

Implementado em 29/07/2026:

- O adapter passou a expor `RuntimeFingerprint` composto por versao do
  servidor, hash do schema canonico, hash das capabilities, identidade
  canonica do endpoint, nonce quando disponivel e geracao do runtime local.
- PID nao participa do fingerprint. Ele continua restrito ao ownership de
  processos locais no supervisor nativo.
- A geracao local e incrementada quando o lifecycle explicito invalida o
  adapter. Endpoints remotos ou compartilhados nao recebem essa geracao e
  continuam usando apenas a renovacao limitada por TTL; o Aethon nao controla
  restart, shutdown ou quantidade de JVMs nesses endpoints.
- O transporte possui tracing estritamente opt-in com request ID, attempt,
  stage, duracao, status HTTP, tamanho da resposta e erros GraphQL
  estruturados. Sem observer configurado nao ha sanitizacao adicional no
  caminho normal da request.
- Headers, cookies e credenciais nunca entram no evento. Queries pessoais,
  tokens e paths de usuario sao redigidos; strings, arrays, objetos,
  profundidade e stack traces possuem limites antes de chegar ao observer.
- Falhas do observer sao isoladas e nunca alteram retry, decode ou resultado
  da operacao. O runtime nao persiste traces automaticamente; persistencia
  continua dependendo de diagnostico tecnico solicitado explicitamente.
- O GraphQL oficial nao expoe redirects internos, cookies, cache ou etapas do
  parser da extension. Esses dados permanecerao `NOT_OBSERVED` nos relatorios
  futuros, sem proxy ou scraper paralelo no Aethon.

Evidencia do lote:

- 23/23 testes focados de diagnostics, transport, schema, adapter e cache.
- 67 testes do runtime aprovados e 1 contrato live opt-in ignorado.

### 72B1 - Contratos e fixture deterministica

Implementado em 29/07/2026:

- O contrato reutilizavel `runDeterministicSourceContract` valida identidade
  de source e manga, duas paginas de pesquisa, details, chapters, pages em
  ordem e propagacao do `AbortSignal`.
- Profiles V21 e V23 produzem o mesmo DTO normalizado para o fixture. As
  diferencas de fields, operations e decoders permanecem encapsuladas em
  `CompatibilityProfileV21` e `CompatibilityProfileV23`.
- Nao foi criado um scraper ou classloader de teste. O gate usa duas provas
  oficiais e complementares:
  - extension estrutural Akuma instalada pelo Extension Manager;
  - conteudo deterministico servido pela Local Source do Suwayomi.
- Para o V23, um Extension Store JSON descartavel em loopback serve o JAR
  oficial Akuma `1.4.10`, fixado na revisao
  `193dffcb8505b83858759e53f23e9157e708fd6b` e no SHA-256
  `6dc723db4b10eabfd006978b54407faec410405c5b23d213ebfc90fe3bb23d6d`.
  A instalacao usa `fetchExtensions` e `updateExtension`; upload externo sem
  store foi rejeitado como fixture porque nao sobrevivia a reconciliacao no
  restart.
- O harness continua exclusivo de perfis locais descartaveis: uma JVM e uma
  source por vez. Nenhuma regra de restart, shutdown ou quantidade de JVM e
  aplicada a runtimes remotos ou compartilhados.

Evidencia do lote:

- 6/6 contratos Node do fixture/store.
- 16/16 contratos Vitest de DTO, profiles, transport e pagination.
- Workflow nativo V23 aprovado com install e restart, 27 source IDs estaveis,
  fluxo Local Source completo, `websiteRequests=0` e
  `maxSourcesInParallel=1`.

### 72B2 - Relatorios de compatibilidade observada

Implementado em 29/07/2026:

- O estado atomico de compatibilidade foi migrado do schema V1 para V2. Os
  registros fortes de artefato/runtime permanecem intactos e uma nova colecao
  limitada a 64 relatorios por perfil guarda execucoes observadas. Estados V1
  sao carregados sem inventar relatorios ou evidencias.
- Cada relatorio identifica perfil, package, versao, adapter, runtime,
  endpoint canonico, escopo local/remoto, trigger, source e timestamps. Hashes
  desconhecidos permanecem `null`; nao sao substituidos por valores
  presumidos.
- Estagios deterministas usam `PASS`, `FAIL`, `SKIPPED`, `UNSUPPORTED`,
  `NOT_OBSERVED`, `TIMED_OUT`, `CANCELLED` ou `INCONCLUSIVE`. O agregado usa
  `PASS`, `FAIL`, `DEGRADED`, `INCONCLUSIVE` ou `CANCELLED`.
- Falha determinista bloqueia o agregado. Falha, timeout ou informacao
  indisponivel em estagio observacional produz no maximo `DEGRADED` ou
  `INCONCLUSIVE`; nao transforma website live em gate estrutural.
- O `ExtensionUpdateCoordinator` cria relatorio estrutural somente para a
  combinacao runtime/artefato que acabou de passar pela certificacao oficial.
  O coordinator continua apenas orquestrando o Extension Manager do Suwayomi.
- O probe live e iniciado exclusivamente pelo usuario em Sources. Ele consulta
  uma source registrada por vez, usa o endpoint existente e nunca reinicia,
  limita ou cria staging em runtime remoto/compartilhado.
- Escopo `LOCAL_OWNED` nao e inferido por loopback: o frontend consulta o status
  nativo, que comprova ownership e JAR efetivo. Falha, evidencia incompleta ou
  runtime attach-only usam o fallback conservador `REMOTE_SHARED`.
- Falha ao ler o arquivo opcional de evidencias nao impede o carregamento do
  inventario oficial de extensions.
- HTTP interno, cookies, redirects e parser da extension nao sao expostos pela
  API oficial. O relatorio registra esses dados como `NOT_OBSERVED`, sem proxy,
  parser ou scraper paralelo no Aethon.
- Sources mostra somente o resumo mais recente. Runtime, adapter e estagios
  ficam dentro do painel progressivo de configuracao da extension. Nenhum
  stack trace, payload, token, cookie ou caminho privado e mostrado no fluxo
  principal.
- Strings de evidencia recebem limites e redaction antes da persistencia. O
  sanitizador central passou a remover tambem secrets embutidos em texto, como
  `Authorization: Bearer ...` e `token=...`.

Limitacoes:

- O perfil descartavel de componente nao possui historico real de
  certificacao; a presenca e a atualizacao do resumo sao cobertas por testes de
  modelo/coordinator. Screenshots reais nao devem receber registros
  artificiais apenas para forcar o estado.
- O probe live certifica apenas a execucao observada da primeira source
  registrada para a extension. Ele nao declara todas as sources ou websites
  universalmente funcionais.

Evidencia:

- 38/38 testes focados de health, redaction, registro, coordinator e probe.
- 19/19 testes de montagem `BrowseV3 -> SourcesView` e 3/3 gates de tokens de
  Sources.
- `docs/screenshots/marco72b2-compatibility/before-observed-report.png` mostra
  o painel ativo antes da nova execucao observacional.
- `docs/screenshots/marco72b2-compatibility/after-observed-report.png` mostra
  o mesmo painel com resumo `DEGRADED` e estagios expandidos. O agregado
  degradado e esperado: pesquisa live passou, enquanto HTTP/parser internos
  ficaram corretamente `NOT_OBSERVED`.
- O smoke WebView2 mediu painel integralmente dentro do viewport,
  `horizontalOverflow=0`, largura visivel de detalhes `273.6875px` e quatro
  estagios. O primeiro screenshot imediato apresentou repaint incompleto e foi
  substituido; a evidencia final aguarda dois frames e 500 ms de estabilidade.
- O smoke usa uma unica source, fecha driver/app e remove o perfil temporario.
  O processo Suwayomi preexistente nao e reiniciado nem encerrado.
- `--local-app-data-dir` redefine `APPDATA` e `LOCALAPPDATA` antes do estado
  Tauri; o relatorio do smoke foi persistido somente no perfil descartavel e
  removido com ele.

### 72C - Preferences oficiais

Implementado em 29/07/2026:

- O adapter passou a consultar e atualizar as preferences oficiais expostas
  pelo Suwayomi. O contrato cobre checkbox, switch, list, edit text e
  multi-select; tipos futuros desconhecidos sao preservados como
  `UnsupportedPreference`, sem coerção ou perda silenciosa.
- As capabilities distinguem `unsupported`, `read-only` e `read-write`. A
  escrita somente e habilitada quando schema, query, mutation, payload e inputs
  necessarios estao presentes.
- Toda mutation valida source, position, key, tipo, valor e opcoes permitidas.
  Depois da tentativa, uma nova query confirma o estado efetivo. Resposta
  ambigua so e aceita quando o refresh comprova o valor solicitado.
- A UI de Sources deixou de usar `mockSettingsStore` e `sessionStorage` para
  controles ficticios. O arquivo Legacy foi removido somente depois da busca
  global confirmar zero consumidores.
- Extensoes com varias sources carregam sob demanda apenas o grupo selecionado.
  A extensao Comick observada possuia 41 sources, mas o DOM manteve somente um
  grupo ativo com 11 controles, evitando hidratar centenas de campos.
- LNReader continua read-only e usa `source.settings.read` apenas quando o
  usuario abre o painel. `source.settings.write` permanece fora da allowlist e
  nao foi substituido por outra mutation generica.
- `visible` e preservado no DTO, mas nao esconde automaticamente preferences:
  o runtime observado reporta esse campo como falso para controles validos.
- Nenhuma mutation foi enviada ao perfil real durante a validacao visual.

Evidencia:

- 28/28 testes focados de schema, decoder, adapter, relatorio e runtime LNReader.
- 6/6 testes de UI e contrato de tokens de Sources.
- `svelte-check`: zero erros e zero warnings.
- Build web e build nativa de automacao aprovadas com um job.
- Smoke WebView2 aprovado com `availableSourceCount=41`,
  `preferenceGroupCount=1`, `preferenceRowCount=11`,
  `editableControlCount=11`, zero campos de credencial ficticios, zero overflow
  horizontal e painel integralmente dentro do viewport.
- `docs/screenshots/marco72c-preferences/before-fake-settings.png` registra o
  painel anterior com configuracoes locais sem efeito no runtime.
- `docs/screenshots/marco72c-preferences/after-manga-preferences.png` registra
  os controles oficiais do Suwayomi no Nocturne.

Limitacoes e riscos:

- O perfil descartavel nao possuia plugin LNReader instalado. O estado visual
  read-only nao foi artificialmente fabricado; o boundary e coberto pelos
  testes do runtime host e pelo gate que proibe `source.settings.write`.
- Algumas execucoes iniciais do harness demoraram ao importar a rota lazy de
  Search, sem erro JavaScript e sem relacao com a consulta de preferences. A
  repeticao final carregou os recursos em milissegundos e aprovou o smoke. Essa
  variacao permanece registrada para a instrumentacao de startup do 72G1/72H.

### 72D1 - Journal e transacao local

Implementado em 29/07/2026:

- O estado persistido foi promovido de V1 para V2. Operacoes V2 possuem
  `operationId`, `profileId`, revision, expected revision, status granular,
  steps tipados e manifesto de snapshots.
- Journals V1 continuam legiveis e seus payloads de undo sao convertidos em
  memoria sem perda. A gravacao seguinte usa V2; nenhuma reescrita ocorre
  apenas por abrir o arquivo.
- Os estados agora distinguem planejamento, aplicacao, verificacao, commit,
  cancelamento, compensacao, rollback local, recovery, necessidade de reparo
  manual e corrupcao.
- A compatibilidade de UI ainda traduz `committed` para `applied` e
  `compensated` para `undone`, preservando os fluxos existentes enquanto o
  coordinator V2 e introduzido no 72D2.
- A persistencia nativa deixou de truncar diretamente o JSON. Um modulo Rust
  dedicado valida o schema, serializa writes dentro e entre processos, grava
  WAL `PREPARED`, sincroniza WAL e target, publica por replace atomico com
  write-through no Windows, confirma `COMMITTED` e remove o WAL.
- Recovery compara o SHA-256 atual com as revisoes anterior e nova. Uma
  interrupcao antes da publicacao conclui a escrita preparada; uma revisao
  desconhecida interrompe o fluxo e preserva o WAL para diagnostico.
- O command usa compare-and-swap pelo SHA-256 lido pelo frontend. Uma segunda
  janela com revisao antiga nao sobrescreve uma operacao mais recente.
- Updates de operacao tambem podem exigir revision exata. Steps malformados
  nao sao descartados: a operacao e preservada e marcada como `corrupt`.
- JSON, WAL ou schema corrompido agora produz erro. O frontend nao converte
  mais falha de leitura ou parse em journal vazio.

Evidencia:

- 16/16 testes focados de journal, manga e novel migration.
- 5/5 testes Rust de write/read, recovery `PREPARED`, compare-and-swap, hash
  divergente e schema corrompido.
- `svelte-check`: zero erros e zero warnings.
- `cargo fmt --check`: aprovado.

Limite intencional do lote:

- Os fluxos existentes ainda constroem o registro de compatibilidade depois
  dos efeitos. O 72D1 entrega o contrato e a durabilidade; o 72D2 movera
  `planned` para antes de qualquer mutation, adicionara mutex por perfil,
  checkpoints idempotentes e recovery/compensacao pelo coordinator. Ate esse
  lote, nenhuma promessa de transacao distribuida e feita.
