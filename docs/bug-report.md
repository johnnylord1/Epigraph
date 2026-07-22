# Relatório de Bugs e Problemas — Aethon Desktop

[Matriz funcional](functional-audit.md) · [Guia do usuário](user-guide.md) · [Melhorias e dívidas](improvement-report.md)

## Resumo executivo

- Funcionalidades analisadas: 63.
- Funcionando: 29; funcionando parcialmente: 4; quebradas: 0.
- Somente interface: 0; implementadas mas inacessíveis: 1; não implementadas: 0.
- Não foi possível testar: 9; dependem de configuração ausente: 5; dependem de serviço externo: 15.
- Bugs registrados: **6** — todos resolvidos após revalidação.
- O gate Svelte/TypeScript passou com 0 erros e 0 warnings em 21/07/2026. Os riscos abertos estão registrados como melhorias de certificação, acessibilidade, integrações e desempenho, não como bugs reproduzidos.

Nenhum bug de severidade Crítica ou Alta foi reproduzido no caminho do usuário. Isso não significa ausência de risco: vários fluxos nativos e externos ficaram bloqueados pelas limitações registradas na auditoria.

## Ambiente utilizado

- Windows 11 Pro 10.0.26200 x64.
- Node.js 25.2.0, pnpm 10.33.0, Rust/Cargo 1.94.1.
- Svelte 5, Vite 5.4.21, Tauri v2 e WebView2.
- Branch `main`, commit inicial `2acec71a5e332eb24898f01fbe99742f068169eb`, em 18/07/2026.
- Execução em cópia temporária do worktree vivo; perfil persistente não modificado.
- Suwayomi, trackers, Hardcover, Discord, FlareSolverr e updater sem configuração de sucesso disponível.

## Classificação

- Severidade: Crítica, Alta, Média ou Baixa.
- Prioridade: P0, P1, P2 ou P3.
- Status usado nos bugs: Confirmado ou Resolvido. Hipóteses são explicitamente marcadas como tal.

### Revalidação após o Marco 63

- `BUG-001`: resolvido com inventário de 2.675 component tokens ativos, família Syncd 98/98 e alias de divisor ligado a um token existente; 803/803 testes unit/jsdom passaram.
- `BUG-003`: resolvido no harness atual; 9/9 arquivos e 44/44 testes browser passaram em execução serial.
- `BUG-004`: resolvido; `cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check` encerra com código 0.
- `BUG-005`: resolvido por normalização equivalente das formas mDNS com e sem ponto final; o phase gate real concluiu com sucesso.
- `BUG-006`: resolvido funcionalmente pelos Marcos 58, 61 e 62; o harness nativo isolado concluiu 7/7 cenários. O isolamento completo de portas e ownership de PIDs continua como melhoria `IMP-017`, não como regressão funcional aberta.
- `BUG-002`: resolvido; o `svelte-check` passou com 0 erros e 0 warnings em 21/07/2026.

## BUG-001 — Contratos de tema não acompanham os novos tokens Syncd

**Severidade:** Média
**Prioridade sugerida:** P1
**Status:** Resolvido
**Área:** Temas / Syncd Desktop
**Funcionalidade afetada:** FUNC-040
**Rota ou tela:** Settings > Appearance e modal Syncd
**Ambiente:** projeto Vitest `unit` na cópia temporária
**Mudança relacionada:** diffs não commitados em `src/styles/tokens.css`, `src/styles/nocturne-theme.css`, `src/components/settings/SyncdConnectionThemeTokens.test.ts` e painel Syncd.

### Descrição

O inventário e os contratos de tokens continuam com contagens/aliases anteriores à expansão do modal Syncd. O gate unitário falha de forma determinística.

### Pré-condições

- Worktree no commit/base e com as mudanças não commitadas registradas na auditoria.
- Dependências já instaladas.

### Passos para reproduzir

1. Executar `pnpm exec vitest run --project unit --reporter=basic`.
2. Observar `src/lib/theme/themeGate.test.ts` e `src/lib/theme/themeInventory.test.ts`.

### Resultado atual

Cinco testes falham. Exemplos:

- cores de componente: esperado 1.459, recebido 1.471;
- tokens editáveis: esperado 1.448, recebido 1.460;
- inventário total: esperado 2.637, recebido 2.675;
- família Syncd: esperado 60, recebido 98;
- alias ausente no contrato: `--component-syncd-modal-divider -> --component-settings-divider`.

### Resultado esperado

O inventário, os aliases e as contagens devem representar exatamente os tokens efetivos e o gate deve passar sem atualizar snapshots de forma cega.

