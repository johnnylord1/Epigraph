# Relatório de Melhorias e Dívidas Técnicas — Aethon Desktop

[Matriz funcional](functional-audit.md) · [Bugs confirmados](bug-report.md) · [Guia do usuário](user-guide.md)

Este documento não redefine os bugs confirmados de `bug-report.md`. Os itens abaixo são recomendações de confiabilidade, experiência e manutenção baseadas em evidência. O estado original foi preservado e as revalidações posteriores estão registradas explicitamente.

## Prioridades recomendadas

| ID | Categoria | Problema atual e evidência | Benefício esperado | Complexidade | Risco | Prioridade | Dependências / módulos | Relação |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| IMP-001 | Cobertura de testes | O Marco 67 adicionou smoke WebView2 de Home, Library e Settings em 1280×800 e 800×600; o Marco 66 cobre EPUB/PDF. Manga fullscreen ainda depende de catálogo/capítulo real. | Detectar regressões de foco, fullscreen, teclado, diálogos e persistência no runtime real. | Média | Baixo | P2 | Tauri driver, launcher gerenciado, perfis descartáveis | BUG-003 |
| IMP-002 | Arquitetura | O Marco 65 removeu `source.settings.write`, que não possuía implementação nem chamador de produção. `source.settings.read` continua sob demanda. | Contrato publicado corresponde às capacidades reais. | Concluída | Baixo | Resolvido | `novels/contracts.ts` e testes de contrato | FUNC-063 |
| IMP-003 | Desempenho | O Marco 70 reduziu o entry em 17,57%, retirou EPUB/PDF/parsers do grafo estático inicial e adicionou budgets determinísticos de bundle e navegação. | Menor tempo de startup, parse e memória do WebView2. | Concluída | Baixo | Resolvido | `release:check-bundles`, `release:check-navigation` | — |
| IMP-004 | Cobertura de testes | O Marco 66 adicionou gate WebView2 descartável para EPUB/PDF e round-trip de Books, além do contrato de fallback offline. | Provar integridade de dados, rejeição de corrupção e persistência antes de releases. | Concluída | Baixo | Resolvido | `release:certify-data`, perfil Tauri descartável | — |
| IMP-005 | Observabilidade | O snapshot original tinha 23 erros não tratados; o browser gate atual passou 44/44 sem repetir a falha. | Manter logs com fase, perfil, comando Tauri e correlação sem dados sensíveis nos novos harnesses. | Média | Baixo | P1 | Vitest browser, bridge Tauri, scripts de release | BUG-003 |
| IMP-006 | Manutenção | O baseline histórico tinha 308 erros e 11 warnings; em 21/07/2026 o `svelte-check` passou com 0 erros e 0 warnings. | Manter o type-check verde como gate de release. | Concluída | Baixo | Resolvido | Svelte/TS, readers, books, i18n, novels | BUG-002 |
| IMP-007 | Acessibilidade | O Marco 67 certificou foco inicial/circular, background `inert` e restauração nos três modais de migração, além de foco visível e ausência de clipping no smoke nativo. Falta uma auditoria manual completa com leitor de tela. | Navegação previsível sem mouse e menor risco de clipping/contraste. | Baixa | Baixo | P3 | shell, modais, readers, Settings, Activity Center | — |
| IMP-008 | Segurança | O Marco 69 certificou redaction e estados inválido/expirado com transports falsos e servidores locais, sem credenciais reais. | Evitar exposição acidental e validar erro/recuperação sem usar segredos reais. | Concluída | Baixo | Resolvido | trackers, Hardcover, updater, Discord, proxy | — |
| IMP-009 | Documentação | O Marco 71 adicionou `release:verify`, com ordem, limites de concorrência e critérios condicionais documentados. | Uma lista oficial de gates, entradas e critérios de “não aplicável”. | Concluída | Baixo | Resolvido | scripts e documentação de release | — |
| IMP-010 | Confiabilidade | Testes de composição de capas Discord passam, mas dois levam mais de 60 s. | Reduzir tempo de feedback sem diminuir a cobertura de dimensões/SSRF. | Média | Médio | P2 | `discord_cover` e fixtures de imagem | — |
| IMP-011 | Experiência do usuário | O splash de servidor indisponível comunica o erro, mas o ambiente auxiliar alterna idiomas e termos (“MAIN profile”) no mesmo cartão. | Mensagens consistentes com o idioma ativo e orientação clara sobre servidor local. | Baixa | Baixo | P3 | i18n e startup state | — |
| IMP-012 | Arquitetura | Backend expõe comandos internos de replicação Syncd além dos usados diretamente pelo painel; não há inventário gerado frontend↔Tauri. | Identificar comandos realmente públicos, internos e órfãos sem buscas manuais. | Média | Médio | P2 | `generate_handler!`, wrappers `invoke`, Syncd | — |
| IMP-013 | Cobertura de testes | Gate de tema depende de contagens absolutas extensas; mudanças legítimas geram várias falhas pouco diagnósticas. | Validação semântica por família/alias/contraste, mantendo inventário verificável. | Média | Médio | P1 | theme gate/inventory e editor | BUG-001 |
| IMP-014 | Observabilidade | Fluxos externos não apresentam um relatório de capacidades consolidadas (configurado, indisponível, credencial ausente, offline). | Diagnóstico de suporte mais rápido sem expor tokens. | Média | Baixo | P2 | About, Activity Center, Settings, runtime diagnostics | — |
| IMP-015 | Contratos | O tipo mDNS é repetido em Rust e PowerShell com formas diferentes quanto ao ponto final. | Evitar gates falsamente vermelhos e consumidores incompatíveis. | Baixa | Médio | P1 | discovery provider, phase gate, diagnóstico Syncd | BUG-005 |
| IMP-016 | Confiabilidade | O lifecycle Syncd não forneceu bootstrap quando o sidecar encontrou colisão e `runtime.json` não foi criado. | Start/restart idempotente e recuperação clara sem deixar o pairing em espera. | Alta | Alto | P1 | sidecar, lifecycle, runtime file, automação nativa | BUG-006 |
| IMP-017 | Automação / concorrência | Driver, servidor local e instâncias Syncd usam conjuntos de portas fixas; a limpeza procura processos e listeners de forma ampla. Execuções paralelas no mesmo Windows podem disputar portas ou interferir entre si. | Permitir auditorias e duas ou mais instâncias locais simultâneas sem afetar outros usuários, chats ou sessões do Aethon, mantendo a complexidade invisível no app. | Alta | Alto | P1 | runner nativo, wrapper PowerShell, lifecycle, `runtime.json`, mDNS/QR | BUG-006 |
| IMP-018 | Armazenamento / UX | Runtime, logs, temporários e diagnósticos podem crescer ou aparecer como múltiplos artefatos se cada execução criar estruturas permanentes. | Manter o perfil do usuário limpo, com estado interno limitado, rotação automática e nenhuma configuração técnica no fluxo normal. | Média | Alto | P1 | diretório de dados do app, logs, temporários, diagnósticos, backup | — |

