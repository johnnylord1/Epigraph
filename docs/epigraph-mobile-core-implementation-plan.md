# Plano de implementação — Epigraph Mobile e Epigraph Core

Status: contrato em execução. A bridge desktop, o consumidor mobile de catálogo,
a réplica Syncd V3, a reconciliação de extensões e a fila de mutations oficiais
de comics estão implementados. O smoke Desktop↔Android de 09–10/08/2026
confirmou 631 obras materializadas, categorias e Books. A drenagem durável de
capas e o relink local por package/source foram implementados e cobertos por
testes, mas trackers, capítulos last-known-good e a independência completa de um
Device B limpo após desemparelhar ainda não estão certificados de ponta a ponta.

## 1. Decisões fechadas

- O Epigraph Mobile é uma fork Android nativa do Hayai, mantida em um
  workspace separado.
- A base usa Kotlin, Compose, SQLDelight e o runtime do Epigraph baseado em Hayai.
- Não criar branch no repositório upstream do Hayai e não fazer push sem um
  remote de fork explicitamente autorizado.
- O desktop continua visualmente intocado. Mudanças permitidas no desktop são
  somente Core, Syncd, lifecycle, contratos, bridge invisível e testes.
- O Epigraph Core fica hospedado no PC. O PC precisa estar ligado para recursos
  online e sincronização; a janela do desktop pode permanecer fechada.
- Comics/mangás são autoridade do Suwayomi Server hospedado pelo Core.
- Novels continuam no runtime LNReader e no escopo de perfil.
- EPUB/PDF continuam no domínio de books e são os únicos arquivos transferidos
  automaticamente quando explicitamente publicados como assets.

## 2. Autoridade de dados

| Domínio | Autoridade | Caminho do mobile | O que o Syncd replica |
| --- | --- | --- | --- |
| Comics | Suwayomi do perfil hospedado | proxy GraphQL autenticado do Core | histórico e bookmarks de página; eventos complementares |
| Novels | Core/LNReader por perfil | endpoints e snapshot de `novels:profile:<id>` | entries, progresso, bookmarks, histórico, repositórios e metadados de plugins |
| EPUB/PDF | Core/Syncd global | snapshot `books:global` e asset store | metadata, progresso, bookmarks e assets explicitamente compartilhados |

O Core não lê H2 do Suwayomi para montar um catálogo paralelo e não usa IDs
internos do Suwayomi como identidade global. Para comics, a identidade de
reconciliação é derivada do fingerprint do servidor e do manga ID; a leitura
autoritativa continua sendo GraphQL.

## 2.1 Estado implementado e limites atuais

O Core anuncia `supportsSuwayomiCatalog` separadamente de
`supportsSuwayomiProxy`. A bridge de catálogo continua read-only e limitada ao
perfil autenticado. Em paralelo, o snapshot Syncd V3 já inclui `comic.entry`,
`comic.category`, `comic.category_assignment`, `comic.chapter_state`, histórico
e bookmarks de página. A bridge e o snapshot devem convergir para as mesmas
identidades server-scoped; indisponibilidade de uma trilha nunca autoriza apagar
o last-known-good produzido pela outra.

O Epigraph Mobile consome `library`, `categories` e `chapters` por paginas, materializa
as linhas locais e resolve capas por referencia autenticada do Core. Mutations
locais de Library, categorias e progresso de comics sao gravadas na mesma
transacao SQLDelight que altera o dominio e entram na fila
`epigraph_suwayomi_mutation_queue` (schema 40). O drainer usa somente os
documentos GraphQL oficiais do Suwayomi, executa uma intent por vez por perfil,
confirma o resultado com uma releitura e aplica retry limitado para falhas
transitorias. Falhas permanentes ficam bloqueadas com codigo sanitizado, sem
serem removidas silenciosamente.

Histórico e bookmarks de página continuam no Syncd como estado complementar;
catálogo, categorias, read/unread e `lastPageRead` continuam sob autoridade do
Suwayomi. O Core projeta o estado canônico aceito para o Suwayomi por outbox e
não lê o H2 como uma segunda autoridade. Categorias locais sem binding remoto
permanecem locais até existir uma identidade oficial segura.

## 3. Fluxo de pairing e bootstrap

O fluxo é simétrico nos dois sentidos (desktop → mobile e mobile → desktop):

1. O usuário abre Pairing no desktop e aprova o aparelho por QR/código.
2. O mobile valida certificado, token, perfil e capabilities.
3. O cliente verifica que o Core anuncia o proxy Suwayomi e o escopo
   `comics:profile:<paired-profile>`.
4. Repositórios e extensões de comics são consultados no Suwayomi hospedado;
   APKs nunca são instalados silenciosamente pelo app.
5. Repositórios e plugins LNReader são sincronizados no escopo de novels; os
   metadados não secretos são validados por hash e smoke test.
6. O mobile faz inventário completo de categorias, obras, bindings, capítulos,
   progresso, bookmarks, histórico, tracking, downloads e assets.
7. Categorias são criadas/atualizadas antes das associações.
8. Comics são reconciliados pela resposta GraphQL completa do Suwayomi; novels
   e books são reconciliados pelos snapshots Syncd.
9. Progresso, read/unread, bookmarks, histórico e tracking são aplicados com
   comandos idempotentes e releitura confirmatória.
10. EPUB/PDF e capítulos explicitamente publicados são transferidos somente
    após hash e materialização válidos.
11. A UI só mostra `Synced` quando não há outbox pendente, conflito ou asset
    inválido.

Resposta parcial, timeout, manutenção ou perda de rede nunca significa delete.
Deletes são tombstones/comandos explícitos e só podem ser aplicados dentro do
escopo autorizado.

## 3.1 Device Pairing / Full State Replication

### Decisão arquitetural

O pareamento é uma transferência e reconciliação de estado entre instalações,
não uma sessão remota permanente. A ordem estrita `extensões -> biblioteca` foi
rejeitada porque uma extensão ausente ou uma confirmação cancelada no Package
Installer não pode ocultar centenas de obras que já possuem metadata, progresso
e downloads válidos.

O fluxo adotado usa duas trilhas coordenadas:

```text
pairing + capabilities
  -> manifest versionado e snapshot confirmado
  -> staging e materialização atômica do last-known-good
  -> descoberta de dependências
  -> instalação/atualização oficial e visível
  -> source registry ready
  -> resolução e relink local por identidade estável
  -> trackers, rehydration e validação
  -> COMPLETE ou PARTIAL explícito
```

A materialização não espera todas as dependências. A ativação de scraping local,
updates e downloads novos espera uma source resolvida. Isso mantém a Library
visível e recuperável sem criar registros que finjam estar plenamente online.

### Manifest e preflight

O manifest é versionado, paginado quando necessário e identificado por
`serverId + profileId + snapshotId + revision`. Ele contém somente dados não
secretos necessários para planejar o restore:

- protocolo e capabilities dos dois lados;
- contagens, hashes e revisões por domínio;
- `syncEntityId`, identidade remota e tipo de conteúdo;
- source identity: ecossistema, package, source ID, idioma e URL normalizada;
- inventário de extensões carregadas, sem transmitir APK/JAR;
- categorias, relações e fingerprints de assets;
- tracker bindings públicos (`provider + remote media/edition ID`), sem tokens;
- requisitos de Books, Novels e Comics mantidos em domínios separados.

IDs locais do banco nunca atravessam a fronteira como identidade global. O
source binding usa, em ordem, `ecosystem + packageName + sourceId + normalized
URL`. `serverId + profileId + remoteId` identifica o registro no Core. Um ID
Suwayomi pode continuar no side table para bridge/replay, mas nunca é copiado
para `manga.source` de outro dispositivo por suposição.

### Materialização e estados intermediários

O snapshot completo é validado antes da aplicação. A aplicação ocorre em
transação local por domínio, preserva IDs locais existentes e grava o estado de
importação/relink de cada entidade:

```text
RECEIVED -> MATERIALIZED -> DEPENDENCY_PENDING -> SOURCE_RESOLVING
-> RELINKED -> REHYDRATING -> VALIDATED -> COMPLETED
```

Estados terminais ou retomáveis:

```text
EXTENSION_UNAVAILABLE | SOURCE_NOT_FOUND | TRACKER_AUTH_REQUIRED
RELINK_FAILED | RETRYABLE_ERROR | PARTIAL
```

Uma entidade pendente continua exibindo título, capa materializada, descrição,
capítulos conhecidos, progresso, histórico, categorias, favoritos, downloads e
bindings originais. Reexecutar a etapa é idempotente e não duplica obras,
capítulos, categorias ou trackers.

### Extensões e source resolution

O desktop publica apenas extensões efetivamente carregadas pelo Suwayomi e suas
identidades. O Android resolve packages nos repositories confiáveis do próprio
app. JAR desktop e APK Android não são intercambiáveis.

`Baixar todas` significa: atualizar catálogo mobile, enfileirar ausentes e
updates elegíveis, abrir o Package Installer visível sequencialmente e aguardar
`installedExtensionsFlow`/`SourceManager` reconhecer package e source IDs. Uma
recusa ou falha individual não bloqueia a biblioteca nem as demais instalações.

Após o registry ficar pronto, o resolver procura uma source local compatível
por package e source ID. O nome visual é apenas diagnóstico. Quando houver
match, a obra pode trocar da bridge `EpigraphCoreSource` para a source Android
local, preservando em side tables a identidade Core e o binding original. Essa
troca nunca é automática se URL ou identidade forem ambíguas.

`EpigraphCoreSource` permanece bridge/fallback enquanto pareado e permite conteúdo
Core autenticado. Ela não é a source final de uma instalação que precisa
continuar consultando capítulos após o Core desaparecer. Sem APK/plugin local,
somente metadata, capítulos e arquivos já materializados ficam disponíveis.

### Trackers

Tracker binding, estado remoto e credenciais são contratos separados:

- sincronizar `provider`, remote work/edition ID e metadata do vínculo;
- manter login, token, cookie e segredo exclusivamente por dispositivo;
- preservar o binding em `TRACKER_AUTH_REQUIRED` até login local;
- nunca recriar ou atualizar tracker por título quando já existe remote ID;
- exigir decisão explícita para edição diferente, especialmente Hardcover.

### Rehydration e offline independence

Rehydration é best-effort e nunca substitui last-known-good por vazio. Apenas
sources localmente resolvidas podem atualizar metadata/capítulos. Erro HTTP,
anti-bot, login ou parser não remove itens. Capas são assets duráveis e drenados
até zero pendências antes de o app afirmar independência completa; capítulos e
arquivos de leitura ficam offline somente após materialização/download explícito.

Books não usam Suwayomi: metadata, capa, categorias, progresso, bookmarks e
highlights são locais; EPUB/PDF usam SHA-256 e transferência sob demanda. Novels
usam seu próprio ecossistema de plugins e podem permanecer com binding pendente
quando não houver plugin compatível no destino.

Depois de remover o pairing, o receptor preserva todos os dados confirmados. Ele
consulta capítulos novos de Comics somente quando a extensão/source Android foi
resolvida; caso contrário, mantém os dados e downloads existentes sem fingir
conectividade.

### Incremental, conflitos e retomada

Depois do snapshot inicial, changes usam revision/cursor e operações explícitas
`NEW`, `UPDATED`, `DELETED`, `UNCHANGED` e `CONFLICTED`. Uma source nova adiciona
somente sua dependência e os itens afetados. Tombstone explícito é a única prova
de remoção; catálogo vazio, timeout ou snapshot incompleto não são deletes.

Cada sessão persiste `operationId`, manifest hash, etapa e resultados por
entidade. Queda após instalação retoma em source resolution. HLC/receipts
determinam o vencedor de estado mutável; conflitos não observáveis permanecem
explícitos em vez de usar ordem de chegada.

### Resultado, observabilidade e privacidade

O resultado é agregado por domínio e permite sucesso parcial honesto, por
exemplo: 473 materializadas, 469 relinkadas, 4 aguardando source e 2 trackers
aguardando autenticação. A UI só mostra sincronização completa quando não há
outbox, snapshot incompleto, asset obrigatório ou entidade pendente.

Logs usam correlation/operation ID, etapa, duração e código sanitizado. Tokens,
cookies, QR, endpoints privados, caminhos locais, payload de livro e respostas
de website nunca são persistidos.

### Gates de aceitação

O gate principal usa um Device B limpo e comprova:

1. manifest/snapshot validado e materializado sem depender das extensões;
2. extensão instalada pelo mecanismo oficial e registry reconhecido;
3. relink por package/source/URL, sem copiar database ID;
4. categorias, progresso, histórico, bookmarks e tracker bindings preservados;
5. interrupção e retomada sem duplicação;
6. falha individual produz `PARTIAL`, sem rollback destrutivo do restante;
7. após desligar A, remover o pairing e reiniciar B, a Library permanece;
8. uma obra relinkada consulta capítulos novos pela source local;
9. uma obra sem source continua visível e lê apenas conteúdo materializado;
10. Comics, Books e Novels não se confundem e nenhum segredo é transferido.

O fluxo oficial de backup/restore do Mihon é referência para preservar Library,
capítulos, categorias e tracker bindings mesmo com extensões ausentes. Epigraph
adiciona staging, identidade server-scoped, instalação assistida e retomada; não
duplica o ExtensionManager, SourceManager ou Package Installer existentes.

### Estado de implementação em 10/08/2026

Concluído neste lote:

- o manifest de Library do Core publica `packageName` da extensão junto à source;
- as capabilities do Core anunciam separadamente catálogo, conteúdo tipado e
  inventário de extensões; o mobile pode negociar cada dependência sem inferir
  suporte a partir do proxy GraphQL genérico;
- projeções posteriores preservam uma source Android já comprovadamente
  relinkada, sem voltar a obra para `EpigraphCoreSource`;
