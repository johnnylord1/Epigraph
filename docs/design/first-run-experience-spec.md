# Epigraph first-run experience

## Design read

First-run de produto para leitores que podem estar migrando de outros apps ou começando do zero. A linguagem visual usa o sistema Nocturne e seus temas embutidos, mas o objetivo principal é concluir tarefas reais sem obrigar o usuário a procurar configurações pelo app.

Design dials: variance 5, motion 5, density 3.

## Direção visual

- O tema inicial é Claro. Temas escuros continuam disponíveis na primeira etapa.
- A composição usa uma única superfície contínua, com progresso horizontal e conteúdo centralizado.
- Progresso, títulos, conteúdo e ações compartilham uma malha central de 760 px; fluxos simples usam uma coluna útil de 640 px.
- A redação usa título, decisão e ação. Descrições aparecem apenas para erros, conflitos, dependências ausentes e estados assíncronos.
- Espaço, tipografia e mudança de escala organizam a hierarquia. Contornos ficam restritos a campos e estados de foco.
- Cartões aparecem somente para objetos que precisam ser escolhidos ou manipulados, como temas, extensões e obras.
- Transições de etapa usam opacidade e transformação para comunicar continuidade. Interações menores respondem com deslocamento ou escala curta.
- Todo movimento é removido quando `prefers-reduced-motion` estiver ativo.

## Princípios

- O assistente é um ponto de conveniência, não uma apresentação do produto.
- Cada tela executa ou prepara uma ação real já existente no Epigraph.
- Sincronização, backup e configuração manual são três caminhos principais exclusivos.
- O usuário pode sair e retomar exatamente da tarefa pendente.
- A descoberta de obras aparece somente quando a biblioteca permanecer vazia.
- Repositórios nunca são instalados silenciosamente.

## Fluxo comum

1. Escolher um dos temas embutidos e aplicá-lo imediatamente.
2. Escolher uma origem principal:
   - sincronizar com Android ou outro desktop;
   - importar um ou mais backups;
   - começar sem dados anteriores.
3. Executar apenas as tarefas necessárias para o caminho escolhido.
4. Se a biblioteca continuar vazia, pesquisar obras ou escolher populares das extensões instaladas.
5. Exibir um resumo do que foi configurado e abrir a biblioteca.

## Caminho de sincronização

- Reutiliza o pareamento existente: criar sessão no dispositivo atual ou conectar usando descoberta, QR ou pacote de bootstrap.
- Explica que quadrinhos, novels e livros têm permissões separadas.
- Se a sincronização trouxer uma biblioteca, segue direto para o resumo.
- Se a sessão conectada estiver vazia, segue para descoberta de obras.

## Caminho de backups

- Aceita múltiplos arquivos na mesma sessão:
  - Epigraph (`.epigraphbk`);
  - Mihon/Tachiyomi (`.tachibk`, `.proto`, `.proto.gz`);
  - LNReader (`.zip`).
- Inspeciona todos os arquivos antes de alterar o perfil.
- Mescla obras por identidade e preserva o progresso mais recente; conflitos ficam visíveis para revisão.
- Provisiona apenas repositórios, plugins e extensões realmente declarados nos backups.
- Backups do Mihon/Tachiyomi não incluem URLs de repositórios. Depois de restaurar a biblioteca, o first run solicita um repositório de quadrinhos e ao menos uma extensão compatível.
- Em uma importação mista, solicita somente os tipos de repositório ausentes. Dependências válidas encontradas em outros backups continuam preservadas.
- Depois de configurar as fontes ausentes, uma biblioteca já restaurada segue ao resumo; não obriga o usuário a passar pela descoberta de novas obras.
- Se a restauração não produzir obras utilizáveis, segue para descoberta.

## Caminho sem dados anteriores

- Permite adicionar um ou mais repositórios somente por URL manual.
- O usuário identifica se o repositório é de quadrinhos ou novels.
- Após uma URL válida, o catálogo é consultado na mesma tela e as extensões aparecem em tempo real.
- Cada extensão oferece nome, idioma, detalhes e ação de instalação.
- A descoberta só é liberada após ao menos uma extensão ser instalada.
- A etapa seguinte reúne busca nominal e populares retornados pelas extensões instaladas, com ação direta para adicionar à biblioteca.

## Estados e acessibilidade

- Loading contextual durante catálogo, instalação, pareamento, inspeção e restauração.
- Erros permanecem na etapa em que ocorreram e oferecem nova tentativa sem perder trabalho concluído.
- Cabeçalhos recebem foco após navegação; progresso usa `aria-current` e texto de estado não dependente de cor.
- Layout sem overflow horizontal em 390 px, com ações essenciais preservadas.
- `prefers-reduced-motion` remove animações não essenciais.

## Integração com o produto

- Temas: `src/lib/theme/contract.ts` e `updateSettings({ theme })`.
- Setup de quadrinhos: `src/lib/setupState.ts` e `getManagedSourceRuntime()` para stores, extensões e fontes.
- Novels: `src/lib/novels/repositoryState.ts`, packages e sources.
- Backups: módulos de `src/lib/backup/` e o planner unificado usado por Settings.
- Sincronização: API de `src/lib/syncdDesktop.ts` e comportamento de `SyncdConnectionPanel.svelte`.
- Descoberta: operações de busca e populares já usadas em `BrowseV3.svelte`.