## Ordem sugerida

1. Marcos 63–64: concluídos; o último snapshot completo de Rust/discovery permanece verde e a revalidação atual confirmou tema, browser, build e `svelte-check`.
2. Marco 65: concluído; `source.settings.write` foi removida e `source.settings.read` permanece estritamente sob demanda.
3. Marcos 66–68: concluídos; dados locais, acessibilidade/viewports e localização Syncd possuem gates reproduzíveis.
4. Marcos 69–70: concluídos; integrações determinísticas e budgets de desempenho estão certificados.
5. Marco 71: concluído; o gate agregado e a matriz de riscos foram publicados.

## Estado revalidado em 21/07/2026

- Resolvidos: `BUG-001`, `BUG-002`, `BUG-003`, `BUG-004`, `BUG-005` e `BUG-006`.
- `IMP-006` foi concluído: o `svelte-check` passou com 0 erros e 0 warnings; o baseline de 308/11 permanece como histórico no BUG-002.
- `IMP-002` foi concluído no Marco 65: a escrita inexistente foi removida e a leitura de settings continua lazy, sem cache novo.
- `IMP-001` e `IMP-007` foram reduzidos no Marco 67: viewports e foco estão cobertos automaticamente; manga fullscreen e leitor de tela permanecem como validações manuais/condicionais.
- O Marco 68 certificou as 134 mensagens ativas do Syncd em `es`, `ja` e `zh-CN`, incluindo baselines browser de Pairing, Details e Options.
- `IMP-013` permanece como melhoria de diagnóstico, embora o inventário atual esteja reconciliado e verde.
- `IMP-015` e `IMP-016` foram funcionalmente resolvidos; permanecem no histórico para rastreabilidade.
- `IMP-017` continua adiado para um ciclo futuro de automação Syncd e não bloqueia os marcos atuais.
- `IMP-018` é um critério transversal: novas implementações não devem criar artefatos em pastas comuns do usuário nem expor detalhes de runtime no fluxo padrão.