- bindings antigos com package `unknown` podem ser enriquecidos pelo inventário
  cacheado, somente quando `serverId + profileId` e binding `BOUND` coincidem;
- source IDs presentes em mais de um package permanecem `unknown`, sem escolha
  arbitrária;
- instalações e updates feitos pelo fluxo normal do ExtensionManager também
  disparam nova tentativa de relink quando o SourceManager termina o registro;
- o relink é serializado, idempotente e exige package e source ID exatos no
  registry oficial;
- uma extensão ausente mantém a obra materializada na bridge, sem apagar metadata;
- a fila de capas usa cursor persistente, timeout e lote limitado, evitando que
  uma capa quebrada bloqueie permanentemente as demais;
- wakes de conectividade substituem o único worker on-demand em backoff, sem
  acumular chains atrás de tentativas antigas.

Validação executada:

- testes focados cobrem Library com mais de 600 obras, snapshot parcial,
  preservação offline, cursor de capas, wake após reconexão e relink cacheado;
- testes do observer cobrem extensão emitida antes do registry, estado inicial
  após restart e bursts serializados sem relinks concorrentes;
- build APK `devDebug` concluída com um worker e instalada preservando o perfil;
- o app iniciou sem crash com o Core indisponível e manteve o last-known-good;
- testes Rust confirmam que o manifest desktop expõe package/source e que as
  capabilities atuais permanecem compatíveis.

Limitação real observada:

- a sessão persistida no emulador ainda aponta para um endpoint antigo e não
  conseguiu redescobrir o sidecar temporário; o worker adiou a conexão sem
  demover a Library. Esse ambiente precisa de novo pareamento para recapturar
  capas e provar a transição conectada;
- o perfil observado tinha 631 bindings `unknown`, nenhuma extensão Android
  equivalente disponível no repository local, zero capítulos materializados e
  nenhuma capa local. Portanto, ele comprova preservação de metadata, mas não o
  gate final de independência online após remover o pairing;
- `PatchTracking` existe no contrato Kotlin, mas o Syncd desktop ainda não
  materializa tracker bindings de comics. Credenciais devem continuar locais;
- estados intermediários por entidade e um relatório resumable completo ainda
  não estão persistidos como uma única sessão de importação.

Próximos gates obrigatórios:

1. parear novamente o perfil real com endpoint alcançável e drenar capas;
2. configurar um repository Android confiável, instalar ao menos uma extensão
   equivalente pelo Package Installer e provar relink + novos capítulos sem o Core;
3. implementar tracker bindings não secretos no Syncd/Core e o estado
   `TRACKER_AUTH_REQUIRED` no receptor;
4. persistir os estados resumable/partial por entidade;
5. executar o gate Device B limpo, desligar A, remover pairing, reiniciar B e
   validar Library, source local, consulta de novos capítulos e progresso.

## 4. Contratos de transporte

### Core geral

- `GET /v1/capabilities`
- `GET /v1/snapshot?scopeId=...`
- `GET /v1/changes?sinceVersion=...&scopeId=...`
- `POST /v1/mutations`
- `GET /v1/events?scopeId=...`
- `HEAD/GET/PUT /v1/assets/:sha256`

### Comics via Suwayomi

O mobile usa:

```text
POST /v1/suwayomi/api/graphql?scopeId=comics%3Aprofile%3A{pairedProfile}
```

O corpo é o envelope GraphQL oficial (`query`, `variables` e opcionalmente
`operationName`). O Core:

- valida token, device, perfil e scope;
- permite somente `api/graphql` para POST;
- mantém a lease de manutenção para mutations;
- não encaminha o bearer token nem o `scopeId` para o Suwayomi;
- bloqueia redirects, hosts externos e caminhos fora da allowlist;
- conserva códigos de erro retryable para a outbox do mobile.

Para o bootstrap read-only, o Core também oferece operações fixas e
profile-scoped, sem persistir catálogo no Syncd:

```text
GET /v1/suwayomi/catalog?scopeId=comics%3Aprofile%3A{pairedProfile}&operation=library&pageSize=100&offset=0
GET /v1/suwayomi/catalog?scopeId=comics%3Aprofile%3A{pairedProfile}&operation=categories&pageSize=100&offset=0
GET /v1/suwayomi/catalog?scopeId=comics%3Aprofile%3A{pairedProfile}&operation=chapters&mangaId={id}&pageSize=100&offset=0
```

`pageSize` é limitado pelo Core e o consumidor deve repetir a operação
enquanto `page.hasNextPage` for verdadeiro, incrementando `offset` pelo
`page.pageSize`. Cada resposta inclui `schemaVersion`, `operation`,
`generatedAtMs`, `page` (`offset`, `pageSize`, `hasNextPage`, `totalCount`) e
o campo `data` retornado pelo GraphQL allowlisted. Falha, resposta parcial ou
payload excessivo é retryable/erro e nunca significa remoção local.

`thumbnailUrl` continua sendo uma referência do Suwayomi, não uma URL pública
do dispositivo. O mobile deve resolver caminhos relativos pelo proxy
autenticado existente, por exemplo `/v1/suwayomi/api/v1/manga/{id}/thumbnail`,
reaproveitando o mesmo token/scope da sessão. Não deve acessar diretamente
endereços `127.0.0.1`, portas do runtime ou hosts retornados pelo GraphQL.

Queries mínimas da primeira vertical:

- biblioteca completa e categorias;
- manga por ID e capítulos;
- fontes e extensões disponíveis;
- estado de capítulo (`isRead`, `isBookmarked`, `lastPageRead`);
- histórico e bookmarks de página quando expostos pelo Epigraph.

Mutations oficiais atualmente cobertas pela fila:

- adicionar/remover da biblioteca;
- atribuir/remover categorias remotas já identificadas;
- marcar capítulo lido/não lido;
- atualizar bookmark e `lastPageRead`.

Criação/renomeação de categorias e downloads no servidor continuam fora desta
vertical até haver documentos oficiais, confirmação e testes equivalentes.

## 5. Ondas de implementação

### Gate 0 — proteção e baseline

- Preservar todas as alterações atuais dos dois workspaces.
- Não usar `reset`, `clean`, troca de branch ou `git add -A`.
- Confirmar que o mobile permanece em seu workspace separado e sem branch
  upstream.
- Rodar baseline de testes, migrations SQLDelight, lint e APK debug.
- Registrar quais dados já estão no Core antes de qualquer bootstrap destrutivo.

### Onda 1 — transporte e contrato de comics

- Implementar o cliente Android do proxy GraphQL do Core.
- Derivar a URL a partir da capability, sem aceitar endpoint arbitrário.
- Reusar pinning TLS e credenciais existentes; nunca logar token/cookie.
- Adicionar testes de headers, scope, body GraphQL, redirect, erro retryable e
  manutenção.
- Manter `comic.entry` bloqueado no Syncd enquanto o catálogo vier do
  Suwayomi.

### Onda 2 — gateway de biblioteca Suwayomi (implementada)

