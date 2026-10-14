# Refatoração do fluxo de atualização do runtime Suwayomi

Status: em implementação (M1–M3). M4 é opcional e fica como continuação.

## 1. Problema

A atualização do runtime (o JAR do Suwayomi-Server) troca diretórios por `rename`.
O fluxo é `staging/<v>` → `current/`, e o antigo `current/` vai para `previous/`.
Um `update-journal.json` registra o progresso, e só o processo desktop sabe executar a recuperação.

Problemas encontrados no código atual (`src-tauri/src/suwayomi_update.rs`):

| # | Problema | Consequência |
|---|----------|--------------|
| P1 | A recuperação de um journal interrompido só roda no spawn do desktop (`recover_suwayomi_update_before_spawn`). O perfil **main** é iniciado pelo Core (`ensure_main_owned_instance`), que nunca chama essa recuperação. | Se o desktop fecha ou trava no meio de um update do main, o Core volta a subir o Suwayomi com o que estiver em `current/`, que pode ser o JAR candidato não verificado, sem restaurar o snapshot. O journal fica órfão. |
| P2 | Um `extension-update-journal.json` do main só é recuperado no spawn do desktop. Esse caminho não existe para o main. | `certify_suwayomi_extension_update_batch` recusa para sempre ("An interrupted extension update must be recovered…"). |
| P3 | `current/` é um diretório global, compartilhado por todos os perfis. A promoção renomeia `current/` → `previous/` e `staging/` → `current/`. | No Windows, um rename falha se outro perfil tiver um JVM com o JAR aberto. Um crash entre os dois renames deixa `current/` ausente ou parcial (estado "rasgado"), e há código específico só para remendar isso (`restore_previous_runtime_if_current_is_incomplete`). |
| P4 | O ponto de decisão "qual JAR roda" está espalhado por três lugares: `lib.rs::managed_suwayomi_runtime_jar_path`, `suwayomi_update.rs::managed_runtime_jar_path` e `syncd/suwayomi_process.rs::resolve_headless_runtime`. Cada um olha `current/` diretamente. | Não há como dizer "esse JAR ainda está em teste": o JAR fica ativo para todos no instante do rename. |
| P5 | Entre o desktop morrer e a recuperação acontecer, o proxy do Core e os comandos do app aceitam mutações. | Escritas no banco do perfil podem ocorrer sobre um runtime não verificado, e o snapshot depois as desfaz silenciosamente. |
| P6 | A posse é dividida: o Core é dono do JVM do main e o desktop é dono da transação. | Sem um "decisor" sobrevivente, nenhum processo conclui a reversão. |

## 2. Como os updaters maduros resolvem

* **Android A/B (update_engine + bootloader).** O sistema instala no slot inativo e marca esse slot como "boot uma vez". Só depois que o sistema sobe e se declara saudável o slot é marcado como *successful* (Boot Control HAL). Se isso nunca acontecer, o **bootloader**, que sempre roda e é independente de quem instalou, volta ao slot anterior. A proteção contra rollback só avança após a marcação.
  Fontes: https://source.android.com/docs/core/ota/ab e https://source.android.com/docs/security/features/verifiedboot/boot-flow
* **Chromium updater.** As versões ficam lado a lado em subdiretórios versionados e só uma está "ativa". A ativação é uma troca de registro (um ponteiro), não uma cópia, e um diretório versionado reaproveitado é apagado antes do uso.
  Fontes: https://chromium.googlesource.com/chromium/src.git/+/HEAD/docs/updater/design_doc.md e https://chromium.googlesource.com/chromium/src/+/11ae6639a/chrome/browser/first_run/upgrade_util_win.cc
* **Velopack.** Substitui `current/` inteiro, sem rollback automático em falha. É justamente o modelo que nos traz problemas.
  Fontes: https://docs.velopack.io/packaging/operating-systems/windows e https://docs.velopack.io/integrating/overview
* **Escrita atômica no Windows.** O padrão aceito é arquivo temporário + `MoveFileExW(MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)`. A atomicidade não é garantida formalmente pela documentação, por isso precisa de teste de interrupção. Esse é o mesmo primitivo que já usamos em `suwayomi_maintenance::atomic_replace_file`.
  Fontes: https://antonymale.co.uk/windows-atomic-file-writes.html, https://mail.openjdk.org/pipermail/nio-dev/2023-February/013253.html e https://gitlab.haskell.org/ghc/ghc/issues/2298

