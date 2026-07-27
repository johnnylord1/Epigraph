# Replanejamento do runtime Suwayomi

Status: SR3-SR6 implementados; SR7-SR8 ainda nao iniciados.

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

- Repetir startup, restart, H2 migration, Extension Stores, extensoes canario,
  biblioteca, progresso e rollback em perfil descartavel.
- Promover somente com checksum, contrato semantico e health aprovados.
- Atualizar allowlist e `maxTestedVersion` apenas neste marco.
- Commit: `test(sources): certify suwayomi 2.3 runtime migration`.

### SR8 - Gate final

- Consolidar cargo test, svelte-check, build, adapter contract, runtime health,
  extension canaries, updater safety, cleanup e git diff check.
- Documentar limitacoes externas e resultados; nao criar lista de centenas de
  extensoes.
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

Pendencias: certificacao destrutiva controlada da promocao da `v2.3.2243` no
SR7 e consolidacao do gate final no SR8. A versao permanece fora da allowlist
ate essa evidencia existir.
