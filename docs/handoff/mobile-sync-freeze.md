# Handoff: app mobile trava após sync com o desktop

Branch: `claude/mobile-sync-db-freeze` (a partir de `main` em `d0a712c`, release desktop 0.0.16 / mobile 0.1.0-alpha.18).
Sessão anterior: na nuvem, sem acesso ao celular nem a emulador. Nada aqui foi verificado em aparelho.

## Problemas relatados pelo usuário

1. **Mobile trava de vez após sincronizar.** Sequência: parear e sincronizar com o desktop → na tela de sync
   tocar em "Continuar em segundo plano" → minimizar/fechar o app → abrir de novo. Depois disso:
   - entrar em **Configurações → Epigraph Core** congela o app;
   - a **Library** fica travada indefinidamente depois de tocar em qualquer item;
   - **fechar e abrir o app não resolve**.
2. **Com a rede ligada o app quebra de novo**, mesmo depois de **esquecer o pareamento** nas opções do Core.
   **No modo avião o app funciona.** Ou seja: o gatilho depende de rede e **não** depende só de estar pareado.
3. **O desktop demora muito para sincronizar.** O usuário suspeita que fechar o desktop durante o envio/recebimento
   (ou depois de sincronizado) contribui para o problema.
4. Contexto de sessões anteriores: o sync deve ter prioridade de progresso entre desktop↔mobile, desktop↔desktop e
   mobile↔mobile. **Já funcionava antes; não quebrar.** Uma sessão anterior também tratou "biblioteca de comics vazia no
   desktop após sync" (importar o estado do dispositivo mais completo quando o outro está vazio).

## O que foi mudado nesta branch (commit `51ab4b3`)

| Arquivo | Mudança | Por quê |
| --- | --- | --- |
| `mobile/app/src/main/java/yokai/core/di/AppModule.kt` | `db.enableWriteAheadLogging()` em `onConfigure` | O WAL era ligado só por `PRAGMA journal_mode = WAL`. Isso não aumenta o pool de conexões do Android (`SQLiteConnectionPool` só abre mais de uma conexão com `ENABLE_WRITE_AHEAD_LOGGING`). Com uma conexão só, **toda leitura** (Library, tela do Core) esperava qualquer transação do sync terminar. Escritas continuam serializadas numa conexão. |
| `mobile/app/src/main/java/epigraph/sync/core/replica/CoreReplicaApplier.kt` | `applySnapshot` ignora snapshot cuja versão é `<=` ao checkpoint já salvo (antes era `<`); log `snapshot transaction: scope=… entities=… tombstones=… ms=…` (sem payload) | Na abertura, o `EpigraphCoreSyncWorker` e o `CoreLiveEventSupervisor` (SSE) podem baixar e projetar **o mesmo snapshot** duas vezes, segurando o banco em dobro. O log mostra quanto tempo a transação segura o banco. |
| `mobile/app/src/main/java/epigraph/sync/core/replica/epigraphCoreDomainProjection.kt` | `replaceScope`: `previousRecords.associateBy { it.key }` em vez de `firstOrNull` por tombstone | Era O(tombstones × registros) dentro da transação do snapshot. |
| `mobile/app/src/test/java/epigraph/sync/core/replica/CoreReplicaApplierTest.kt` | Fake ganhou `latestCheckpoint`; 2 testes: mesma versão não reprojeta, versão mais nova ainda aplica | Contrato da mudança acima. |

**Testes: NÃO rodaram.** O container não tinha Android SDK (foi instalado), e o Gradle ficou bloqueado por HTTP 429 do
Maven Central. Rodar localmente antes de qualquer coisa:

```
cd mobile
./gradlew :app:testDevDebugUnitTest --tests "epigraph.sync.core.replica.*"
./gradlew assembleDevDebug
```

## Análise feita (código, sem log do aparelho)

### Por que o banco fica preso por muito tempo
- `CoreReplicaApplier.applySnapshot` aplica o escopo inteiro numa transação: `replaceConfirmedScope` + `projectScope`
  (projeção de cada registro em mangas/capítulos/progresso, cerca de 10 a 20 queries por registro) + checkpoint.
  Com uma biblioteca grande (muitos `comic.chapter_state`), isso pode levar minutos.
