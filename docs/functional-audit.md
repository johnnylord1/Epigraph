# Auditoria Funcional — Epigraph Desktop

[Guia do usuário](user-guide.md) · [Bugs confirmados](bug-report.md) · [Melhorias e dívidas](improvement-report.md)

## Resumo

Auditoria executada originalmente sobre o Epigraph Desktop (Svelte 5, Tauri v2, Rust e WebView2). Epigraph Mobile, Suwayomi, Flutter, Android e iOS ficaram fora do escopo dos 63 fluxos originais. A revalidação de 09/08/2026 adicionou um smoke real Desktop↔Android em emulador: bridge Core, catálogo, capas, conteúdo, mutations e offline foram exercitados contra o perfil real. Aparelho físico continua fora do escopo certificado.

- Data: 18/07/2026
- Início: 15:07:23 (America/Sao_Paulo)
- Branch: `main`
- Commit inicial: `2acec71a5e332eb24898f01fbe99742f068169eb`
- Relação inicial com `origin/main`: `main` 113 commits à frente e 0 atrás
- Funcionalidades identificadas: **63**

| Estado padronizado | Total |
| --- | ---: |
| Funcionando | 28 |
| Funcionando parcialmente | 5 |
| Quebrada | 0 |
| Somente interface | 0 |
| Implementada, mas inacessível | 1 |
| Não implementada | 0 |
| Não foi possível testar | 9 |
| Depende de configuração ausente | 5 |
| Depende de serviço externo | 15 |
| **Total** | **63** |

Os estados descrevem o que pôde ser confirmado neste ambiente. “Funcionando” exige evidência executável específica; existência de código ou tela, isoladamente, não foi aceita como prova. Fluxos destrutivos ou que gravam dados foram reservados a perfis descartáveis.

### Revalidação após o Marco 63

O snapshot histórico abaixo foi revalidado no worktree atual. Tema, browser, formatação Rust e discovery Syncd voltaram a ficar verdes: 803/803 testes unit/jsdom, 44/44 testes browser, 76 testes Rust filtrados de discovery e o phase gate nativo passaram. O harness nativo Syncd dos Marcos 58, 61 e 62 permanece certificado em 7/7 cenários. Em 21/07/2026, o `svelte-check` também voltou a ficar verde, com 0 erros e 0 warnings; as contagens históricas permanecem registradas no BUG-002.

## Ambiente e método

- Windows 11 Pro 10.0.26200, x64, WebView2/Tauri v2.
- Node.js 25.2.0; pnpm 10.33.0; Rust/Cargo 1.94.1; Git 2.55.0.windows.3.
- O worktree vivo foi copiado para um diretório temporário do Windows, excluindo `.git`, `node_modules`, `dist`, `tmp` e `src-tauri/target`.
- Build, testes, artefatos Rust/Tauri e capturas “actual” foram gerados somente na cópia temporária.
- O perfil desktop existente foi usado apenas para inspeção. Não houve importação, mudança de preferências, progresso, categoria, backup, restauração ou pairing nele.
- Lint: **não configurado**; `package.json` não possui script dedicado e nenhuma ferramenta adicional foi instalada.
- Outros chats não são diretamente acessíveis. Mudanças recentes foram inferidas somente de Git, diffs, datas, processos, documentação, testes e comportamento observado.

## Matriz de funcionalidades