- Criar gateway tipado para biblioteca, categorias, detalhes e capítulos.
- Materializar/atualizar as linhas locais do Epigraph Mobile por binding estável.
- Comparar conjuntos completos somente depois de todas as páginas válidas; uma
  remoção da Library apenas desmarca favorite e preserva metadata, capítulos,
  progresso e assets locais.
- Persistir intents oficiais na fila SQLDelight junto com a alteração local.
- Confirmar cada mutation do Suwayomi por uma nova leitura e manter pendências
  quando o runtime estiver indisponível.
- Encaminhar apenas o estado complementar ja suportado para `comic.history` e
  `comic.page_bookmark`; read/unread e `lastPageRead` usam a fila oficial.

### Onda 3 — bootstrap ordenado

- Integrar o gateway ao fluxo de pairing/WorkManager.
- Exibir fases separadas: capabilities, extensões, categorias, obras, estado,
  assets e reconciliação.
- Pausar em confirmação do Package Installer para APKs de extensão.
- Retomar após reinício do processo, sleep, perda de rede ou Core indisponível.

### Onda 4 — leitores e offline

- Abrir comics pelo Suwayomi quando online e por download local quando offline.
- Preservar novels, EPUB e PDF já implementados, sem misturar seus scopes.
- Garantir `.part`, checksum, rename atômico e retomada para assets.
- Nunca baixar automaticamente capítulos de comics ou novels durante pairing.

### Onda 5 — Core headless

- Extrair o resolver/supervisor do Suwayomi de `AppHandle` para módulo backend
  compartilhado.
- Permitir que o Core iniciado no login do Windows crie ou reanexe o perfil
  Suwayomi com ownership comprovado.
- Manter lock por perfil e impedir dois Suwayomi concorrentes.
- Validar que fechar a janela desktop não interrompe proxy, Syncd ou Suwayomi.

### Onda 6 — certificação

- Pairing real com desktop e dois celulares.
- Add/remove, categorias, read/unread, progresso, bookmarks e histórico nos
  dois sentidos.
- PC desligado: biblioteca e outbox preservadas; conteúdo baixado continua
  legível.
- PC retornando: eventos em até 5 s na LAN e metadados convergindo em até 30 s.
- Testar token revogado, fingerprint incorreto, scope errado, replay expirado,
  mutation repetida e resposta parcial.
- Executar `flutter` não faz parte deste projeto; a validação mobile usa
  Gradle/Kotlin, testes Android e APK do Epigraph Mobile.

## 6. Critérios de aceite

Para comics, após a fila ficar ociosa:

```text
symmetricDifference(idsSuwayomiLibrary, idsMobileLibrary) == vazio
```

Além disso:

- nenhuma obra é removida por erro transitório;
- categorias e associações coincidem nos dois clientes;
- capítulo marcado como lido, bookmark e `lastPageRead` convergem;
- histórico e bookmarks de página aparecem nos dois aparelhos;
- EPUB/PDF importado em qualquer lado possui o mesmo SHA-256 após transferência;
- nenhum segredo entra em snapshot, mutation, log ou asset manifest;
- Core e Suwayomi continuam disponíveis com a janela desktop fechada;
- o desktop não sofre alteração de layout, estilo, rota ou fluxo visual.

## 7. Estado atual e riscos conhecidos

- O Core já anuncia `supports_suwayomi_proxy`, `supports_suwayomi_catalog` e
  `comics:profile:<paired-profile>`.
- O proxy Rust já valida escopo, bloqueia redirects, remove credenciais e
  aplica lease em mutations.
- O mobile já possui pairing, pinning TLS, outbox, snapshots e réplica local
  para novels/books. O transporte GraphQL/proxy de comics possui contrato e
  cobertura de fixture. O desktop oferece uma bridge read-only versionada em
  `/v1/suwayomi/catalog` para biblioteca, categorias e capítulos; o consumidor
  mobile pagina e materializa essa resposta nas tabelas e bindings existentes.
  Escritas suportadas entram na fila oficial SQLDelight e são confirmadas por
  releitura. Isso ainda não é uma certificação de sync completo.
- O Syncd atual anuncia apenas `comic.history` e `comic.page_bookmark`; as
  entidades de catálogo `comic.entry`/`comic.category` ficam planejadas e não
  devem ser ativadas sem uma decisão posterior.
- O consumidor mobile agora pagina e materializa biblioteca, categorias e
  capítulos pela bridge profile-scoped, usando as tabelas/bindings existentes;
  a migration 39 cria a fila oficial de mutations e a versão de schema 40 é
  gerada pelo SQLDelight. Não houve ativação de entidades de catálogo no
  Syncd. Capas são resolvidas sob demanda pelo Core autenticado e não ficam
  como URLs públicas do Suwayomi.
- A réplica do catálogo é independente da réplica geral: uma falha transitória
  no snapshot/replay não impede que o consumidor tente atualizar a biblioteca
  de comics na mesma execução; o resultado final continua sinalizando retry
  para que a réplica geral seja repetida.
- Ainda falta o smoke pareado com um perfil real, a validação de mutations
  GraphQL no dispositivo e a certificação do bootstrap/offline em runtime
  real. O Core também precisa extrair o spawn headless do Suwayomi para
  garantir comics online imediatamente após login do Windows sem abrir o
  desktop.

## 8. Rollback e proteção de dados

- Alterações de protocolo são aditivas e capability-gated.
- Falha no bootstrap preserva a réplica confirmada e a outbox.
- Falha na instalação de extensão mantém a versão anterior.
- Falha em asset mantém `.part` retomável e nunca publica arquivo sem hash.
- Um Core antigo continua atendendo clients apenas com capabilities conhecidas.
- Qualquer alteração visual do desktop reprova a integração e deve ser revertida
  antes dos gates de sync.

## 9. Validacao do contrato de catalogo e mutacoes

O lote atual adicionou uma fronteira de comando tipada no Core para as tres
operacoes oficiais de escrita usadas pelo mobile: atualizar a biblioteca,
alterar categorias e atualizar progresso de capitulos. O endpoint valida o
scope `comics:profile:<id>`, aceita somente operacoes allowlisted, rejeita
variaveis desconhecidas e aplica limites de lote antes de encaminhar a
mutacao ao GraphQL oficial do Suwayomi. A bridge de catalogo permanece
read-only para biblioteca, categorias e capitulos; confirmacoes continuam
usando releitura autenticada.

Validacao deterministica concluida:

- testes Rust focados de Syncd: 105 aprovados;
- testes mobile focados de projecao, cliente Core e drainer: 19 aprovados;
- `assembleDevDebug`: concluido;
- `pnpm build`: concluido;
- `git diff --check`: concluido.

O smoke pareado completo ainda nao foi certificado. O perfil salvo no
emulador era uma conexao antiga e nao pode ser tratado como prova do novo
fluxo. A tentativa de QR foi bloqueada pelo estado `System UI isnt
responding` do emulador e pela cena virtual da camera nao exibindo o QR
injetado; por isso nao foi afirmado sucesso de pairing, leitura de catalogo
ou mutacao em dispositivo real. O proximo gate deve usar um perfil
descartavel/pareamento novo, confirmar capabilities, paginar biblioteca e
categorias, executar uma mutacao de teste e confirmar o resultado por
releitura.

