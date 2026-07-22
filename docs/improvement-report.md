# Relatório de Melhorias e Dívidas Técnicas — Aethon Desktop

[Matriz funcional](functional-audit.md) · [Bugs confirmados](bug-report.md) · [Guia do usuário](user-guide.md)

Este documento não redefine os bugs confirmados de `bug-report.md`. Os itens abaixo são recomendações de confiabilidade, experiência e manutenção baseadas em evidência. O estado original foi preservado e as revalidações posteriores estão registradas explicitamente.

## Prioridades recomendadas

| ID | Categoria | Problema atual e evidência | Benefício esperado | Complexidade | Risco | Prioridade | Dependências / módulos | Relação |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| IMP-001 | Cobertura de testes | O Marco 67 adicionou smoke WebView2 de Home, Library e Settings em 1280×800 e 800×600; o Marco 66 cobre EPUB/PDF. Manga fullscreen ainda depende de catálogo/capítulo real. | Detectar regressões de foco, fullscreen, teclado, diálogos e persistência no runtime real. | Média | Baixo | P2 | Tauri driver, launcher gerenciado, perfis descartáveis | BUG-003 |
| IMP-002 | Arquitetura | O Marco 65 removeu `source.settings.write`, que não possuía implementação nem chamador de produção. `source.settings.read` continua sob demanda. | Contrato publicado corresponde às capacidades reais. | Concluída | Baixo | Resolvido | `novels/contracts.ts` e testes de contrato | FUNC-063 |
| IMP-003 | Desempenho | O build de 21/07/2026 alerta para chunks >500 kB; bundle principal tem 1.316,23 kB minificado/380,10 kB gzip e CSS principal 638,96 kB. | Menor tempo de startup, parse e memória do WebView2. | Média | Médio | P2 | code splitting baseado no grafo real de imports | — |
| IMP-004 | Cobertura de testes | O Marco 66 adicionou gate WebView2 descartável para EPUB/PDF e round-trip de Books, além do contrato de fallback offline. | Provar integridade de dados, rejeição de corrupção e persistência antes de releases. | Concluída | Baixo | Resolvido | `release:certify-data`, perfil Tauri descartável | — |
| IMP-005 | Observabilidade | O snapshot original tinha 23 erros não tratados; o browser gate atual passou 44/44 sem repetir a falha. | Manter logs com fase, perfil, comando Tauri e correlação sem dados sensíveis nos novos harnesses. | Média | Baixo | P1 | Vitest browser, bridge Tauri, scripts de release | BUG-003 |
| IMP-006 | Manutenção | O baseline histórico tinha 308 erros e 11 warnings; em 21/07/2026 o `svelte-check` passou com 0 erros e 0 warnings. | Manter o type-check verde como gate de release. | Concluída | Baixo | Resolvido | Svelte/TS, readers, books, i18n, novels | BUG-002 |
| IMP-007 | Acessibilidade | O Marco 67 certificou foco inicial/circular, background `inert` e restauração nos três modais de migração, além de foco visível e ausência de clipping no smoke nativo. Falta uma auditoria manual completa com leitor de tela. | Navegação previsível sem mouse e menor risco de clipping/contraste. | Baixa | Baixo | P3 | shell, modais, readers, Settings, Activity Center | — |
| IMP-008 | Segurança | Integrações com credenciais ficaram bloqueadas; faltam fixtures/ambiente seguro que provem redaction de logs e estados de token inválido/expirado na UI. | Evitar exposição acidental e validar erro/recuperação sem usar segredos reais. | Alta | Alto | P1 | trackers, Hardcover, updater, Discord, proxy | — |
| IMP-009 | Documentação | `package.json` não possui lint dedicado e o gate de promoção de tema exige candidato, mas não há comando agregado de auditoria. | Uma lista oficial de gates, entradas e critérios de “não aplicável”. | Baixa | Baixo | P2 | scripts e documentação de release | — |
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
3. Marcos 66–70: certificar dados locais, acessibilidade nativa, integrações/localização e desempenho em lotes independentes.
4. Marco 71: executar os gates finais, reconciliar os três relatórios e publicar a matriz de riscos remanescentes.

## Estado revalidado em 21/07/2026

- Resolvidos: `BUG-001`, `BUG-002`, `BUG-003`, `BUG-004`, `BUG-005` e `BUG-006`.
- `IMP-006` foi concluído: o `svelte-check` passou com 0 erros e 0 warnings; o baseline de 308/11 permanece como histórico no BUG-002.
- `IMP-002` foi concluído no Marco 65: a escrita inexistente foi removida e a leitura de settings continua lazy, sem cache novo.
- `IMP-001` e `IMP-007` foram reduzidos no Marco 67: viewports e foco estão cobertos automaticamente; manga fullscreen e leitor de tela permanecem como validações manuais/condicionais.
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