| ID | Área | Funcionalidade | Rota ou tela | Implementação encontrada | Testada | Estado | Evidência | Bug relacionado |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| FUNC-001 | Inicialização | Bootstrap do perfil e fallback de entrada | Splash/Home | Sim | Sim, web auxiliar | Funcionando parcialmente | Splash exibiu erro de servidor indisponível e ação de entrada; o ambiente web não substitui o runtime Tauri | — |
| FUNC-002 | Home | Dashboard, estados vazios e “continuar lendo” | Home | Sim | Sim | Funcionando | Render real em 1280×800 e testes de Home/estado | — |
| FUNC-003 | Home | Activity Center, histórico e notificações | Home > sino | Sim | Sim | Funcionando | `ActivityButton`, `ActivityOverlay`, testes de navegação e estado | — |
| FUNC-004 | Navegação | Barra lateral Home/Library/Browse/Downloads/Settings | Shell | Sim | Sim | Funcionando | Snapshot de acessibilidade e `navigation.test.ts` | — |
| FUNC-005 | Library | Biblioteca de comics e estado vazio | Library > Comics | Sim | Sim | Funcionando | Testes jsdom e 8/8 testes browser de `ComicsLibraryBody` passaram | — |
| FUNC-006 | Library | Biblioteca de books/novels locais | Library > Books | Sim | Sim | Funcionando | Testes unitários e 4/4 testes browser de `BooksLibraryBody` passaram | — |
| FUNC-007 | Library | Pesquisa nas bibliotecas | Library | Sim | Sim | Funcionando | Testes de toolbar e bodies de biblioteca | — |
| FUNC-008 | Library | Filtros, gêneros, ordenação e layout | Library | Sim | Sim | Funcionando | Testes de estado, toolbar e grid | — |
| FUNC-009 | Library | Categorias/pastas e atribuições | Library/Settings > Categories | Sim | Sim | Funcionando | Testes de categorias, estado e Syncd Rust | — |
| FUNC-010 | Library | Seleção em massa e ações de lote | Library | Sim | Sim | Funcionando | Testes de library bodies e contratos de seleção | — |
| FUNC-011 | Library | Atualização manual/automática da biblioteca | Library/Home | Sim | Não, sem catálogo ativo | Depende de serviço externo | Requer Suwayomi/source real; lógica e testes unitários encontrados | — |
| FUNC-012 | Importação | Importação EPUB | Library > Books | Sim | Sim, WebView2 descartável | Funcionando | Marco 66 importou um EPUB real pelo mesmo caminho pós-seleção, reiniciou o app e preservou asset, categoria, progresso e bookmark | — |
| FUNC-013 | Importação | Importação PDF | Library > Books | Sim | Sim, WebView2 descartável | Funcionando | Marco 66 importou um PDF real, persistiu leitura e validou restore em um segundo perfil isolado | — |
| FUNC-014 | Browse | Pesquisa por palavra-chave de manga | Browse > Search | Sim | Não, sem source | Depende de serviço externo | `BrowseV3` e testes de normalização; catálogo externo ausente | — |
| FUNC-015 | Browse | Discover/popular/latest para manga | Browse > Discover | Sim | Não, sem source | Depende de serviço externo | Adaptadores presentes; resposta real depende de source | — |
| FUNC-016 | Browse | Catálogo e pesquisa por source de manga | Browse > Sources | Sim | Não | Depende de serviço externo | Requer extensão/source instalada e servidor acessível | — |
| FUNC-017 | Sources | Repositórios e ciclo de extensões manga | Sources | Sim | Não | Depende de configuração ausente | Nenhum repositório de demonstração foi configurado | — |
| FUNC-018 | Sources | Repositórios/plugins de novels | Sources > Novels | Sim | Não | Depende de configuração ausente | Nenhum repositório confiável de demonstração foi configurado | — |
| FUNC-019 | Browse | Pesquisa e navegação de novels | Browse > Novels | Sim | Não | Depende de serviço externo | Runtime e adaptadores existem; source real ausente | — |
| FUNC-020 | Browse | Recomendações e Taste Insights | Browse/Home | Sim | Não | Depende de serviço externo | Adaptadores encontrados; sem dados/catalogadores externos | — |
| FUNC-021 | Detalhes | Detalhe de série manga | Series Detail | Sim | Não | Depende de serviço externo | Requer série retornada por source | — |
| FUNC-022 | Detalhes | Detalhe de novel | Novel Detail | Sim | Não | Depende de serviço externo | Requer plugin/source de novel | — |
| FUNC-023 | Detalhes | Detalhe de EPUB/PDF local | Book Detail | Sim | Sim, WebView2 descartável | Funcionando | Os dois tipos foram abertos no perfil de certificação após import/restore | — |
| FUNC-024 | Leitor | Leitor de manga e modos single/double/longstrip | Reader | Sim | Sim | Funcionando | Testes `Reader`, HUD e matriz de temas | — |
| FUNC-025 | Leitor | HUD, teclado, fullscreen, zoom e navegação | Reader | Sim | Parcial | Funcionando parcialmente | HUD/teclado/zoom cobertos; fullscreen nativo e foco em WebView2 não foram certificados manualmente | — |
| FUNC-026 | Leitor | Fallback offline de manga | Reader | Sim | Sim, contrato determinístico | Funcionando parcialmente | Loader nativo foi validado com CBZ em memória, ordem natural, tipos de imagem e revogação de blobs; falta screenshot WebView2 com capítulo real baixado | — |
| FUNC-027 | Leitor | Leitor de novel por source | Novel Reader | Sim | Não | Depende de serviço externo | Requer capítulo retornado pelo plugin | — |
| FUNC-028 | Leitor | Leitor EPUB local | Book Reader | Sim | Sim, WebView2 descartável | Funcionando | EPUB real foi importado, reaberto após restart e restaurado com estado de leitura | — |
| FUNC-029 | Leitor | Leitor PDF local | Book Reader | Sim | Sim, WebView2 descartável | Funcionando | PDF real foi importado e restaurado com progresso e bookmark | — |
| FUNC-030 | Leitor | TTS e controles de voz | Readers | Sim | Sim, componente | Funcionando | 2 testes de controles TTS passaram | — |
| FUNC-031 | Leitor | Progresso e bookmarks | Readers/Library | Sim | Sim | Funcionando | Testes frontend e Rust de merge, reset e tombstones | — |
| FUNC-032 | Downloads | Lista, busca e estados da fila | Downloads | Sim | Sim | Funcionando | 9 testes de `Downloads` passaram | — |
| FUNC-033 | Downloads | Pausar, retomar, cancelar e repetir | Downloads | Sim | Sim | Funcionando | Testes de fila e reducer de downloads | — |
| FUNC-034 | Downloads | Download offline de novels | Novel Detail/Downloads | Sim | Não | Depende de serviço externo | Requer source e conteúdo remoto | — |
| FUNC-035 | Migração | Migração individual de manga/novel | Detail > Migrate | Sim | Parcial | Depende de serviço externo | Fluxo funcional requer dois sources compatíveis; semântica modal, isolamento, ciclo e restauração de foco passaram no Marco 67 | — |
| FUNC-036 | Migração | Migração em massa | Library > Mass Migrate | Sim | Parcial | Depende de serviço externo | Fluxo funcional requer biblioteca/source destino reais; contrato de foco e background `inert` passou no Marco 67 | — |
| FUNC-037 | Dados | Criar backup unificado | Settings > Storage | Sim | Sim, payload Books | Funcionando parcialmente | Marco 66 exportou container completo de Books com checksum em perfil descartável; manga/novels/app continuam cobertos pelos testes próprios | — |
| FUNC-038 | Dados | Restaurar, sandbox e reconciliar | Settings > Storage | Sim | Sim, payload Books | Funcionando parcialmente | Restore em segundo perfil preservou books, categorias, progresso e bookmarks; corrupção foi rejeitada sem mutação | — |
| FUNC-039 | Settings | General, perfis e startup | Settings > General | Sim | Sim | Funcionando | 10 testes de Settings, captura real do componente em inglês | — |
| FUNC-040 | Settings | Appearance, temas e editor | Settings > Appearance | Sim | Sim | Funcionando | Inventário reconciliado em 2.675 tokens ativos; Syncd 98/98; gates de tema e matriz browser passaram | — |
| FUNC-041 | Settings | Keybinds e reset | Settings > Keybinds | Sim | Sim | Funcionando | Testes de Settings e estado | — |
| FUNC-042 | Settings | Preferências do Reader | Settings > Reader | Sim | Sim | Funcionando | Captura 1280×800 e testes de Settings/Reader | — |
| FUNC-043 | Settings | Preferências de Library | Settings > Library | Sim | Sim | Funcionando | Testes de Settings e biblioteca | — |
| FUNC-044 | Settings | Gerenciamento de Categories | Settings > Categories | Sim | Sim | Funcionando | Testes frontend e contratos Syncd | — |
| FUNC-045 | Settings | Regras de Content | Settings > Content | Sim | Sim | Funcionando | Captura 1280×800 e testes de Settings | — |
| FUNC-046 | Settings | Tracking e Hardcover | Settings > Tracking | Sim | Não | Depende de configuração ausente | Credenciais/tokens não fornecidos; nenhum sucesso foi simulado | — |
| FUNC-047 | Settings | Storage, caminhos, cache e uso | Settings > Storage | Sim | Sim | Funcionando | Harness aguarda estado estável; 6/6 testes browser de Settings passaram | — |
| FUNC-048 | Settings | Performance | Settings > Performance | Sim | Sim, componente | Funcionando | Testes de Settings e persistência de estado | — |
| FUNC-049 | Settings | Security, PIN, auth e proxy | Settings > Security | Sim | Parcial | Funcionando parcialmente | Contratos backend e render cobertos; mudanças persistentes e proxy real não foram exercitados | — |
| FUNC-050 | Settings | About e histórico de releases | Settings > About | Sim | Parcial | Depende de serviço externo | Tela/captura confirmada; releases dependem de GitHub/rede | — |
| FUNC-051 | Settings | Dev Tools e abertura de logs | Settings > Dev Tools | Sim | Não | Não foi possível testar | Abertura nativa de pasta/log não foi acionada | — |
| FUNC-052 | Settings | Idioma da interface | Settings > General | Sim | Parcial | Funcionando parcialmente | Interface e seletor renderizam; troca/persistência nativa não foi submetida | — |
| FUNC-053 | Integrações | Discord Rich Presence e capas | Settings > General | Sim | Não | Depende de configuração ausente | Discord não configurado; testes Rust de segurança de capas passaram | — |
| FUNC-054 | Integrações | Lifecycle e updater do Suwayomi | Startup/Settings > About | Sim | Não ao vivo | Depende de serviço externo | Gate de certificação passou 5/5; servidor vivo indisponível | — |
| FUNC-055 | Integrações | FlareSolverr local/Docker | Settings > Security | Sim | Não | Depende de configuração ausente | Serviço não configurado e Docker não foi iniciado | — |
| FUNC-056 | Syncd Desktop | Modal, resumo e detalhes de sessão | Settings > General/Syncd | Sim | Sim | Funcionando | `SyncdConnectionPanel` 2/2 e `SyncdSessionDetails` 2/2 passaram | — |
| FUNC-057 | Syncd Desktop | QR e pairing entre duas instâncias desktop | Syncd modal | Sim | Sim | Funcionando | Harness nativo com perfis isolados concluiu 7/7 cenários, incluindo QR, aprovação, restart e persistência | — |
| FUNC-058 | Syncd Desktop | Descoberta LAN e fallback manual | Syncd modal | Sim | Sim | Funcionando | Backend, mDNS, hardening LAN e phase gate com normalização canônica passaram | — |
| FUNC-059 | Syncd Desktop | Sessões, pause/resume e reconnect | Syncd modal | Sim | Sim | Funcionando | Testes Rust e componentes do painel passaram | — |
| FUNC-060 | Syncd/Core | Estado complementar de comics, novels e books | Syncd runtime / Core bridge | Sim | Parcial | Funcionando parcialmente | Rust validou snapshot/replay; emulador pareado materializou mais de 600 obras e confirmou capas, detalhes, capítulos, progresso, categorias e leitura offline. Restam aparelho físico, mudança real do inventário de extensões e restart da porta padrão | — |
| FUNC-061 | Atualização | Updater do Epigraph Desktop | Settings > About | Sim | Não | Depende de serviço externo | Requer endpoint/release e assinatura disponíveis | — |
| FUNC-062 | Resiliência | Loading, erros de rede e fallback de entrada | Splash/Shell | Sim | Sim | Funcionando | Fallback de inicialização e 44/44 testes browser passaram sem erros não tratados | — |
| FUNC-063 | Novels | Escrita de settings de plugin no runtime host | Runtime oculto | Não | Não aplicável | Removida | A capacidade não possuía chamador nem implementação; o Marco 65 removeu a ação da whitelist e preservou somente `source.settings.read` sob demanda | — |