### Revalidacao apos reinicio do PC

- O runtime Suwayomi principal foi reiniciado pelo launcher gerenciado e
  permaneceu saudavel: `server.owner.json` correspondeu ao processo Java,
  ao executavel, ao `runId` e a `127.0.0.1:4567`; `/api/v1/settings/about`
  respondeu `200`.
- A bridge Core foi exercitada anteriormente com sessao autenticada e
  runtime pertencente ao perfil `main`: a autenticacao e a leitura paginada
  de catalogo responderam `200`. A resposta usa `data.mangas`,
  `data.categories` e `data.chapters`, exatamente os campos consumidos por
  `SuwayomiCatalogSync`.
- Quando o owner manifest ou a porta do runtime nao estao disponiveis, a
  bridge retorna `503 SUWAYOMI_CATALOG_UNAVAILABLE`; isso e o comportamento
  esperado e impede que o mobile trate indisponibilidade como catalogo vazio.
- O parser mobile foi endurecido para ignorar campos escalares com formato
  JSON incompatível, como um `JsonArray` em um campo opcional. Os testes
  focados de projecao, HTTP Core e fila Suwayomi continuam verdes.
- O smoke do APK nao foi repetido apos o desligamento porque o AVD
  `Medium_Phone_API_36.1` inicia o processo QEMU, mas nao publica
  `emulator-5554` nem as portas ADB 5554/5555. Nao houve dispositivo para
  reinstalar o APK, abrir o app ou confirmar a persistencia do catalogo apos
  a sincronizacao. Isso e uma limitacao do ambiente de emulacao, nao uma
  falha classificada do contrato Core.

## 10. Fechamento do fluxo de conteudo mobile

O smoke pareado foi repetido em 2026-08-09 com o perfil real e uma build mobile
atualizada. O Core passou a expor uma fronteira tipada para detalhes,
capitulos e paginas (`FetchManga`, `FetchChapters` e `FetchChapterPages`), sem
aceitar GraphQL arbitrario do dispositivo. O proxy de capas tambem passou a
receber o scope de comics exigido pelo contrato autenticado.

Resultados observados:

- o worker mobile terminou com `SUCCESS` e materializou mais de 600 obras;
- a categoria reservada `id = 0` foi aceita como entrada do protocolo sem ser
  criada como pasta do usuario;
- capas foram carregadas pelo Core autenticado;
- detalhes completos foram hidratados somente ao abrir a obra;
- uma obra Asura Scans exibiu autores, status, descricao, generos e 25
  capitulos, e abriu uma pagina real no reader;
- uma obra cuja source removeu paginas retornou a mesma indisponibilidade no
  GraphQL direto e na bridge, classificando corretamente a falha como
  capacidade da source;
- testes focados de HTTP, source interna, catalogo e projection permaneceram
  verdes; o APK `devDebug` foi montado e instalado com sucesso.

Os smokes seguintes fecharam progresso, categorias e leitura offline. Os gates
restantes sao a reconciliacao visual quando o inventario real de extensoes
mudar, teste em dispositivo fisico e restart do Windows para confirmar a
recuperacao da porta 4777.

### Revalidacao de progresso do reader

A build mobile com identidade server-scoped foi instalada novamente no perfil
real. O reader abriu o capitulo Suwayomi `1057` (7 paginas), avancou da pagina
1 para a pagina 4 e o GraphQL oficial confirmou `lastPageRead = 3`. Depois da
correcao de coalescencia, um segundo ciclo avancou ate a pagina 6 e confirmou
`lastPageRead = 5`.

O parser de escopo agora aceita tanto a identidade atual
`suwayomi:server:<serverId>:profile:<profileId>:...` quanto a identidade Legacy
`suwayomi:profile:<profileId>:...`; nenhuma identidade ambigua e inventada.
Notificacoes rapidas da outbox sao agrupadas por tres segundos e um wake de
outbox nao executa a reconciliacao completa do catalogo. A outbox SQLDelight
continua sendo gravada atomicamente antes do wake, portanto o agrupamento nao
reduz a durabilidade. No smoke, duas mudancas rapidas produziram um unico work
ID, com retry controlado e sucesso, em vez de uma cadeia por pagina.

Com isso, a mutacao bidirecional de progresso esta validada. A categoria
tambem foi exercitada pelo fluxo real do usuario: a obra foi adicionada a
`Lendo`, a releitura oficial mostrou simultaneamente `Dropado` e `Lendo`, e a
remocao restaurou exatamente o estado inicial `Dropado`. Permanecem como gates
separados: reconciliacao visual do inventario de extensoes, dispositivo
fisico e recuperacao da porta 4777 apos reinicio do Windows.

O inventario de extensoes permaneceu inalterado no perfil real, portanto o
aviso nao foi reaberto artificialmente. A Activity continua `exported=false`
e nao foi tornada externamente lancavel apenas para o smoke. Paridade,
deduplicacao multi-source, estados missing/available/unavailable e fila de
instalacao visivel permanecem cobertos pelos testes focados; a evidencia
visual de primeira mudanca de inventario continua pendente.

### Revalidacao de download e leitura offline

O capitulo Suwayomi `1057` foi baixado explicitamente pelo fluxo real do
usuario e salvo como CBZ com `15.819.146` bytes. Depois de remover o proxy de
teste e tornar o Core indisponivel para o emulador, o reader abriu o arquivo
local sem consultar paginas remotas.

O download continha sete paginas da source, mas onze imagens de exibicao. A
diferenca foi causada pela preferencia existente que divide imagens verticais
altas em segmentos `__001`, `__002`; nao eram downloads duplicados. A bridge
do reader foi corrigida para manter dois indices: o segmento local usado para
retomar o CBZ e a pagina original enviada ao Core/Suwayomi. Ao trocar de
online para offline, a posicao armazenada e convertida somente quando a
contagem anterior comprova que ela pertence ao espaco original. Archives com
nomes nao reconhecidos mantem o comportamento anterior.

Testes focados cobrem sete paginas originais convertidas em onze segmentos,
fallback de archive nao padronizado, retomada online para offline e separacao
entre indice local e remoto. O APK final foi remontado e instalado. O gate
offline esta fechado; permanecem apenas a evidencia visual de uma mudanca
real no inventario de extensoes, dispositivo fisico e restart do Windows para
recuperar a porta padrao.

## 11. Retencao do catalogo depois de desemparelhar

O termo offline deste gate inclui o dispositivo sem credenciais de pareamento,
nao apenas a rede indisponivel. A auditoria do perfil real confirmou que o
mobile ja preservava 631 obras Core, categorias, progresso, inventario de
extensoes e livros locais. O defeito era de reuso: as 631 obras estavam
marcadas como nao inicializadas e as capas ainda eram referencias autenticadas,
fazendo a UI depender novamente do Core.

O contrato corrigido e:

- o catalogo completo recebido do Core e last-known-good local;
- desemparelhar apaga somente a credencial;
- metadados, categorias, progresso, inventario e covers ja cacheadas persistem;
- detalhes nao tentam hidratacao automatica sem sessao;
- capitulos e EPUB/PDF previamente baixados continuam locais;
- paginas, capitulos e capas nunca materializados exigem novo pareamento;
- enquanto pareado, a sincronizacao aquece covers confirmadas em lotes
  sequenciais e limitados, sem carregar capitulos de toda a Library.

Essa politica evita tanto o catalogo quebrado quanto uma sincronizacao inicial
agressiva de centenas de obras. Ela nao promete leitura de bytes que nunca
foram baixados para o dispositivo.

## 12. Autoridade de extensoes apos a reconciliacao mobile

O fluxo implementado mantem ecossistemas diferentes separados:

```text
Comics: Suwayomi extension stores -> Suwayomi Extension Manager -> Core inventory
Novels: LNReader plugins.min.json -> NovelPluginManager Android
Books: sem extensoes
```

Para Comics, o endpoint `/v1/suwayomi/extensions` e a unica fonte remota de
inventario do desktop. Entidades Legacy `comic.repository` ou
`comic.extension` nao instalam nem ativam extensoes no Android. O Core nao
transmite JAR/APK; quando o usuario solicita uma instalacao local independente,
o Android resolve o package em seus repositories confiaveis e usa o Package
Installer visivel.

Para Novels, a replica confirmada de `novel.repository` e `novel.plugin` agora
alimenta um estagio pos-transacao. O estagio valida o indice LNReader, resolve
o plugin apenas dentro do repository que o declarou e delega download,
validacao e instalacao ao `NovelPluginManager` existente. O JavaScript vem do
repository LNReader, nunca do Core. SHA-256 e tamanho declarados no registro
confirmado precisam corresponder antes de o runtime carregar o plugin.
Uma instalacao local da mesma versao tambem precisa corresponder ao hash e ao
tamanho confirmados; a versao isoladamente nao e tratada como prova.

Falha de rede, repository ausente, entrada ambigua, versao diferente ou hash
incorreto deixa a dependencia pendente. O fluxo nao remove plugins locais, nao
demove a Library e nao bloqueia o catalogo Suwayomi.

O bridge desktop publica esse inventario a partir do estado real do runtime
LNReader, inclusive no bootstrap da autoridade local. O payload contem somente
identidade, versao, SHA-256 e tamanho; JavaScript, cookies, settings privadas e
caminhos locais nao entram no Syncd. O Android resolve o artefato no repository
LNReader exato e so o ativa depois de validar hash e tamanho.

## 13. Selecao de conteudo e autorizacao por dispositivo

O primeiro sync de um cliente novo agora declara explicitamente os dominios
solicitados. O contrato de pairing aceita `requestedScopes` e o Core valida cada
scope contra o profile da sessao antes de persistir o pedido. A aprovacao concede
somente esse subconjunto; repetir o claim com scopes diferentes e rejeitado para
evitar elevacao silenciosa de permissao.

Scopes suportados neste ciclo:

```text
comics:profile:<profileId>
novels:profile:<profileId>
books:global
```

O catalogo host-side de dispositivos pareados e separado das sessoes em que o
desktop atua como cliente. Settings > Sistema > Seguranca mostra os dominios
pedidos antes da decisao e permite revisar as permissoes de um dispositivo ja
pareado. Alteracoes sao aplicadas imediatamente ao token catalogado; nenhum
endpoint privado, token ou artefato de extensao e exposto na UI.

No Android, a selecao local permanece fora da credencial criptografada e usa a
chave `serverId + profileId + deviceId`. Os recursos efetivos sao sempre a
intersecao entre selecao local, scopes concedidos e capabilities anunciadas pelo
servidor. Desabilitar um dominio pausa sua outbox e seus providers sem apagar
Library, capas, progresso, bookmarks, highlights, downloads ou assets locais.
Reabilitar o dominio reutiliza os checkpoints e agenda uma reconciliacao.

Inventarios de repositories e extensoes de comics e dependencies LNReader sao
opt-in dentro do respectivo dominio. No Android, a atualizacao do catalogo de
repositories de comics pode ser pausada sem copiar Extension Stores do Suwayomi.
A replica apenas compara estado. APKs continuam resolvidos nos repositories
confiaveis do Android e passam pelo Package Installer visivel;
repositories/plugins LNReader exigem acao explicita do usuario e sao obtidos do
repository aprovado, nunca do Syncd.

### Validacao deste lote

- pairing com subconjunto de scopes, retry e rejeicao de scope invalido;
- catalogo host-side e revogacao imediata de permissao;
- persistencia SQLDelight da politica por dispositivo e migration 45;
- intersecao entre selecao, grants e capabilities;
- filas de dominios pausados preservadas e excluidas do drain ativo;
- wizard sem conclusao quando nenhum dominio esta selecionado;
- desconexao preservando o last-known-good e os arquivos offline.

Permanece pendente para o smoke real uma nova sessao de pareamento que exercite
o wizard completo e uma mudanca real nos inventarios de dependencies. Esse smoke
nao deve inventar extensoes nem instalar artefatos silenciosamente.

## 14. Portable Sync V3

O bootstrap portatil foi implementado lado a lado com o V2. O V3 nunca usa PKs
locais no wire e nunca vincula obras por titulo:

```text
Comic: sourceId decimal + SManga.url opaca
Novel: pluginId + novel.path opaca
Chapter: PortableWorkRef + provider-owned chapter key
```

O Core publica dois manifests autenticados e paginados:

- `/v1/portable/manifest` para comics, com Extension Store, `pkgName` e todos os
  source IDs realmente exigidos pela pagina da Library;
- `/v1/portable/novel-manifest` para novels, com `pluginId` como identidade e o
  repository apenas como proveniencia de resolucao.

O Android valida o ID derivado de cada referencia antes de persistir. Stores e
repositories desconhecidos exigem aprovacao local; APK, JAR, JavaScript, cookies,
tokens e preferences privadas nao atravessam o Syncd. A instalacao continua
delegada aos managers oficiais de Mihon/Hayai e LNReader.

Hydration ocorre por filas de source: uma operacao por source e concorrencia
global limitada entre sources diferentes. Falha de uma dependencia produz
bootstrap `PARTIAL` e nao bloqueia obras independentes. Bindings de work e
chapter sobrevivem a restart; estado remoto pendente e aplicado depois que o
chapter exato for resolvido.

No fluxo continuo, comics e novels publicam os Portable refs opcionais quando o
servidor anuncia `supportsPortableSyncV3`. O Core valida hashes canonicos e
parentesco work/chapter antes de aceitar a mutation. Progresso V3 usa HLC, o que
permite retrocesso intencional; clientes Legacy continuam com o merge anterior.

O V2 permanece em dual-read para sessoes antigas e para registros cuja origem
nao pode ser comprovada. Nenhum dado Legacy ambiguo e removido ou convertido por
suposicao. Books, EPUB e PDF continuam no contrato por SHA-256 existente.