Lições aplicadas:

1. **Instalar ao lado, ativar por ponteiro.** O único passo de commit é a troca atômica de um arquivo pequeno. Não renomeamos diretórios em uso.
2. **"Tentativa" ≠ "confirmado".** O candidato só roda sob a manutenção que o testa. Quem sobe o servidor fora dela sempre usa a versão confirmada, como o bootloader faz.
3. **O decisor de fallback é o processo que sobrevive.** Para o main, quem sobrevive é o Core (o supervisor). Ele detecta a tentativa abandonada e a reverte, sem depender do desktop.
4. **Toda etapa é idempotente.** Reexecutar recuperação ou rollback a partir de qualquer ponto leva ao mesmo estado.

## 3. Arquitetura alvo

### 3.1 Layout em disco

```
%APPDATA%/epigraph/suwayomi-runtime/
  versions/<vX.Y.Z>/Suwayomi-Server.jar   # imutável depois de publicado
  versions/<vX.Y.Z>/runtime-version.json  # proveniência (sha256, release)
  runtime-state.json                      # ponteiro atômico (abaixo)
  staging/<v>/                            # download verificado, como hoje
  update.lock, diagnostics/, restore-operations/ …  # inalterados
  current/, previous/                     # legado: migrado e removido
```

`runtime-state.json` (schema 1), sempre gravado por temp + `atomic_replace_file`:

```json
{
  "schemaVersion": 1,
  "confirmed": "v2.3.2243",            // null = JAR embutido no app
  "previousConfirmed": "v2.1.1867",    // null = embutido
  "pending": {                          // tentativa em andamento, ou null
    "operationId": "…", "version": "v2.3.2243",
    "profileId": "main", "rootDir": "…", "serverUrl": "…",
    "snapshotPath": "…", "startedAtMs": 0
  },
  "updatedAtMs": 0
}
```

### 3.2 Resolver único (`suwayomi_runtime_store::resolve_managed_jar`)

Entrada: a raiz do runtime e a raiz do perfil que vai subir. Saída: o JAR gerenciado, ou `None` para usar o embutido.

1. Se existe `pending`, ele é para esta raiz de perfil **e** o runtime está em manutenção exclusiva (lease exclusivo deste processo ou de outro), retorna `versions/<pending>`.
2. Senão, se existe `confirmed` e o JAR existe, retorna `versions/<confirmed>`. Se ele sumiu, usa o embutido e registra um aviso.
3. Senão, se existe o legado `current/Suwayomi-Server.jar`, retorna esse JAR (só até a migração).
4. Senão, `None` (embutido).

Os três pontos de resolução passam a chamar o resolver: o desktop (`lib.rs`), o status/detecção de modo (`suwayomi_update.rs`) e o Core (`suwayomi_process.rs`).
Consequência direta: **nenhum processo fora da manutenção consegue subir o JAR em teste**. Isso resolve P4 e a parte "sobe o candidato" de P1.

### 3.3 Transação de instalação (substitui a dança de renames)

Tudo roda sob o lease exclusivo (`begin_exclusive_maintenance`, fase `Updating`):

1. Pré-condições: o runtime é gerenciado, o staging foi validado contra o allowlist/SHA e o snapshot é válido.
2. Parar o runtime do perfil (para o main, handoff `Stop` ao Core, como já existe).
3. Migrar o layout legado, se houver (seção 3.6).
4. Publicar `staging/<v>` → `versions/<v>`. É idempotente: se a versão já existe, o SHA é verificado; se o diretório existe mas está inválido e não é a versão confirmada, ele é apagado e recriado. **Nunca** apagamos a versão confirmada.
5. Gravar `pending` no ponteiro. Este é o ponto de "boot uma vez".
6. Migrar `server.conf` (`extensionRepos` → `extensionStores`), coberto pelo snapshot.
7. Subir o runtime. O resolver entrega o JAR pendente porque estamos em manutenção.
8. Verificar: o JVM usa `versions/<v>/…jar`, a janela de estabilidade passa e o health GraphQL responde com a versão.
9. **Commit**: uma única gravação atômica do ponteiro, com `confirmed = v`, `previousConfirmed = antigo` e `pending = null`.
10. GC best-effort de versões que não são `confirmed` nem `previousConfirmed`. Versões em uso por outro JVM falham ao apagar e ficam para o próximo GC. Também removemos o legado `previous/` e `.previous-replaced-*`.