## Resultado de build e verificações

| Comando | Resultado | Evidência resumida |
| --- | --- | --- |
| `pnpm build` | Passou | 6.396 módulos; 45,16 s em 21/07/2026; aviso de chunks > 500 kB |
| `pnpm exec svelte-check --tsconfig ./tsconfig.json` | Passou | 0 erros e 0 warnings em 21/07/2026; o baseline anterior está preservado no BUG-002 |
| `pnpm test:unit` | Passou | 141/141 arquivos; 811/811 testes unit e shell-jsdom, com dois workers, em 21/07/2026 |
| `pnpm exec vitest run --project shell-jsdom --reporter=basic` | Passou no último snapshot isolado | 38/38 arquivos; 168/168 testes; o conjunto também está incluído no gate unit/jsdom atual |
| `pnpm test:browser` | Passou | 9/9 arquivos; 44/44 testes browser em execução serial |
| `pnpm test:suwayomi-certification` | Passou | 5/5 testes |
| `pnpm theme:test-runtime-audit` | Passou | 3/3 testes |
| `pnpm theme:check-builtins` | Passou | CSS gerado está atual |
| `pnpm theme:validate-promotion` | Não aplicável | Exige `candidate.json`; nenhum pacote candidato fazia parte do worktree |
| `cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check` | Passou | Nenhum diff após aplicação e revisão do formatter nos três arquivos apontados pelo gate |
| `cargo test --manifest-path src-tauri/Cargo.toml --locked --quiet` | Passou | Após o drift: 321 + 172 = **493** testes; 0 falhas; dois testes de composição de capa levaram >60 s |
| `pnpm syncd:prepare-sidecar:release` | Passou | Sidecar Syncd release reconstruído sobre o snapshot final temporário |
| `pnpm tauri -- build --no-bundle --config src-tauri/tauri.automation.conf.json` | Passou | Executável desktop release gerado sem instalador; warning do identificador terminado em `.app` |
| `run-syncd-phase-gate.ps1` | Passou | Readiness, capacidades, auth/escopos, keepalive, backlog→live, replay, expiração, shutdown e fingerprint estável |
| `run-syncd-pairing-phase-gate.ps1` | Passou | Pairing backend saudável |
| `run-syncd-live-pairing-phase-gate.ps1` | Passou | Pairing ao vivo saudável no TLS local de auditoria |
| `run-syncd-discovery-phase-gate.ps1` | Passou | Formas mDNS com e sem ponto final são normalizadas antes da comparação; provider real chegou a `active` |
| `run-syncd-mutations-phase-gate.ps1` | Passou | Mutações Syncd validadas |
| `run-syncd-lan-hardening.ps1` | Passou | Loopback padrão, sessão temporária, limpeza de estado inválido e mismatch de perfil |
| Runner nativo de duas instâncias desktop | Passou | 7/7 cenários nos Marcos 58, 61 e 62 com `LOCALAPPDATA` isolado; ver evidências em `theme-system-audit.md` |
| Lint | Não configurado | Não existe script dedicado; nenhuma ferramenta foi instalada |