### Estado verificado em 13/08/2026

Implementado e coberto por testes:

- refs de comics por `sourceId` decimal + `mangaKey` opaca e refs de novels por
  `pluginId + novelKey` opaca;
- Extension Store como proveniencia Suwayomi, mantendo `pkgName` separado de
  cada `sourceId` exposto;
- repository LNReader apenas como proveniencia, sem participar da identidade do
  plugin;
- validacao da relacao `pkgName -> requiredSourceIds -> work` no import mobile;
- trust local persistente: a aprovacao sobrevive a manifests da mesma origem e
  volta a exigir acao quando a Store ou o repository muda;
- hydration parcial por filas independentes, incluindo capitulos pendentes e
  dependencias que aguardam aprovacao;
- progresso mobile emitido somente com refs V3 completas quando existe binding
  portatil, sem exigir binding V2;
- persistencia SQLite das refs V3 de historico e bookmarks de comics;
- projecao de `comic.chapter_state` mantendo as refs exatas ate a resolucao do
  binding Suwayomi;
- IDs canonicos validados antes de persistir bindings de work ou chapter;
- snapshots completos de comics aceitos pelo consumidor desktop, enquanto
  somente o estado de Reader aplicavel e colocado na inbox local;
- producer e consumer desktop de progresso de novels convertendo entre IDs
  locais diferentes por `pluginId + novel.path` e `chapter.path`;
- dual-read coerente: uma mutation Legacy vencedora nao herda refs V3 de outra
  identidade;
- URLs de Extension Store com credencial, query, fragment, loopback ou endereco
  privado omitidas do wire;
- refs provider-owned com userinfo ou parametros de credencial conhecidos sao
  recusadas sem normalizar a key; a obra permanece fora do V3 ate a source
  oferecer uma identidade portatil que nao carregue segredo;
- repositories LNReader privados continuam validos como configuracao local,
  mas sua proveniencia e omitida do manifesto; somente indices publicos HTTPS
  podem ser apresentados ao outro dispositivo para aprovacao;
- fallback V23 -> V21 restrito a incompatibilidade comprovada de schema, sem
  mascarar falha de autenticacao, transporte ou runtime.

Permanece intencionalmente em dual-read:

- registros V2 cuja origem provider-owned nao pode ser comprovada;
- sessoes Legacy que ainda nao anunciam `supportsPortableSyncV3`;
- metadata local sem `pluginId`, path opaca ou source ID exato.

Esses casos ficam Legacy ou `LEGACY_UNBOUND`; nao existe backfill por titulo,
URL normalizada por heuristica ou database PK. Portanto, a retirada total do V2
so podera ocorrer depois de inventario real demonstrar zero sessoes Legacy e
zero identidade ambigua. O endpoint remoto/compartilhado continua read-only do
ponto de vista de lifecycle: o Epigraph nao reinicia nem administra sua JVM.

Gates focados desta revisao:

```text
Core Rust portable: 46 testes nos targets aplicaveis, zero falhas
Core Rust completo: 417 + 241 testes, zero falhas antes do hardening final
Mobile portable providers/bootstrap: 11 testes, zero falhas
Mobile contracts: 59 testes, incluindo redaction e indices publicos
Mobile reader progress V3: teste focado aprovado
Desktop frontend: svelte-check com zero erros e zero warnings; pnpm build aprovado
Mobile devDebug: build aprovado e APKs gerados
Mobile standardRelease: build aprovado
Android lint: bloqueado por crash interno do ExperimentalDetector, nao por diagnostico do codigo
git diff --check: aprovado nos dois worktrees
```

O smoke Android fisico permanece evidencia de release pendente nesta maquina:
`adb devices -l` nao encontrou dispositivo autorizado durante esta revisao. Os
testes deterministas nao substituem a matriz real com dois dispositivos, IDs
locais diferentes, aprovacao de Store/repository e retomada apos interrupcao.

### Revalidacao do V3 em 13/08/2026

O contrato foi novamente comparado com o upstream atual. Suwayomi moderno usa
`server.extensionStores`; `pkgName` identifica a extension e `sourceId`
identifica cada source exposta. A resposta V21 Legacy nunca e promovida para
`ExtensionStoreReference`. O perfil V23 so e usado quando a introspeccao prova
`extensionStores`, `versionCodeLong` e `storeIndexUrl`. Mudancas futuras de
schema falham como incompatibilidade observavel, em vez de serem aceitas por
heuristica.

No LNReader, `pluginId` permanece a identidade logica. O repository e somente
proveniencia para resolucao e exige trust local; hash de JavaScript e apenas
evidencia observada. Nenhum APK, JAR, JavaScript, cookie ou preference privada
faz parte da identidade ou atravessa o Syncd.

O fluxo continuo agora leva refs portateis nas mutations de Library,
categorias e estado de capitulos. Quando existe binding V3, o mobile publica
somente a mutation causal no Core; ele nao duplica a mesma escrita na fila
direta do Suwayomi. O Core resolve a binding exata antes de projetar o estado
canonico para o Suwayomi. Clientes Legacy continuam no caminho anterior.

A hidratacao mobile exige a relacao exata `pkgName -> sourceId`, executa uma
fila serial por source e permite concorrencia global limitada entre sources.
Uma obra `BOUND` e marcada como favorita local dentro da mesma transacao dos
bindings, preservando sua presenca na Library sem pareamento. Capas e conteudo
de leitura continuam offline somente depois de cache/download real; ausencia
de bytes nunca e apresentada como disponibilidade offline.

Gates adicionais aprovados nesta revalidacao:

```text
Mobile portable/projection/outbox: 38 testes, zero falhas
Core portable manifest: 16 testes por target aplicavel, zero falhas
Suwayomi updater toast: 12 testes, zero falhas
cargo fmt --check: falha conhecida em arquivos compartilhados preexistentes
git diff --check: aprovado nos dois worktrees
```

O toast de update do Suwayomi deixou de ser persistente: ele usa a duracao
limitada da infraestrutura global de toasts e reinicia o prazo somente quando
uma verificacao manual repetida precisa reapresentar o mesmo update.

O smoke Android real em emulador foi repetido contra o sidecar Core recompilado.
O APK atualizado migrou o banco de `user_version 43` para `50`; o worker unico
terminou com `SUCCESS`, sem `CLIENT_RESPONSE_UNSUPPORTED`, fatal ou erro SQLite.
A Library exibiu capas reais e o snapshot SQLite consistente (`db + wal + shm`)
confirmou 631 obras favoritas, 631 URLs de capa e 631 refs V3 classificadas.

O runtime Suwayomi real deste perfil ainda e V21 e, portanto, nao expoe
Extension Stores. Nesse caso, provenance ausente permite somente inspecao e
resolucao pelos providers ja confiados localmente; nao transfere trust nem
instala artefato. As seis dependencies foram classificadas como
`EXTENSION_NOT_FOUND`, enquanto o inventario separado manteve as URLs Legacy
apenas como sugestoes que exigem aprovacao no mobile. Provenance V23 explicita
e desconhecida continua `APPROVAL_REQUIRED`.