Rollback (falha em 6–8), sempre nesta ordem, para ser idempotente:

1. parar o runtime;
2. restaurar o snapshot na raiz do perfil;
3. limpar `pending` (gravação atômica);
4. subir a versão confirmada;
5. rodar o health.

Se o processo morrer em qualquer ponto, o estado em disco é sempre um destes:

* sem `pending`: nada a fazer. A versão nova, se publicada, só vira lixo coletável;
* `pending` presente: a recuperação (3.4) faz o rollback.

Como não há renames de diretório no caminho crítico, um JVM de outro perfil segurando o JAR antigo não interfere. Isso resolve P3.

O contrato dos comandos Tauri não muda. `currentPath` passa a ser `versions/<v>` e `previousPath` passa a ser `versions/<previousConfirmed>`, ou `null` quando for o embutido.

### 3.4 Recuperação pelo processo sobrevivente

`suwayomi_runtime_store::recover_abandoned_pending(runtime_root, profile_root, stop)`:

1. Lê o ponteiro. Se não há `pending`, ou ele é de outra raiz, retorna.
2. Se algum processo segura o lease exclusivo, a tentativa **não** está abandonada (alguém está testando): retorna.
3. Toma o lease exclusivo (fase `Recovering`) e relê o ponteiro (double-check).
4. Para o JVM daquela raiz, se estiver rodando. O dono prova a posse; nunca matamos por nome ou porta.
5. Restaura o snapshot na raiz. Se o snapshot estiver inutilizável, o ponteiro é revertido mesmo assim, o registro fica em `diagnostics/` e o erro vai para o log. Nunca ficamos travados.
6. Limpa `pending`.

Quem chama:

* **Core**: no início de `ensure_main_owned_instance`, antes do lease compartilhado, para a raiz do main. Como o supervisor roda a cada 1–15 s, a reversão acontece sozinha mesmo com o desktop fechado. Resolve P1 e P6.
* **Desktop**: em `recover_suwayomi_update_before_spawn`, para os perfis que o próprio desktop sobe.

### 3.5 Portão de operações durante uma tentativa pendente

`begin_operation` (comandos do app) e o caminho de mutação do proxy do Core (`execute_graphql_document`) passam a recusar com o erro de manutenção (retryable) enquanto houver `pending` para aquele perfil.
Quem consegue o lease compartilhado sabe que não há detentor exclusivo, então um `pending` ali é necessariamente uma tentativa abandonada, que a recuperação vai desfazer em seguida. Resolve P5.
`try_acquire_shared_file_lease` em si não muda, para não criar travamentos globais.

### 3.6 Migração do layout legado

A migração roda só com o runtime parado e sob o lease exclusivo, na primeira instalação ou recuperação depois do upgrade do app:

1. Se existe `update-journal.json` não comitado, ele é recuperado com a lógica atual (`recover_runtime_directories` + snapshot) antes de qualquer outra coisa.
2. Se `current/Suwayomi-Server.jar` existe e é uma versão reconhecida, ele é copiado para `versions/<v>` (temp + rename, verificado) e o ponteiro grava `confirmed = v`.
3. `current/` e `previous/` são apagados por último, em best-effort.

Downgrade do app: uma versão antiga do app não conhece `versions/`, não encontra `current/` e usa o JAR embutido. É aceitável e fica documentado. O embutido é sempre uma versão permitida.

### 3.7 Journal de extensões do main