O build frontend e o type-check permanecem gates complementares: Vite transpila e empacota, enquanto o `svelte-check` valida os contratos Svelte/TypeScript. O baseline atual passa ambos; as divergências históricas de readers, books, i18n, `BlobPart`, recomendações e Hardcover foram corrigidas em lotes focados.

## Detalhamento por área

### Shell, Home e Activity Center

O shell, a navegação primária, os estados vazios e o Activity Center têm cobertura de navegação e renderização. No smoke web auxiliar a ausência do servidor local levou ao splash de erro, com ação explícita de entrada. Isso confirma o tratamento de erro, mas não certifica o ciclo Tauri/WebView2 completo.

### Library, detalhes e leitores

Library possui superfícies distintas para comics e books/novels, com busca, filtro, ordenação, categorias e seleção em massa. Os projetos `shell-jsdom` e browser passaram integralmente na revalidação atual, incluindo os bodies de Books e Comics. Leitor de manga, HUD, progresso, bookmarks e TTS têm testes verdes. O Marco 66 certificou EPUB/PDF e o round-trip de Books em WebView2 descartável; o fallback offline de manga permanece coberto por contrato determinístico, ainda sem screenshot nativa de um capítulo baixado real.

### Acessibilidade e viewports

O Marco 67 consolidou `MassMigrateModal`, `MigrateModal` e `NovelMigrateModal` sobre o mesmo limite de foco: foco inicial, Tab/Shift+Tab circular, isolamento do background com `inert` e restauração ao elemento de origem. O smoke WebView2 descartável validou Home, Library e Settings em 1280×800 e 800×600, com foco visível e zero overflow horizontal; as seis capturas e a geometria medida estão em `docs/screenshots/marco67-native-viewports/`. Os modais de migração não foram abertos no perfil nativo vazio porque dependem de sources compatíveis; essa limitação permanece explícita e não foi contornada com dados persistidos artificiais.

### Browse, Sources e integrações

Browse reúne Search, Discover e Sources para manga e novel. Os adaptadores e componentes existem, mas resultados reais dependem de Suwayomi, extensões, repositórios e serviços externos. Nenhuma credencial, repositório ou source foi criado para simular sucesso. Tracking, Hardcover, updater, Discord e FlareSolverr foram classificados de acordo com essa limitação.

### Settings e temas

General, Reader, Content e About foram renderizados em inglês a 1280×800 em ambiente de componente. O conjunto jsdom de Settings passou. O inventário foi reconciliado com os 98 tokens Syncd definidos e consumidos; o alias de divisor do modal agora resolve para o token ativo de Settings. Os gates de inventário, CSS builtin e matriz browser estão verdes.

### Syncd Desktop

O backend Rust validou autenticação, escopos, bootstrap, pairing, sessão, pause/resume/reconnect, snapshots, replay, tombstones e replicação para comics, novels e books. Os gates base, pairing, live pairing, mutações, hardening LAN e discovery passaram. O runner WebView2 com perfis isolados concluiu 7/7 cenários nos Marcos 58, 61 e 62. O risco remanescente é de concorrência do harness por portas e ownership de processos (`IMP-017`), não uma falha funcional Syncd reproduzida.

Essa evidência cobre o estado complementar atualmente suportado pelo Syncd. O Core desktop publica uma bridge profile-scoped para catálogo e conteúdo sem ler H2 ou criar uma segunda autoridade; comandos tipados encaminham as mutations oficiais. O consumidor mobile pagina e materializa por bindings existentes, resolve assets sob demanda e mantém outbox durável. O smoke pareado em emulador confirmou catálogo, capas, detalhes, capítulos, páginas, progresso, categorias e CBZ offline. A certificação permanece parcial apenas porque ainda não houve aparelho físico, mudança real do inventário de extensões nem restart do Windows para recuperar a porta padrão.

O Marco 68 localizou o contrato completo de 134 mensagens efetivamente renderizadas pelo modal em espanhol, japonês e chinês simplificado. Paridade de chaves/placeholders, termos técnicos, ausência de cópias inglesas e proteção contra endpoints/IDs em texto comum passaram em 5/5 testes; Pairing, Details e Options passaram em 4/4 testes browser e cinco baselines estáveis. A URL de exemplo permanece somente em Options, área avançada destinada à origem manual.

Para a próxima certificação nativa, recomenda-se alocar dinamicamente todas as portas locais — driver, WebDriver nativo, Suwayomi de teste e cada sidecar Syncd — e propagá-las ao runtime, QR e mDNS. `runId`, perfil descartável, diretório temporário e lista de PIDs próprios devem existir apenas no harness. No produto, a seleção precisa ser automática e invisível, sem criar artefatos em pastas comuns do usuário ou expor configuração de porta no fluxo principal. Computadores diferentes podem reutilizar a mesma porta, mas instâncias e contas no mesmo Windows compartilham o namespace TCP.