### Frequência

Sempre.

### Impacto para o usuário

Indireto: reduz a confiança de que temas builtin e customizados cobrem o novo painel Syncd sem cores ou contraste fora do contrato.

### Evidências

- 5 falhas em 632 testes do projeto `unit`.
- Arquivos relacionados: `src/lib/theme/themeGate.test.ts`, `src/lib/theme/themeInventory.test.ts` e diffs Syncd/tema.

### Causa provável

**Hipótese com alta confiança:** tokens foram adicionados ao painel Syncd e aos estilos, mas os inventários/aliases esperados pelos gates não foram reconciliados.

### Direção sugerida para correção

Revisar semanticamente cada token novo, atualizar alias/família e regenerar somente os inventários cuja mudança seja intencional. Não mascarar divergências alterando apenas números.

### Possíveis regressões

Temas builtin, temas customizados, contraste do modal, divisores, estados de sessão e detalhes Syncd.

## BUG-002 — Verificação Svelte/TypeScript falhava com 308 erros

**Severidade:** Média
**Prioridade sugerida:** P1
**Status:** Resolvido
**Área:** Frontend / contratos
**Funcionalidade afetada:** transversal
**Rota ou tela:** múltiplas
**Ambiente:** `svelte-check` no worktree atual
**Mudança relacionada:** parte dos erros toca arquivos recentemente modificados, mas a origem temporal de todos eles não foi confirmada.

### Descrição

O baseline original tinha 308 erros e 11 warnings, incluindo testes e código de produção. Os contratos afetados foram corrigidos em lotes e o type-check voltou a ser um gate confiável.

### Pré-condições

- Dependências instaladas conforme lockfile.

### Passos para reproduzir

1. Executar `pnpm exec svelte-check --tsconfig ./tsconfig.json`.
2. Aguardar o resumo.

### Resultado atual

Em 21/07/2026, o comando conclui com 0 erros e 0 warnings. O snapshot histórico de 308 erros e 11 warnings em 76 arquivos incluía:

- `Reader.svelte` passa/binda `toolsOpen`, mas `ReaderHud.svelte` não declara a propriedade;
- valores opcionais/null em assets de books, library state, recomendações e Hardcover;
- `Uint8Array` incompatível com `BlobPart`/`BufferSource` em offline manga e backup;
- divergências de módulos de mensagens i18n e de identidade de novel source.

### Resultado esperado

Zero erros de tipo, ou baseline explícito e reduzido que não esconda regressões novas.

### Frequência

Resolvido no baseline atual.

### Impacto para o usuário

Indireto, mas amplo: contratos quebrados podem emergir como estados inválidos, recursos ausentes ou falhas silenciosas em readers, backup, books, novels e i18n.

### Evidências

- Snapshot histórico: `svelte-check found 308 errors and 11 warnings in 76 files`.
- Revalidação de 21/07/2026: `svelte-check found 0 errors and 0 warnings`.
- `pnpm build` continua sendo um gate separado, pois o empacotamento isolado não substitui o type-check.

### Causa provável

**Causa confirmada:** dívida acumulada de contratos entre componentes, módulos e fixtures, corrigida sem `any`, `@ts-ignore` ou supressões amplas.

### Direção sugerida para correção

Manter o comando no gate de release e impedir regressões. Cada mudança de contrato deve continuar acompanhada pelo teste funcional da área.

### Possíveis regressões

Readers, importação/offline, backup, i18n, recomendações, Hardcover, books e novels.

## BUG-003 — Suite browser estava vermelha e capturava estados assíncronos instáveis

**Severidade:** Média
**Prioridade sugerida:** P1
**Status:** Resolvido
**Área:** Certificação UI / Library / Settings
**Funcionalidade afetada:** FUNC-005, FUNC-006, FUNC-047 e FUNC-062
**Rota ou tela:** Library e Settings
**Ambiente:** Vitest browser-components, 1280×800
**Mudança relacionada:** correções históricas no workspace Vitest, Settings e componentes de biblioteca.

### Descrição

Na auditoria original, o projeto browser não fornecia um resultado determinístico: bodies de Library falhavam por mocks/fixtures, o service worker MSW não registrava e snapshots de Settings eram tirados antes de operações assíncronas terminarem. A revalidação de 21/07/2026 passou 44/44 testes.

### Pré-condições

- Browser provider configurado pelo workspace atual.

### Passos para reproduzir

1. Executar `pnpm test:browser`.
2. Inspecionar falhas e capturas `*.actual.png` somente na cópia temporária.