## Critérios para uma futura reauditoria

- Executar sobre snapshot identificado do worktree, repetindo módulos alterados durante a sessão.
- Exigir relatórios de ready antes de capturas visuais; nunca atualizar baseline em loading.
- Manter credenciais fora de logs, screenshots e fixtures versionadas.
- Usar somente instâncias desktop no gate Syncd.
- No produto, alocar portas automaticamente e ocultar IP, porta, PID, `runId` e arquivos internos do fluxo principal. Endereço manual e diagnóstico técnico devem ficar em uma área avançada.
- Na automação, alocar dinamicamente portas de driver, WebDriver nativo, servidor local e sidecar Syncd. A seleção deve ser registrada somente no relatório técnico e propagada ao runtime, QR e anúncio mDNS.
- Usar `runId`, diretório temporário e perfis exclusivos apenas na automação; registrar os PIDs filhos e limpar somente os processos pertencentes àquele `runId`.
- Não assumir que contas diferentes do mesmo Windows possuem namespaces de porta separados. Portas podem ser reutilizadas em computadores diferentes, mas são compartilhadas por processos no mesmo sistema operacional.
- Evitar a sequência “consultar porta livre e iniciar depois” sem reserva, pois existe uma corrida entre a verificação e o bind. Preferir reserva coordenada ou retry limitado com nova porta.
- Armazenar o estado normal somente no diretório padrão de dados do aplicativo, sem criar pastas na Área de Trabalho, Documentos ou Downloads. Manter apenas arquivos indispensáveis por perfil.
- Rotacionar logs por tamanho/idade, apagar temporários após sucesso ou falha e remover manifests/locks obsoletos durante uma inicialização segura.
- Gerar pacote de diagnóstico somente quando o usuário solicitar. Backup e conteúdo importado devem usar um destino escolhido ou claramente configurado pelo usuário.
- Reconciliar totais da matriz e links de bugs após qualquer mudança de estado.

## Atualização do Marco 69

- `IMP-008` foi concluído no gate reproduzível: trackers, Hardcover, Discord, updater Aethon, updater Suwayomi, FlareSolverr e SOCKS possuem contratos determinísticos sem credenciais reais.
- O falso aviso de update foi eliminado na origem: releases GitHub não autorizam instalação; somente o endpoint assinado do Tauri updater informa disponibilidade.
- Hardcover não inclui corpo remoto em erros 401/403 e sanitiza padrões de credencial nos demais erros.
- Discord não marca uma presença como enviada quando o cliente não iniciou e recupera em um novo start.
- O smoke ao vivo permanece opcional e não bloqueante; instalação assinada real continua sendo um gate condicional de release.
- `IMP-003` foi tratado no Marco 70. `IMP-010` permanece como otimização independente dos testes Rust de capas Discord; a cobertura atual não foi reduzida nem mascarada.