## Mudanças recentes e trabalhos de outros agentes

Não há acesso direto a outros chats. A tabela registra apenas evidências do worktree; não atribui autoria.

| Evidência | Impacto aparente | Confiança |
| --- | --- | --- |
| `SyncdConnectionPanel.svelte`, novo `SyncdConnectionPanel.test.ts` e `SyncdSessionDetails.svelte` modificados/não rastreados | Novo painel, detalhes, opções e atualização ao vivo de claims | Alto |
| `tokens.css`, `nocturne-theme.css` e `SyncdConnectionThemeTokens.test.ts` modificados | Expansão de tokens Syncd sem reconciliar inventários dos gates | Alto |
| `run-syncd-native-two-instance-automation.mjs` modificado | Automação nativa em evolução; precisa ser revalidada contra o estado final | Alto |
| `App.svelte`, `Settings.svelte`, `Cargo.toml` e `vitest.workspace.ts` modificados | Integração frontend/backend e cobertura de Syncd em andamento | Médio |
| `syncd/lifecycle.rs`, `syncd/middleware.rs`, `syncd_desktop.rs` e `syncd_replication.rs` mudaram durante a auditoria | Drift concorrente em lifecycle, middleware e replicação; arquivos foram recopiados e Rust/Tauri foram retestados | Alto |
| Commits recentes sobre remoção de legado de temas, progresso de books, covers de novels e categorias | Áreas com risco de regressão concentrado em temas e Library | Alto |
| `AGENTS.md`, `README.md`, `docs/PROJECT_BRIEF.md` e `docs/roadmap.md` já modificados | Documentação/política em andamento; preservada e não atribuída | Alto |
| `docs/theme-system-audit.md` e `docs/screenshots/marco61-syncd-pairing/` apareceram/mudaram durante a execução | Documentação e evidências concorrentes, preservadas e não usadas como autoria ou prova desta auditoria | Alto |

Drift observado: entre a elaboração inicial do plano e o baseline de execução apareceu `SyncdSessionDetails.svelte`, e o diff da automação Syncd cresceu. Depois, quatro arquivos Rust Syncd e documentação/evidências concorrentes mudaram. Esses arquivos foram recopiados para o snapshot temporário; 493 testes Rust, o sidecar release e o build Tauri foram repetidos. Às 16:55:51, as mudanças Syncd concorrentes foram consolidadas no commit `08658de` (“feat(syncd): streamline desktop pairing flow”). Os hashes SHA-256 de todos os arquivos de código desse commit coincidiram com o snapshot efetivamente testado. As únicas criações atribuíveis a esta auditoria são os quatro documentos solicitados e quatro imagens em `docs/images/user-guide/`.

## Integridade Git e preservação

### Snapshot inicial

- 18/07/2026 15:07:23 (America/Sao_Paulo), branch `main`, commit `2acec71a5e332eb24898f01fbe99742f068169eb`.
- Relação com `origin/main`: 113 commits à frente e 0 atrás; stashes vazios; staged vazio.
- Unstaged já existente: `AGENTS.md`, `README.md`, `docs/PROJECT_BRIEF.md`, `docs/roadmap.md`, automação Syncd, `Cargo.toml`, `App.svelte`, Settings/painel Syncd, arquivos de tema e `vitest.workspace.ts`.
- Untracked já existente: `src/components/settings/SyncdConnectionPanel.test.ts`.
- Processos/portas relevantes: as automações Syncd previamente observadas já haviam terminado; nenhuma porta de teste Syncd estava ocupada no baseline.

### Snapshot final

- 18/07/2026 17:07:08 (America/Sao_Paulo), branch `main`, commit `08658de13dca15b07d0e0032194e44f945a1084a`.
- Relação com `origin/main`: 114 commits à frente e 0 atrás. O avanço de um commit ocorreu concorrentemente durante a auditoria; staged e stashes permaneceram vazios.
- O status final contém mudanças preexistentes em `AGENTS.md`, `README.md`, `docs/PROJECT_BRIEF.md`, `docs/roadmap.md`, `src-tauri/Cargo.toml` e `src/App.svelte`, além dos quatro documentos e quatro imagens desta auditoria em `docs/`.
- O diff rastreado não staged reportou 4 arquivos, 9 inserções e 6 remoções; os flags adicionais de `Cargo.toml`/`App.svelte` foram preservados. Os entregáveis da auditoria permanecem untracked.
- A sessão Tauri concorrente do worktree real permaneceu intocada nas portas 1420/4567. As portas 4554/4555 e as portas temporárias Syncd usadas pela auditoria foram liberadas.
- Nenhum arquivo de código foi corrigido, formatado ou alterado pela auditoria. Builds, `dist`, `target`, perfis WebView2, logs e artefatos nativos foram criados somente na cópia temporária do Windows; essa cópia foi removida após a entrega da auditoria.

## Limitações

- Serviços externos e credenciais não foram fornecidos; não houve simulação de sucesso.
- A automação web auxilia a inspeção visual, mas não substitui WebView2/Tauri para diálogos, fullscreen, updater, arquivos e integrações nativas.
- O perfil persistente existente não recebeu submissões.
- Capturas do guia são renderizações reais do componente desktop em inglês e 1280×800, com dados de teste; não certificam por si só persistência backend.
- Não foram executados testes móveis, touch, Android/iOS, Flutter ou qualquer cliente móvel Syncd.

## Marco 69 — certificação determinística de integrações

O comando `pnpm release:certify-integrations` certifica as integrações existentes sem contas reais e com execução serial. O gate passou com 93 testes TypeScript, 5 contratos Suwayomi e 1 teste Rust focado. A cobertura inclui OAuth e operações GraphQL de trackers, autorização/cache/rate limit do Hardcover, ausência e recuperação do Discord, privacidade e SSRF de capas, saúde/timeout/recuperação do FlareSolverr, validação SOCKS e políticas dos dois updaters.