- Se o app é fechado ou morto no meio, a transação é revertida e, na próxima abertura, worker e SSE recomeçam do zero
  (`CoreLiveEventSupervisor.initialSession` sem checkpoint → snapshot). Isso explica "fechar e abrir não resolve".
- `applyChanges` aplica a resposta inteira de `/v1/changes` numa transação só.
- `SuwayomiCatalogSync.synchronize` reprojeta **toda a biblioteca de comics** numa transação a cada execução do worker
  (abertura do app, a cada 15 min e a cada wake de outbox). Provavelmente segundos, mas é recorrente.
- Mesmo com o WAL corrigido, **escritas da UI** (por exemplo, abrir uma obra que grava capítulos) ainda esperam essas
  transações terminarem.

### O que roda na abertura do app
- `App.onCreate` → `EpigraphCoreSyncWorker.setup` (worker `APP_START`) e `CoreLiveEventSupervisor.start` (SSE).
- O worker roda `repairLibraries()` (`LocalComicLibraryOutboxRepair`, `LocalNovelLibraryOutboxRepair`,
  `EpigraphReaderProgressRouter.backfillComicProgress`) **antes** de checar a conexão, e de novo após o primeiro run.
  `LocalComicLibraryOutboxRepair` chama `sources.awaitExtensionSource()` (até 5 s) **por favorito** sem identidade.
- `CoreConnectivityWakeMonitor` reenfileira o worker quando a rede volta.

### Problema 2 (rede ligada, mesmo sem pareamento): ainda sem causa confirmada
Sem credencial, o worker do Core termina cedo (`CoreOutboxSyncRunner.run` → `credential == null`), e o SSE fica em
espera. Então o travamento com rede **não é explicado só pelo sync**. Candidatos que disparam com rede:
- `LibraryUpdateJob`, `DownloadJob`, `ExtensionUpdateJob`, `DelayedTrackingUpdateJob`, `AppUpdateJob`;
- `NovelPluginManager` e o índice de repositórios (repos de novel e de extensões trazidos do desktop no sync);
- capas `SuwayomiCoreThumbnailReference` via `MangaCoverFetcher` → `EpigraphCoreCoverClient` (com pareamento e desktop
  fora do ar, `resolveEndpoint` serializa por mutex e não guarda falha em cache, então cada capa espera o timeout);
- obras com `source == EpigraphCoreSource.ID` que ficaram na biblioteca depois de despareado;
- confirmar se "esquecer pareamento" realmente concluiu: `EpigraphCorePairingController.disconnect` usa o mesmo mutex
  `operation` que `refresh()`; se a tela do Core estava travada, o disconnect pode não ter rodado.

**Não implementar correção para o problema 2 sem antes ver o log.** É fácil quebrar o que funcionava.

## Próximos passos sugeridos (com o celular plugado)

1. Rodar os testes acima e instalar um build desta branch (`assembleDevDebug`).
2. Capturar o travamento:
   ```
   adb logcat -c
   # abrir o app no modo avião → desligar o modo avião → esperar travar → tentar abrir a Library ou o Core
   adb logcat -d > epigraph-log.txt
   adb bugreport epigraph-bugreport.zip
   ```
   No bugreport, ler os traces de ANR (`FS/data/anr/`) para ver **qual thread segura o quê**: a thread principal
   esperando conexão do SQLite (`SQLiteConnectionPool.waitForConnection`), um lock do Koin, ou outra coisa.
3. No logcat, procurar as tags `EpigraphCoreSync`, `EpigraphCoreLiveEvents` e `EpigraphCoreCatalog`, e a linha
   `snapshot transaction: … ms=` (duração da transação do snapshot).
4. Se a causa for transação longa de escrita: aplicar o snapshot em partes, sem perder a semântica autoritativa.
   Proposta: upserts em lotes primeiro, e só no fim (transação curta) remover o que ficou obsoleto e salvar o
   checkpoint. Os registros antigos só seriam apagados no fim, então uma interrupção não perde o diff. **Pedir
   aprovação do usuário antes**: muda o desenho "tudo ou nada" do replica.
5. Investigar a demora do desktop no sync (`src-tauri/src/syncd/`, `syncd_replication.rs`) e o cenário "desktop
   fechado no meio do envio".

## Contornos para o usuário enquanto isso
- Usar o app no modo avião, ou bloquear Wi-Fi e dados só para o Epigraph nas configurações do Android.
- **Não** usar "Limpar dados" do app: apaga a biblioteca local.