### Resultado na auditoria original

- 9 arquivos: 6 passaram e 3 falharam.
- 44 testes: 27 passaram e 17 falharam.
- 23 erros não tratados.
- `BooksLibraryBody`: 4/4 falhas por leitura de `metadata` em `undefined`.
- `ComicsLibraryBody`: 8/8 falhas porque `vi.mocked(...).mockReset` não é função.
- Settings: 5 snapshots falham; Storage diverge 9,0525% porque o actual ainda mostra `Refreshing…`/`Not configured`, enquanto o baseline já contém dados carregados.
- MSW tenta registrar `mockServiceWorker.js`, mas recebe `text/html`; também há ausência de `invoke`/`transformCallback` Tauri e reload de Vite após otimização tardia de dependência.

### Resultado esperado

O harness deve instalar mocks antes do render, esperar estado estável e produzir capturas repetíveis; falhas do aplicativo devem ser separadas das falhas do ambiente de teste.

### Frequência

Resolvido no harness atual.

### Impacto para o usuário

Indireto: regressões visuais e comportamentais de Library/Settings podem entrar sem um gate confiável. Não há evidência suficiente para afirmar que a tela Storage de produção esteja quebrada.

### Evidências

- Resultado consolidado do comando.
- Comparação visual baseline/actual de Storage.
- Quatro capturas atuais, sem dados sensíveis, foram preservadas em `images/user-guide/`.

### Causa provável

**Hipótese com alta confiança:** combinação de fixtures incompatíveis, mocks Tauri incompletos, MSW mal servido e ausência de espera por conclusão de `refresh`.

### Direção sugerida para correção

Corrigir o boot do harness, estabilizar mocks/fixtures e esperar sinais observáveis de ready antes do snapshot. Não atualizar baselines enquanto o actual estiver em loading.

### Possíveis regressões

Library de comics/books, Storage, About, Content, General e Reader Settings.

## BUG-004 — Gate `cargo fmt --check` falha

**Severidade:** Baixa
**Prioridade sugerida:** P2
**Status:** Resolvido
**Área:** Rust / manutenção
**Funcionalidade afetada:** nenhuma manifestação direta confirmada
**Rota ou tela:** backend
**Ambiente:** rustfmt 1.94.1
**Mudança relacionada:** worktree vivo; autoria não atribuída.

### Descrição

O código Rust não atende ao formato esperado pelo toolchain atual.

### Pré-condições

- Toolchain Rust 1.94.1.

### Passos para reproduzir

1. Executar `cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check`.

### Resultado atual

O comando retorna código 1 e mostra diffs em:

- `src-tauri/src/suwayomi_update.rs`;
- `src-tauri/src/syncd/routes/suwayomi_proxy.rs`.

### Resultado esperado

O check deve encerrar com código 0 sem modificar arquivos.

### Frequência

Sempre.

### Impacto para o usuário

Nenhum impacto direto confirmado; o problema bloqueia ou enfraquece gates de manutenção/CI.

### Evidências

Saída do rustfmt check. Após o drift concorrente, os 493 testes Rust passam.

### Causa provável

**Hipótese:** alterações foram salvas sem aplicar o formatter do toolchain atual.

### Direção sugerida para correção

Em uma tarefa própria e após preservar mudanças concorrentes, aplicar/revisar rustfmt somente aos arquivos afetados e repetir testes. Esta auditoria não executou formatação com escrita.

### Possíveis regressões

Baixas; ainda assim, revisar diffs em Suwayomi updater e proxy Syncd antes de aceitar.

## BUG-005 — Gate de descoberta Syncd diverge do `serviceType` publicado

**Severidade:** Média
**Prioridade sugerida:** P1
**Status:** Resolvido
**Área:** Syncd Desktop / descoberta LAN
**Funcionalidade afetada:** FUNC-058
**Rota ou tela:** modal Syncd / backend de descoberta
**Ambiente:** Windows 11, perfil temporário, gate não interativo
**Mudança relacionada:** worktree vivo; autoria não atribuída.

### Descrição

O provider publica o tipo mDNS canônico com ponto final, `_aethon-sync._tcp.local.`, coerente com as constantes e testes Rust. O gate PowerShell exige `_aethon-sync._tcp.local` e encerra com erro.

### Passos para reproduzir

1. Executar `scripts/run-syncd-discovery-phase-gate.ps1` na cópia temporária preparada.
2. Aguardar o endpoint ficar saudável.
3. Observar a validação de `publication.serviceType`.

### Resultado atual