O updater do Epigraph agora separa histórico público de autoridade de atualização: `list_releases` filtra drafts, prereleases e tags instáveis, enquanto apenas `check_epigraph_update`, baseado no endpoint configurado e assinado, pode anunciar uma atualização. A instalação nativa exige que a versão escolhida continue sendo a oferecida pelo endpoint assinado. Assim, uma release pública mais nova, mas sem manifesto autorizado, aparece apenas como histórico e não como atualização instalável.

O gate sanitiza caminhos do workspace e padrões de credenciais antes de imprimir subprocessos. `release:smoke-live` permanece opcional e exige opt-in explícito com endpoints descartáveis; nenhuma conta, cookie, token ou serviço real é necessário para o gate bloqueante.

A tela Settings > About passou em 6/6 testes browser. A baseline foi atualizada somente para registrar o estado saudável agora verificável, “You're on the latest version”; geometria, superfícies e hierarquia permaneceram equivalentes.

## Marco 70 — certificação de bundle e navegação

`release:check-bundles` percorre recursivamente o grafo de imports estáticos, mede entry, payload inicial, gzip, CSS total e chunks comuns. O gate passou com redução de 17,57% no entry e sem vendors de EPUB, PDF ou parsers no carregamento inicial.

`release:check-navigation` usa Tauri/WebView2, Core local simulado e cinco perfis descartáveis. O gate aguarda o painel ativo sem skeleton e dois frames de pintura antes de concluir a troca Comics/Books, além de cobrir vinte ciclos de Search, dim, geometria, overflow e toast em motion-idle. O primeiro baseline instrumentado passou na rodada final com medianas de 3.292 ms, 75,5 ms e 432,5 ms; ele bloqueia regressões futuras de 15%, sem alegar comparação temporal com builds que não possuíam a mesma telemetria. O `report.json` vincula as evidências ao SHA-256 do executável e ao commit-base.

## Marco 71 — matriz final de certificação

`pnpm release:verify` executa os gates bloqueantes em ordem, com um worker de Vitest, um job Cargo e um thread de teste Rust. A execução final de 22/07/2026 passou 16/16 etapas e preservou o worktree, perfis normais e diretórios de usuário.

| Classe | Cobertura certificada | Resultado |
| --- | --- | --- |
| Automática | Svelte/TypeScript, unit/jsdom, browser components, builtins, runtime de temas, Suwayomi, integrações determinísticas, bundles, Rust e builds | Verde: 151/852 unit-jsdom, 10/48 browser, 324+172 Rust |
| WebView2 descartável | Import/restore EPUB e PDF, corrupção sem mutação, viewports 1280×800 e 800×600, Search dim, Comics/Books, toast e navegação | Verde: 2 livros, 2 progressos, 2 bookmarks, 6 checks de viewport e 5 sessões de navegação |
| Condicional de release | Instalação real do updater Epigraph a partir de manifesto/assinatura de produção | Não executada sem chave e pacote assinados; contratos de versão, manifesto e assinatura permanecem bloqueantes |
| Smoke ao vivo opcional | Trackers, Hardcover, Discord, proxies e serviços externos reais | Não executado sem opt-in/credenciais; os transports falsos e servidores locais são o gate reproduzível |
| Manual residual | Leitor de tela e manga/fullscreen com catálogo real | Pendente, sem regressão comprovada nos smokes disponíveis |

Evidências visuais versionadas permanecem em `docs/screenshots/marco60-final-runtime/`, `marco61-syncd-pairing/`, `marco62-syncd-hardening/`, `marco67-native-viewports/`, `marco70-bundle-performance/` e nas baselines revisadas em `src/test/browser/__screenshots__/custom/`. O Marco 71 reexecutou a build atual e validou estado e geometria em capturas temporárias WebView2, descartadas depois do gate para não versionar duplicatas ou artefatos de perfil. Comparação pixel automatizada permanece restrita às baselines browser revisadas.

## SR9-SR13 — runtime e extensions Suwayomi

Em 28/07/2026, a sequência SR9-SR13 foi concluída e commitada. O gate
determinístico instalou extensions somente pelas operações oficiais do
Suwayomi, manteve uma JVM e uma source por vez, repetiu restart com 27 source
IDs estáveis e validou Local Source em pesquisa, detalhes, capítulos e páginas
sem acessar websites.

Promoção de runtime e updates de extensions usam maintenance, snapshot,
journal e rollback conjunto. As operações ativas de scraping atravessam
`SourceRuntime/SuwayomiAdapter`. FlareSolverr permanece opcional: Suwayomi o
utiliza para manga e o runtime LNReader separado mantém sua própria recuperação
anti-bot.

Os testes proporcionais, browser, `svelte-check`, Cargo e build passaram. O
gate agregado `pnpm release:verify` passou no HEAD atual em 01/08/2026. Docker
FlareSolverr real, instalação assinada, serviços live opt-in, manga/fullscreen
e leitor de tela permanecem condicionais.

## Marco 72F1 - ownership de comandos do Reader

O shell e os readers deixaram de processar simultaneamente zoom e fullscreen.
Um dispatcher mantem exatamente um scope ativo (`manga`, `book` ou `novel`),
ignora cleanup atrasado de um reader anterior e remove o listener global quando
o reader ativo desmonta. Manga, EPUB/PDF e novels usam os keybinds existentes;
controles interativos e conteudo editavel nao disparam navegacao de pagina.

O comportamento de `Escape` em fullscreen permanece sob a prioridade ja
existente do shell. `overlayBars` nao foi alterado, ocultado, depreciado nem
removido. RAFs, respostas assincronas antigas, pagina PDF predominante,
deduplicacao de progresso e `autoNextChapter` pertencem ao Marco 72F2.

## Marco 72F2 - runtime do Reader

O longstrip mede pagina/chapter uma vez por frame, limita e cancela a retomada
por RAF e mantem preload em 80% separado do auto-append no fim real do
capitulo. Cada capitulo pode ser anexado automaticamente apenas uma vez por
sessao. Timers, RAFs, fetches e continuations de fade deixam de alterar uma
sessao desmontada.