## Atualização do Marco 70

- `IMP-003` foi concluído com budgets versionados para o entry, o grafo estático inicial, CSS total, chunks comuns e navegação WebView2.
- O entry caiu de 1.399.311 para 1.153.838 bytes minificados, redução de 17,54%; gzip ficou em 305.962 bytes. O teto versionado é 1.154.000 bytes (1,10 MiB arredondado), preservando retry limitado e backoff dos chunks. EPUB, PDF e parsers permanecem fora do payload estático inicial; storage leve possui chunk próprio.
- O payload inicial completo ficou em 1.505.574 bytes minificados e 382.305 bytes gzip. O CSS total ficou em 1.033.024 bytes, com limite de regressão de 2%.
- Cinco sessões nativas descartáveis produziram medianas de 3.292 ms para shell pronto, 75,5 ms para Comics/Books após o painel ativo concluir dois frames, e 432,5 ms por ciclo completo de Search. O gate passa a bloquear regressões futuras acima de 15%; versões anteriores não expunham telemetria nativa equivalente.
- Vinte ciclos de abrir/fechar Search terminaram sem dim residual; a busca permaneceu acima do overlay (`z-index` 540 contra 90).
- A pausa global de motion-idle não atinge mais o toast. O container `slideIn` ficou visível e a barra `toastLife` avançou de `scaleX(0,956)` para `scaleX(0,844)` durante a medição.
- O relatório nativo registra SHA-256 do executável, commit-base e estado dirty. Logs de driver são removidos em sucesso e limitados a três dias após falhas.
- Evidências finais: `docs/screenshots/marco70-bundle-performance/`. Comics e Books são capturados somente após o painel ativo remover o skeleton e concluir dois frames de pintura; Search e toast também usam estados estáveis. Baselines anteriores permanecem em `marco60-final-runtime` e `marco28a-base`.

## Atualização do Marco 71

- `IMP-009` foi concluído com `pnpm release:verify`, que executa 16 gates bloqueantes serialmente e limita Vitest/Cargo para reduzir pressão de CPU e memória.
- A rodada final passou `svelte-check` 0/0, 151 arquivos/852 testes unit-jsdom, 10 arquivos/48 testes browser, 324+172 testes Rust, builds frontend/Tauri e os três gates WebView2.
- Dados e perfis de automação permaneceram em `%TEMP%`; capturas transitórias e logs de sucesso foram removidos. O status do worktree ao final foi igual ao status inicial do gate.
- Riscos ainda abertos: `IMP-001`/`IMP-007` (manga fullscreen e leitor de tela), `IMP-010` (tempo dos testes de capas Discord), `IMP-011` (copy histórica do splash), `IMP-012` (inventário frontend↔Tauri), `IMP-013` (diagnóstico dos gates de tema), `IMP-014` (capability report), `IMP-017` (concorrência Syncd futura) e `IMP-018` (política contínua de armazenamento).
- Instalação assinada e serviços externos reais permanecem condicionais; `release:smoke-live` é opcional e nunca faz parte do gate reproduzível sem opt-in.

## Atualização SR9-SR13

- A atualização automática segura de runtime e extensions está consolidada
  atrás das operações oficiais do Suwayomi.
- `ExtensionUpdateCoordinator` permanece somente como orquestrador; não foram
  adicionados scraper, classloader, manipulação de H2/classpath ou APK→JAR.
- O gate estático concentra scraping ativo em
  `SourceRuntime/SuwayomiAdapter`.
- FlareSolverr ganhou classificação estrita, ownership, contenção local e
  policy Docker determinística. O lifecycle Docker real permanece uma
  validação condicional por indisponibilidade do CLI.
- A prioridade imediata é repetir `pnpm release:verify` no HEAD atual. Os
  demais itens abertos continuam melhorias ou evidências condicionais, não
  regressões confirmadas.
