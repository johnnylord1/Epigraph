# Auditoria Funcional — Aethon Desktop

[Guia do usuário](user-guide.md) · [Bugs confirmados](bug-report.md) · [Melhorias e dívidas](improvement-report.md)

## Resumo

Auditoria executada exclusivamente sobre o Aethon Desktop (Svelte 5, Tauri v2, Rust e WebView2). Aethon Mobile, Sorayomi, Flutter, Android e iOS ficaram fora do escopo. Syncd foi considerado somente como funcionalidade entre instâncias desktop.

- Data: 18/07/2026
- Início: 15:07:23 (America/Sao_Paulo)
- Branch: `main`
- Commit inicial: `2acec71a5e332eb24898f01fbe99742f068169eb`
- Relação inicial com `origin/main`: `main` 113 commits à frente e 0 atrás
- Funcionalidades identificadas: **63**

| Estado padronizado | Total |
| --- | ---: |
| Funcionando | 29 |
| Funcionando parcialmente | 4 |
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
| FUNC-060 | Syncd Desktop | Replicação de comics, novels e books | Syncd runtime | Sim | Sim, backend | Funcionando | Rust validou snapshot, replay, progresso, bookmarks, categorias, tombstones e assets | — |
| FUNC-061 | Atualização | Updater do Aethon Desktop | Settings > About | Sim | Não | Depende de serviço externo | Requer endpoint/release e assinatura disponíveis | — |
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

O updater do Aethon agora separa histórico público de autoridade de atualização: `list_releases` filtra drafts, prereleases e tags instáveis, enquanto apenas `check_aethon_update`, baseado no endpoint configurado e assinado, pode anunciar uma atualização. A instalação nativa exige que a versão escolhida continue sendo a oferecida pelo endpoint assinado. Assim, uma release pública mais nova, mas sem manifesto autorizado, aparece apenas como histórico e não como atualização instalável.

O gate sanitiza caminhos do workspace e padrões de credenciais antes de imprimir subprocessos. `release:smoke-live` permanece opcional e exige opt-in explícito com endpoints descartáveis; nenhuma conta, cookie, token ou serviço real é necessário para o gate bloqueante.

A tela Settings > About passou em 6/6 testes browser. A baseline foi atualizada somente para registrar o estado saudável agora verificável, “You're on the latest version”; geometria, superfícies e hierarquia permaneceram equivalentes.

## Marco 70 — certificação de bundle e navegação

`release:check-bundles` percorre recursivamente o grafo de imports estáticos, mede entry, payload inicial, gzip, CSS total e chunks comuns. O gate passou com redução de 17,57% no entry e sem vendors de EPUB, PDF ou parsers no carregamento inicial.

`release:check-navigation` usa Tauri/WebView2, Core local simulado e cinco perfis descartáveis. O gate aguarda o painel ativo sem skeleton e dois frames de pintura antes de concluir a troca Comics/Books, além de cobrir vinte ciclos de Search, dim, geometria, overflow e toast em motion-idle. O primeiro baseline instrumentado passou na rodada final com medianas de 3.292 ms, 75,5 ms e 432,5 ms; ele bloqueia regressões futuras de 15%, sem alegar comparação temporal com builds que não possuíam a mesma telemetria. O `report.json` vincula as evidências ao SHA-256 do executável e ao commit-base.