* Em um journal em estado não terminal (`SnapshotCreated`, `Certifying`, `Activating`, `RollbackRunning`) para o main, o Core restaura o snapshot sob o lease exclusivo e marca o journal `RolledBack`. O journal fica no disco para o desktop limpar o candidato.
* O desktop trata `RolledBack`/`Committed` como "só limpeza": para o candidato, remove o diretório do candidato, o batch root e o journal.
* `certify_suwayomi_extension_update_batch` deixa de recusar para sempre. Antes de recusar, ele tenta recuperar ou limpar (para o main, via o mesmo caminho). Só recusa se a recuperação falhar de verdade. Resolve P2.

### 3.8 Multi-perfil

O runtime é global. Só o perfil alvo sobe o `pending`, sob manutenção. Os outros perfis passam a usar a versão nova **depois do commit**, no próximo start, protegidos pelo backup preflight que já existe (`backup_local_server_files`).
Isso fica documentado. A alternativa (versão por perfil) ficou fora do escopo.

## 4. Marcos

| Marco | Conteúdo | Critério de pronto |
|-------|----------|--------------------|
| **M1** | Módulo `suwayomi_runtime_store` (sem dependência de Tauri) com o ponteiro, `versions/`, o resolver, a publicação idempotente, o GC e a migração legada, mais os testes unitários. Os três pontos de resolução passam a usar o resolver. | `cargo test` verde; um app sem estado novo continua subindo `current/` ou o embutido. |
| **M2** | Reescrita de `promote_suwayomi_runtime_update_unlocked` sobre o store (pending → commit, rollback na ordem acima, GC), com testes de interrupção em cada passo. | O E2E realtest de instalação do main passa com o layout novo. |
| **M3** | Recuperação compartilhada (Core para o main, desktop para os demais); portão de operações; recuperação e limpeza do journal de extensões do main; `certify` não bloqueia para sempre. | E2E com injeção de crash: matar o desktop após o `pending` e ver o Core reverter sozinho. |
| **M4** (opcional) | O Core executa a instalação do main via rota local, para que o update sobreviva ao fechamento do desktop. | Fica para depois. |

## 5. Estratégia de testes

* **Unitários (tempdir).**
  * Ponteiro: round-trip, schema inválido e leitura de arquivo corrompido (vira diagnóstico, nunca trava).
  * Resolver: todas as combinações de pending/confirmed/legado/embutido, com e sem manutenção.
  * Publicação: idempotência, SHA divergente e "nunca apaga a confirmada".
  * GC: preserva confirmed e previous.
  * Migração legada: com e sem `current/`, e journal antigo pendente.
  * Recuperação: pending abandonado restaura o snapshot e limpa; pending com lease exclusivo alheio não é tocado; snapshot inválido ainda limpa.
  * Interrupção: simular a parada após cada passo da transação (o estado em disco é reaberto e recuperado) e verificar a idempotência ao reexecutar a recuperação.
* **E2E realtest (WebDriver, dados isolados, sem mouse/teclado).**
  * Instalação do main: JVM em `versions/v2.3.2243/…`, ponteiro `confirmed`, sem `pending`, a mesma JVM 25 s depois e o Core inalterado.
  * Crash: marcar `pending` + snapshot com o desktop morto e ver o Core reverter sozinho (ponteiro limpo, banco restaurado, servidor de volta com o JAR confirmado).
* `git diff --check` em cada commit.

## 6. Riscos

* **`MoveFileExW` não é formalmente atômico.** Mitigação: o arquivo é pequeno, gravado com `WRITE_THROUGH`; o leitor trata JSON inválido como "sem estado novo" e o leva para diagnóstico. O pior caso volta ao JAR embutido, nunca a um travamento.
* **Antivírus segurando o JAR recém-copiado.** A publicação faz retry curto, e o GC é best-effort.
* **Espaço em disco.** No máximo duas versões ficam retidas (confirmed + previous).
* **Downgrade do app** volta para o embutido (documentado).
* **Outro perfil rodando a versão antiga durante o commit.** Ele não é afetado agora e só troca de versão no próximo start, com backup preflight.

## 7. Smoke manual

1. Configurações → Runtime → instalar a versão permitida. O servidor volta, e a versão nova aparece.
2. Fechar o app durante "verificando". Reabrir: o servidor volta com a versão anterior e a biblioteca está intacta.
3. Atualizar extensões depois de um crash no meio do batch. O batch inicia normalmente, sem a mensagem "interrupted extension update".