O endpoint responde 200 e reporta provider `lan-publication` ativo, mas o gate falha com “unexpected service type” por diferença exclusiva do ponto final.

### Resultado esperado

Produtor, consumidores e gate devem compartilhar uma representação canônica ou normalizar o ponto final antes da comparação.

### Frequência

Sempre no snapshot auditado.

### Impacto para o usuário

Não foi reproduzida falha de descoberta na UI; o impacto confirmado é a perda do gate de certificação e o risco de consumidores divergirem na normalização do tipo mDNS.

### Evidências e direção sugerida

JSON real do endpoint temporário, constante Rust com ponto final e asserção do script sem ponto. Centralizar a constante/normalização e manter um teste de contrato único frontend/backend/script.

### Possíveis regressões

Descoberta LAN, fallback manual, publicação mDNS e ferramentas de diagnóstico.

## BUG-006 — Runner nativo Syncd não gera bootstrap após falha de readiness

**Severidade:** Média
**Prioridade sugerida:** P1
**Status:** Resolvido
**Área:** Syncd Desktop / lifecycle nativo
**Funcionalidade afetada:** FUNC-057
**Rota ou tela:** Settings > Security > Syncd
**Ambiente:** Tauri/WebView2 release, perfil descartável, driver nativo
**Mudança relacionada:** lifecycle/replicação Syncd mudaram durante a auditoria; autoria não atribuída.

### Descrição

No smoke nativo, o host abriu o painel e instalou subscriptions, mas o sidecar encerrou com erro de endereço em uso. O lifecycle tentou ler `runtime.json`, que não existia, exibiu “Sync needs attention” e não produziu o bootstrap/QR.

### Passos para reproduzir

1. Construir sidecar release e app Tauri sem bundle na cópia temporária.
2. Iniciar `tauri-driver` em portas isoladas.
3. Executar o runner de duas instâncias com perfis descartáveis.
4. Aguardar o smoke “Host bootstrap readiness”.

### Resultado atual

`syncd-bootstrap-bundle-host` fica vazio e o runner encerra após aproximadamente 122 segundos. A repetição não alcançou o mesmo ponto porque o driver caiu com conexão recusada, evidenciando também fragilidade do harness.

### Resultado esperado

O lifecycle deve iniciar ou reutilizar uma única instância do sidecar, produzir `runtime.json` de forma atômica e gerar o bootstrap. Cada execução local deve receber portas exclusivas; colisões devem ter diagnóstico acionável, retry limitado em outra porta e recuperação idempotente.

### Frequência

Reproduzido em uma execução nativa completa do smoke; a segunda tentativa foi inconclusiva por falha do driver.

### Impacto para o usuário

No cenário reproduzido, o usuário não consegue criar QR nem parear outro desktop. Não há evidência suficiente para afirmar que todas as instalações de produção são afetadas.

### Evidências e direção sugerida

Log do sidecar com `os error 10048`, ausência de `runtime.json`, timeout do runner e captura nativa redigida apenas por descrição porque continha caminho privado. Tornar start/stop idempotentes e distinguir “já em execução” de colisão externa.

Para o app, manter uma porta preferida persistida, mas selecionar outra quando ela estiver ocupada; a porta efetiva deve ser gravada em `runtime.json` e publicada no QR/mDNS sem exigir decisão do usuário. O estado interno deve permanecer no diretório padrão do aplicativo, com temporários e logs limitados e limpos automaticamente. Para a automação, alocar dinamicamente driver, WebDriver nativo, servidores locais e sidecars, usando `runId`, diretórios e perfis exclusivos. A limpeza deve usar apenas os PIDs iniciados pela própria execução, sem encerrar processos por nome, caminho genérico ou porta isoladamente.

Usuários em computadores diferentes podem usar a mesma porta porque seus endereços IP são distintos. Contas, perfis ou instâncias no mesmo Windows compartilham o namespace TCP e precisam de portas diferentes.

### Possíveis regressões

QR, pairing, restart, reconnect, sessões persistidas e replicação entre desktops.

## Suspeitas não promovidas a bug

- Os erros históricos de tipo em `ReaderHud`/`Reader`, backup e offline manga não tiveram manifestação de runtime reproduzida individualmente e já não aparecem no gate atual.
- O actual de Storage em loading comprova instabilidade do teste, não defeito funcional da tela.
- `source.settings.write` é whitelistada e retorna `not_implemented`, porém não possui chamador de produção; está em `improvement-report.md` como dívida arquitetural/inacessível.
- Chunks grandes são risco de desempenho, não bug reproduzido de usuário.