O BookReader limita paginas restauradas, escolhe deterministicamente a pagina
PDF com maior area visivel, desempata pela proximidade do centro e deduplica
persistencia logicamente identica. Render, reflow, imagens e eventos EPUB
validam token, documento e livro antes de publicar estado. O NovelReader usa
snapshot imutavel do capitulo e generation IDs para impedir que uma resposta
antiga sobrescreva HTML, cache ou progresso do capitulo atual. O idle lock
tambem reconhece o NovelReader ativo.

`overlayBars`, `markReadOnNext`, prefetch, HUD, TTS e a regra historica de
marcar novel como lida apos carga bem-sucedida foram preservados. Qualquer
implementacao, depreciacao ou remocao de `overlayBars` continua fora deste
marco e exige decisao de produto separada.

## Marco 72G1 - telemetria direcional da Library

O gate WebView2 da Library agora separa `Comics -> Books` de
`Books -> Comics` e classifica cada destino como cold, warm ou cached. Cada
amostra registra clique, atualizacao observada do store, commit visual, dois
frames estaveis, long tasks, layout shifts, recursos, heap, DOM, cards e
requests ao Core local. Quando WebView2Driver disponibiliza CDP, o relatorio
inclui contagens e duracoes de layout, recalc style, script e task.

Na rodada final com cinco perfis descartaveis, a mediana agregada da troca foi
21,35 ms. `Comics -> Books` apresentou p50 cold de 165 ms e cached de 19,85 ms;
`Books -> Comics`, p50 cold de 105,4 ms e cached de 16,9 ms. Nao houve long task.
Depois de vinte trocas, RAFs pendentes permaneceram em zero, cards ficaram
estaveis e listeners/observers alternaram apenas com o painel ativo, sem
crescimento monotonicamente acumulado. O heap apresentou GC durante o ciclo e
terminou 51.198 bytes abaixo da primeira amostra.

As capturas reais de Comics e Books permaneceram geometricamente integras em
`docs/screenshots/marco72g1-library-telemetry/`. O gate historico de startup,
entretanto, permaneceu vermelho nas repeticoes: mediana final de 5.119 ms
contra limite de 4.388,4 ms. Uma amostra de diagnostico localizou 4.332 ms
entre a criacao da sessao e a disponibilidade da bridge de auditoria; depois
disso, runtime state, splash e shell estabilizaram em 435 ms. O relatorio final
tambem persiste as fases das cinco sessoes. O budget nao foi
elevado. O Marco 72G2 deve investigar o caminho inicial do app separadamente
dos custos de Library e o 72H continua bloqueado enquanto esse gate nao voltar
a verde.

## Marco 72G2 - gate dirigido por ownership

O diagnostico do 72G1 nao justificou alterar montagem, cache ou lifecycle da
Library: o custo pertencente ao app ja estava abaixo dos budgets e nao havia
crescimento de listeners, observers, RAFs ou DOM. O 72G2, portanto, preservou
o codigo de producao e corrigiu o contrato de medicao em vez de introduzir uma
otimizacao especulativa.

O harness passou a usar dez perfis descartaveis, com cinco amostras cold por
direcao, e separa trabalho do app (`input -> state -> commit`) da espera de
apresentacao do WebView2. Startup total e p95 dominado pelo compositor
continuam registrados, mas sao observacionais; shell activation, trabalho da
Library, estado da Search e bundles permanecem bloqueantes. A medicao de heap
agora forca GC via CDP, descarta referencias criadas pelo proprio hook e exige
retencao inferior a 2 MiB e 15%. Sem suporte ao comando de GC, a amostra nao
e apresentada como heap observado.

No passe final real em WebView2, posicionado no monitor `DISPLAY3`, a Library
teve mediana agregada de 27,95 ms. O p50 app-owned cold foi 11,6 ms em
`Comics -> Books` e 11,7 ms em `Books -> Comics`; os p95 app-owned warm/cached
ficaram entre 14,58 ms e 21,54 ms. Houve uma long task isolada de 59 ms,
dentro dos limites de 100 ms por tarefa e 200 ms acumulados; RAFs pendentes
permaneceram em zero e listeners/observers nao cresceram monotonicamente. O
heap retido apos vinte ciclos cresceu 959.542 bytes (7,94%), dentro dos dois
limites.

O estado de abrir/fechar Search apresentou mediana de 7,95 ms em vinte ciclos,
sem dim residual; o ciclo visual completo foi 449,5 ms e permaneceu registrado
separadamente. O shell activation mediano foi 494,5 ms. A mediana wall-clock
total de startup foi 5.120,5 ms e ficou acima da referencia historica, mas
permanece observacional porque 4.626 ms ocorreram antes ou fora da ativacao do
shell pertencente ao app.

As evidencias finais em
`docs/screenshots/marco72g2-library-performance/` mostram Comics, Books, Search
com a barra acima do dim e toast com barra de vida ativa. O relatorio
`report.json` registra todos os samples, phases, budgets e zero falha.

## Marco 72H - gate estrutural consolidado

Em 29/07/2026, os gates do HEAD atual foram reexecutados de forma serial, com
um worker Vitest, um job Cargo e perfis descartáveis. `svelte-check` permaneceu
em 0 erros/0 warnings; os testes unit/jsdom passaram em 189 arquivos com 1.118
testes e um canário live explicitamente ignorado; os 10 arquivos browser
passaram 48/48. O workflow determinístico Suwayomi V21/V23 concluiu instalação
oficial, restart, 27 source IDs estáveis, Local Source, shutdown e cleanup sem
usar websites como fonte de verdade.

A suíte Rust passou integralmente após uma falha intermitente inicial do
binário Syncd: a repetição isolada passou 176/176 e a repetição completa também
ficou verde. Não houve alteração de código Rust nem redução de cobertura. Build
frontend e Tauri de automação passaram; o gate de dados preservou EPUB/PDF,
dois progressos e dois bookmarks e rejeitou restore corrompido. O smoke nativo
passou 6/6 em 1280x800 e 800x600.