O refresh do manifest agora preserva evidencias de resolucao quando identidade
e dependency nao mudaram. O passe interno de hydration usa o teto limitado de
1.000 refs, suficiente para esta Library de 631 itens e sem aumentar a
concorrencia por source. Isso eliminou a starvation observada com o limite
anterior de 500.

Ainda faltam para certificacao final: smoke fisico com aprovacao real de
Store/repository, instalacao visivel das extensions/plugins, source carregada,
desemparelhamento e reparing pelo fluxo de UI, interrupcao durante bootstrap e
convergencia causal entre dois dispositivos. O smoke atual prova persistencia
e renderizacao local; nao substitui o ciclo destrutivo de remover credenciais.

### Revalidacao do lote de autoridade Suwayomi — 20/08/2026

Este lote fechou os bloqueios de concorrencia e de semantica que impediam o
Core de ser tratado como autoridade confirmada:

- o espelho de progresso do Suwayomi inicia apos o primeiro intervalo para nao
  concorrer com o bootstrap e aceita bookmarks somente com ID numerico positivo;
- pairing, decisoes do host, claim/projection e atualizacoes de estado usam a
  mesma trava de mutacao do banco, eliminando a janela de `SQLITE_BUSY` entre
  duas escritas do Core;
- o Core anuncia `comicAuthorityMode=suwayomi-confirmed-v1`, capability de
  comandos confirmados e `supportsSyncStatusV1`;
- `GET /v1/sync/status` e profile-scoped, mede pending/retry, blocked e
  in-flight da fila de projecao e so retorna `ready` quando a fila autoritativa
  esta vazia;
- o Android consulta esse endpoint antes de emitir `OutboxDrained`; uma
  projecao pendente ou bloqueada permanece como retry/action-required;
- o bootstrap mobile executa inventario de extensoes (somente leitura),
  plugins, manifests portateis, catalogo Suwayomi e replica Core nessa ordem;
  nenhuma APK, repository ou trust e alterado sem acao explicita do usuario;
- o script de phase-gate passou com target Cargo isolado, portanto nao toca o
  executavel do desktop que o usuario possa estar usando;
- os cinco harnesses standalone de Syncd isolam as raizes Suwayomi em `tmp/`
  e encerram a arvore inteira do processo, evitando deixar uma JVM filha
  segurando o JRE depois de pairing, bootstrap, mutations, discovery ou live
  pairing.

Evidencias desta revalidacao:

```text
Core syncd: 437 testes Rust (`--lib`) aprovados
Phase-gates: runtime, pairing, bootstrap, mutations, discovery e live pairing aprovados
Mobile app + migration: testDevDebugUnitTest e verifyCommonMainDatabaseMigration aprovados
Android lint: :app:lintDevDebug concluido pelo Gradle, 0 errors
APK: :app:assembleDevDebug aprovado
```

Nota de higiene: uma execucao global de `cargo fmt --check` ainda aponta
formatacao preexistente em `syncd/app.rs`, `suwayomi_progress_mirror.rs` e
`suwayomi_projection.rs`, arquivos que pertencem ao lote compartilhado do
outro chat. Nao apliquei um formatter global para nao reescrever esse diff;
os scripts alterados neste lote passam `git diff --check` e os gates Rust
continuam compilando e testando normalmente.

O gate de dois dispositivos foi reaberto em dois AVDs API 36 com particao `/data`
de 16 GB. A mesma build foi instalada e iniciada nos dois aparelhos; ambos
mantiveram o processo do app vivo, sem `FATAL EXCEPTION`, `SIGSEGV` ou ANR.

### E2E real de pairing e convergencia — 20/08/2026

Foi executado um Core isolado pela LAN, com TLS e aprovação de pairing pelo
fluxo do host, usando dois AVDs distintos (`emulator-5556` e `emulator-5558`).
Cada aparelho recebeu um bundle de pairing próprio, validou o fingerprint e
terminou com uma sessão autenticada no mesmo Core. O Core recebeu dez eventos
autoritativos de teste nos scopes `books:global`, `novels:profile:main` e
`comics:profile:main`, incluindo entrada, categoria, associação, progresso e
bookmark. Depois do bootstrap, os dois bancos SQLite foram extraídos com
`run-as` e comparados:

```text
device A == device B
3 identidades de conteúdo: EPUB, MANGA e NOVEL
10 versões de réplica aplicadas, sem duplicação
categoria Shared Books e associação EPUB presentes nos dois aparelhos
EPUB progressão 0.42 + locator Readium preservados nos dois aparelhos
bookmark E2E preservado nos dois aparelhos
```

Esse teste prova pairing real, pinning TLS, bootstrap ordenado e convergência
da réplica Core entre dois clientes. O Suwayomi não foi iniciado nesse Core
isolado; por isso o catálogo de comics retornou `503` e permaneceu corretamente
em `RETRY`, enquanto a réplica genérica de livros/novels/comic-state convergiu.
Não há falsa indicação de `ready` quando a autoridade Suwayomi está ausente.

O bridge agora também possui operações oficiais confirmadas para categorias
Suwayomi existentes: `UpdateCategory`, `UpdateCategoryOrder` e
`DeleteCategory`. Eventos `comic.category` geram projeções separadas para nome
e ordem, ou remoção, e só são removidos da fila após confirmação do GraphQL.
`UpdateCategoryOrder` valida a posição positiva 1-based exigida pelo schema
oficial.
Criação de uma categoria nova ainda depende de alocar primeiro o ID oficial do
Suwayomi; o mobile não inventa IDs locais para o catálogo autoritativo.

Hardcover está implementado no Epigraph Mobile como tracker de novels, mas tokens,
cookies e bindings de trackers permanecem locais por segurança. O Core não
publica `novel.tracking`/`comic.tracking` até existir um contrato de campos
não secretos e confirmação de cada provider.

### Gate de categorias contra Suwayomi populado — aprovado (20/08/2026)

O último gate foi executado com o bundle Suwayomi oficial já presente no
projeto, usando um `rootDir` descartável e um Core isolado. O perfil real do
usuário não foi aberto. Duas categorias foram criadas diretamente no banco
temporário para receber IDs reais; em seguida, o Core autenticado executou as
três operações novas do bridge:

```text
UpdateCategory       ID 1 -> "Epigraph E2E Alpha Renamed"       PASS
UpdateCategoryOrder  ID 1 -> posição 2; ID 2 -> posição 1    PASS
DeleteCategory       ID 2 removido                           PASS
```

Cada mutação foi conferida no GraphQL do Suwayomi e novamente no endpoint
`GET /v1/suwayomi/catalog?operation=categories` do Core. A posição foi aceita
como inteiro positivo 1-based, conforme o schema/implementação oficiais. O
Core, a JVM do Suwayomi, a porta TLS e o `rootDir` temporário foram encerrados
e removidos ao fim do teste; nenhum listener residual permaneceu.