O provider browser deixou de depender da porta fixa 63315: o sistema aloca uma
porta livre em `127.0.0.1` para cada servidor. Os smokes
nativos usam DISPLAY3 (`x=1980`, `y=80`) e não abrem console auxiliar visível.

Na medição final da Library, a mediana agregada foi 10,65 ms; os p95 app-owned
warm/cached ficaram entre 3,35 ms e 4,92 ms. O primeiro frame estável ficou
abaixo do teto direcional de 92 ms; o segundo frame foi mantido como métrica
observacional do compositor. Não houve long task, RAF pendente
ou crescimento monotônico de listeners/observers; o heap retido cresceu
998.490 bytes (8,33%). O wall-clock warm Comics -> Books chegou a 104,8 ms por
adiamento de `requestAnimationFrame` no compositor, enquanto commit, layout,
script e task já estavam concluídos. A mediana global, app-owned p95, long
tasks, heap e lifecycle continuam bloqueantes.

Search completou vinte ciclos com mediana de estado de 2,65 ms, sem dim
residual, e o toast manteve `toastLife` em execução. Evidências finais úteis
foram preservadas em `docs/screenshots/marco72h-final/`; relatórios temporários,
perfis e logs não são artefatos de release.

As capturas `home-1280x800.png` e `home-800x600.png` representam o perfil
descartável vazio usado pelo smoke: os cards de Continue Reading ficam em
placeholder por falta de dados, e não indicam uma tela de Home carregando
indefinidamente. A limitação é registrada porque o gate não cria dados de
usuário artificialmente.

Continuam condicionais, e não foram apresentados como certificados: instalação
assinada real, serviços externos live, Docker FlareSolverr real, manga/fullscreen
dependente de catálogo e auditoria manual com leitor de tela. O registro acima
descreve a execução constituinte de 29/07/2026; a execução agregada foi
repetida no HEAD atual em 01/08/2026 e passou os 16 gates bloqueantes, incluindo
certificação de dados e limpeza final.

### Revalidação do HEAD atual — 01/08/2026

- Commit auditado: `50f1c8f6ea6c91da2c19113a826a42d187b668f1`.
- `svelte-check`: 0 erros e 0 warnings.
- Unit/jsdom: 189 arquivos, 1.119 testes aprovados e 1 skip; browser: 10
  arquivos, 48/48 aprovados.
- Rust: 349 testes do Epigraph e 176 do Syncd aprovados. Build frontend, Tauri
  de automação e os gates determinísticos de dados, fontes, integrações e
  bundles passaram.
- WebView2 nativo: dados locais preservaram EPUB/PDF, progresso e bookmarks;
  restore corrompido foi rejeitado; viewport passou 6/6; navegação passou sem
  dim residual na Search, com toast animado e sem crescimento monotônico de
  listeners/observers.
- Auditoria visual adicional em DISPLAY3: Home, Library e Settings foram
  capturados em 1280×800 e 800×600. Não houve clipping horizontal ou foco fora
  da viewport. O perfil vazio explica placeholders e Library sem títulos.
- A mediana de startup total acima da referência histórica é observacional e
  não bloqueia: shell activation, transições de Library, Search e budgets
  app-owned permaneceram dentro do contrato.

## Internacionalizacao - 01/08/2026

- Os catalogos `en`, `es`, `ja`, `pt-BR` e `zh-CN` permanecem alinhados com
  2.646 chaves cada.
- Settings, estados do runtime Suwayomi, updater, Browse e Sources agora usam
  mensagens catalogadas nos fluxos ativos de `es`, `ja` e `zh-CN`.
- O fallback de locale normaliza identificadores com `Intl.Locale` e escolhe o
  catalogo mais proximo antes de cair em English.
- `src/lib/i18n/catalogContract.test.ts` valida referencias estaticas de
  producao, paridade de chaves e ausencia de catalogos incompletos. Os testes
  de runtime tambem validam placeholders.
- Nomes proprios, URLs, formatos, unidades, nomes de icones e termos tecnicos
  como `EPUB`, `PDF`, `HUD`, `Nocturne`, `Host` e `Manga` permanecem sem
  traducao quando essa e a forma correta de apresenta-los.

## Correção da fronteira Core/Mobile — 04/08/2026

O desktop continua consultando catálogo, categorias e capítulos diretamente
pela autoridade Suwayomi através do caminho GraphQL autenticado. O Core agora
também expõe a ponte read-only `GET /v1/suwayomi/catalog`, com operações
allowlisted para `library`, `categories` e `chapters`, sempre limitadas ao
perfil autenticado e sem ler H2. O mesmo proxy aceita as mutations oficiais
usadas pelo consumidor mobile.

Isso fecha a parte desktop da bridge Suwayomi -> Core e a primeira parte do
consumidor mobile. O Epigraph Mobile agora pagina `library`, `categories` e `chapters`,
materializa as entidades por bindings existentes, resolve capas através do
Core autenticado e grava Library, categorias remotas e progresso de capítulos
na fila oficial `epigraph_suwayomi_mutation_queue`. A fila é transacional com a
alteração local, filtrada por perfil, sequencial, confirmada por releitura e
mantém retry ou bloqueio sanitizado conforme o erro. Testes cobrem sucesso,
retry transitório, confirmação de progresso e isolamento entre perfis.

O bootstrap pareado, as mutations de progresso/categoria e o download/leitura
offline foram confirmados em emulador contra o perfil real. O relatório deve
manter a certificação como **parcial** até cobrir aparelho físico, uma mudança
real no inventário de extensões e a recuperação da porta padrão após restart.
O capability `supportsSuwayomiCatalog` agora
separa a bridge read-only do proxy GraphQL, e o cliente deriva o scope de
comics do perfil embutido na identidade catalogada em vez de assumir `main`.
Criação/renomeação de categorias e downloads do servidor permanecem fora desta
vertical até existir contrato oficial e confirmação equivalente.
