# Comentários no leitor — plano técnico (mobile primeiro)

Status: proposta, nada implementado. Escrito em 2026-10-25.

## 1. Objetivo

Um botão **Comentários** no leitor que mostra, num painel do próprio app, os comentários que os
leitores deixaram no site da fonte, para o **capítulo** aberto e para a **obra**: usuário, avatar,
curtidas, data e respostas em árvore. A v1 é **só leitura**; comentar e curtir continuam no site
("Abrir no site para comentar").

Fora do escopo da v1: postar, curtir, login em Disqus/WordPress, contagem prévia no botão,
livros locais (EPUB/PDF não têm site), desktop.

## 2. Pesquisa

- Nenhum leitor da linhagem Tachiyomi (Mihon, J2K, SY, Komikku, Kotatsu, Mangayomi) tem
  comentários nativos. A API de extensões só modela obra, capítulo e página, e o Suwayomi só expõe
  `realUrl`; o comentário nunca chega ao app por esse caminho.
- O único projeto parecido é o Uchiyomi (servidor caseiro, MPL-2.0), mas os comentários dele são
  entre usuários do próprio servidor, não os do site
  ([PR #309](https://github.com/AngeloSha/uchiyomi/pull/309)). A ideia de UI aproveitável: botão na
  barra do topo com contagem e acesso no fim do capítulo.
- Os sites não inventam sistemas próprios na maioria: usam Disqus, os comentários nativos do
  WordPress (com ou sem wpDiscuz) ou, mais raro, comentários do Facebook. Temas de mangá em
  WordPress (Madara, MangaThemesia) oferecem essas opções na configuração do tema.
- MangaDex: a API só dá o id do tópico e o número de respostas via `/statistics`; o texto fica no
  fórum ([docs](https://api.mangadex.org/docs/01-concepts/comments)).

### Verificado na prática (2026-10-25)

- A página `https://disqus.com/embed/comments/?base=default&f=<forum>&t_u=<url>` (sem login, sem
  chave) traz um `<script id="disqus-threadData" type="text/json">` com `cursor` e
  `response.{thread, posts}`. Também traz `disqus-forumData`.
- O script oficial do embed (`embedv2.js`) usa a chave pública
  `E8Uh5l5f…` contra `https://disqus.com/api/3.0/threads/listPostsThreaded` para as páginas
  seguintes. Chamada testada: responde `code: 0` com `cursor {hasNext, next, total}`.
- Cada post traz: `id`, `parent`, `depth`, `createdAt`, `likes`, `dislikes`, `points`,
  `message` (HTML), **`raw_message` (texto puro)**, `media`, `hasMore`, `isDeleted`,
  `isDeletedByAuthor`, `isEdited`, `isSpam`, `isApproved`, `isFlagged`; e `author` com `name`,
  `username`, `avatar`, `isAnonymous`, `profileUrl`.
- Em sites WordPress com o plugin do Disqus, o identificador do tópico vem como
  `"<post_id> <guid>"` (visto em threads reais de MangaThemesia e mangakakalot).
- `curl` direto nas páginas de capítulo voltou 403/página de desafio: **todo acesso ao site precisa
  passar pelo cliente com Cloudflare do app**. Um dos sites testados redirecionava para um domínio de
  tráfego suspeito, então as fixtures devem ser capturadas pelo próprio app (§9), nunca navegando.

Não verificado ainda: marcação exata de WordPress nativo e wpDiscuz nas fontes que você usa. A fase 0
mede isso antes de escrever parser.

## 3. Sistemas suportados e como ler cada um

| Sistema | Detecção na página | Leitura | Curtidas | Ordem |
|---|---|---|---|---|
| Disqus | `<forum>.disqus.com/embed.js`, `disqus_shortname`, `disqus_config` (`this.page.identifier`, `this.page.url`), `#disqus_thread` | 1ª página: embed (`f`, `t_i`, `t_u`); seguintes: `listPostsThreaded` com `cursor` | sim | popular, recentes, antigos |
| WordPress nativo | `ol/ul.comment-list > li.comment`, `#comments`, `<link rel="https://api.w.org/">`, `body.postid-<id>` | Preferir `GET /wp-json/wp/v2/comments?post=<id>&per_page=100&page=n` (JSON estável); cair para HTML da página | não | cronológica |
| wpDiscuz | `#wpdcom`, `.wpd-comment`, `wpdiscuzAjaxObj` | HTML da página (`.wpd-comment-author`, `.wpd-comment-text`, `.wpd-vote-result`); sem API pública oficial | sim (votos) | a do site |
| Facebook | `fb-comments`, `connect.facebook.net` | não suportado (exige SDK/login) → "Abrir no site" | — | — |
| Desconhecido | nada acima | "Abrir no site" | — | — |

Adaptadores por site (MangaDex fórum, Webtoons, Asura, Bato) ficam para depois e só entram se a
fase 0 mostrar que valem a pena.

## 4. Arquitetura (mobile)

Pacote novo `epigraph.comments`, sem tocar no SQLDelight e sem sync:

```
epigraph/comments/
  model/      CommentScope (CHAPTER, WORK), Comment, CommentAuthor, CommentPage, CommentSort,
              CommentsState (Loading, Loaded, Empty, Unsupported, Blocked, Offline, Failed)
  fetch/      CommentPageFetcher      — baixa o HTML da página com limites e o cliente certo
              CommentHttpPolicy       — escolhe cliente, timeouts, limite de bytes, só HTTPS
  provider/   CommentProvider         — detect(page) / load(match, cursor, sort)
              DisqusProvider, WordPressProvider, WpDiscuzProvider
  render/     CommentTextRenderer     — texto/HTML permitido → AnnotatedString (spoiler, link)
  CommentsRepository                  — orquestra, cache em memória, cancelamento
  ui/         CommentsSheet (Compose), CommentsScreenModel
  di/         commentsModule (Koin)
```

### Fluxo

1. URL: capítulo = `ReaderViewModel.getChapterUrl()` (já usado pelo botão WebView); obra =
   `source.getMangaUrl(manga)`. Para quadrinhos vindos do Core, `chapter.url`/`manga.url` já é o
   `realUrl` do Suwayomi (`SuwayomiCatalogSync`).
2. `CommentPageFetcher` baixa só o HTML (sem imagens), no máximo 2 MiB, timeout de 15 s,
   cancelável.
3. Os providers rodam `detect()` em ordem fixa (Disqus → wpDiscuz → WordPress → Facebook) e o
   primeiro que casar responde.
4. O provider busca os comentários, normaliza para `Comment` e devolve `CommentPage` com cursor.
5. O repositório guarda o resultado em cache e a UI mostra.

### Escolha do cliente HTTP (ponto de segurança)

- Página do site: `(source as? HttpSource)?.client` **somente se** o host da URL for o host da
  fonte; senão `NetworkHelper.client` (que já resolve Cloudflare via WebView).
- **Nunca** usar o cliente de `EpigraphCoreSource`/gateway do Core para a URL externa: ele carrega a
  autenticação do PC. Teste dedicado garante que nenhum header/cookie do Core sai para outro host.
- Disqus: cliente próprio derivado de `NetworkHelper.client` **sem cookie jar** (não levar cookies
  da fonte ao Disqus nem guardar os do Disqus), `Referer` = URL da página, limite de 4 req/s.
- Só `https`; recusar hosts privados/loopback ao seguir links da página (mesma regra do broker de
  novel); limite de redirecionamentos; resposta JSON máxima de 1 MiB por página de comentários.

### Cache e armazenamento

- LRU em memória: 20 tópicos, validade de 10 min, chave `(scope, url, sort)`. Fechar e reabrir o
  painel no mesmo capítulo não refaz a busca.
- Nada em banco, backup ou sync. Sem migração. Nenhum arquivo em disco além do cache de imagens do
  Coil (avatares), que já é limitado.

## 5. Renderização e segurança do conteúdo

- Disqus: usar `raw_message` (texto puro) e só enriquecer com o que o `message` HTML tem de
  permitido: link, negrito, itálico, `<spoiler>`, quebra de linha, citação.
- WordPress/wpDiscuz: HTML passa por `Jsoup` + `Safelist` mínima (mesma abordagem do
  `NovelHtmlSanitizer`), depois vira `AnnotatedString`. **Sem WebView, sem JavaScript, sem bridge.**
- Links abrem no `WebViewActivity` existente ou no navegador; nunca executam nada no painel.
- Imagens/GIF dentro de comentário (`media` do Disqus): na v1 aparecem como "imagem" tocável que
  abre o link; sem carregamento automático.
- Avatares: Coil, 40 dp, placeholder estável em falha (regra de capas), sem tentar de novo em loop.
- Respeitar o site: esconder `isSpam`/não aprovados; mostrar "Comentário removido" para
  `isDeleted` com respostas; spoiler borrado até tocar.
- Limites: 10 000 caracteres por comentário (com "ver mais"), profundidade visual máxima 4 (mais
  fundo vira "respondendo a @fulano").

## 6. Interface

Seguir `DESIGN.md` (bottom sheet `surface`, topo `r-l`, alça; botões `shapes.small`; estados
vazio/erro da tabela de componentes) e o padrão do `QuotesSheet` (Compose dentro do
`ReaderActivity`).

- **Entrada:** novo `ReaderBottomButton.Comments("cm")` na barra inferior e item no menu do
  leitor. Na tela da obra, ação "Comentários" abrindo direto na aba Obra (fase 3).
- **Painel:** abas Capítulo | Obra; cabeçalho com contagem e ordem (Populares, Recentes, Antigos,
  conforme o provider); lista com avatar, nome, tempo relativo, texto, curtidas, "ver N respostas".
- **Rodapé fixo:** "Abrir no site para comentar".
- **Estados:**
  - Carregando: esqueleto estático.
  - Vazio: "Ninguém comentou neste capítulo ainda" + "Abrir no site".
  - Sem suporte: "Este site usa um sistema de comentários que o Epigraph ainda não lê" + "Abrir no site".
  - Bloqueado (Cloudflare/desafio): "O site pediu verificação" + "Abrir no site para liberar"; depois
    de liberar, "Tentar de novo" reaproveita os cookies.
  - Sem internet / falhou: mensagem curta + "Tentar de novo".
- **Leitor:** abrir o painel não mexe na página atual nem no progresso; gestos do leitor ficam
  pausados com o painel aberto; voltar fecha o painel.
- **Acessibilidade:** alvos de 48 dp, ordem de leitura do TalkBack (autor → texto → curtidas),
  descrições nos botões, texto respeita a escala de fonte.
- **Sem pré-busca:** nada é baixado até tocar no botão (dados móveis e privacidade).

## 7. Regras do projeto atendidas

- Sem mudança de banco, sync, backup ou contrato com o desktop.
- Conteúdo remoto tratado como dado: allowlist, sem JavaScript, sem bridge privilegiada.
- Segredos do Core nunca vão a hosts externos; cookies de terceiros isolados.
- Estados explícitos em vez de carregamento infinito; erros em linguagem do usuário.
- Crescimento limitado: cache em memória com teto, nada novo em disco.
- Koin para DI, Voyager/Compose para UI; nada de Hilt/Room/Navigation.

## 8. Fases

| Fase | Entrega | Tamanho |
|---|---|---|
| 0. Levantamento | Ferramenta só de debug que roda os detectores nas fontes da sua biblioteca no emulador e lista qual sistema cada uma usa (sem guardar conteúdo). Define a ordem de prioridade com dado real. | pequeno |
| 1. Base + Disqus | Modelos, fetcher com política de cliente, repositório com cache, `DisqusProvider`, painel com aba Capítulo, estados e "Abrir no site". | médio |
| 2. WordPress | `WordPressProvider` (REST + HTML) e `WpDiscuzProvider`. | médio |
| 3. Obra e polimento | Aba Obra, entrada pela tela da obra, ordenação, spoiler, "ver respostas" paginado, leitor de novels. | pequeno/médio |
| 4. Opcional | Adaptadores por site que a fase 0 apontar; porte para o desktop (no Core, servindo também o celular pareado). | a definir |

Cada fase fecha com testes, smoke no emulador e um commit; push só no fim de um lote, com seu ok.

## 9. Testes

- **Fixtures:** HTML/JSON reais capturados pelo app no emulador (fase 0), com nomes e avatares
  trocados por valores fictícios antes de entrar no repositório.
- **Unitários:** detecção de cada sistema (incluindo páginas com dois sistemas e com nenhum);
  parsing e paginação por cursor; árvore de respostas; posts removidos/spam; limites de tamanho.
- **Segurança:** payloads de XSS no HTML de comentário (script, `on*`, `javascript:`, iframe,
  svg) saem como texto; cliente do Core nunca usado para host externo; Disqus sem cookies; recusa de
  `http://` e de hosts privados.
- **Repositório:** cache acerta e expira; cancelar ao fechar o painel; trocar de capítulo cancela a
  busca anterior; erro transitório não apaga resultado em cache.
- **UI:** teste Compose dos estados (carregando, vazio, sem suporte, bloqueado, erro, lista).
- **Emulador:** um capítulo com Disqus, um com WordPress nativo, um sem comentários e um
  quadrinho vindo do Core. Nunca no celular físico.

## 10. Riscos

- **Disqus muda o embed ou a chave pública:** a leitura quebra para todos os sites Disqus de uma
  vez. Mitigação: detecção falha vira "Abrir no site", não erro; a chave e o formato ficam isolados
  num único arquivo para trocar rápido.
- **Termos de uso:** o Disqus não autoriza clientes de terceiros com a chave do embed. Para uso
  pessoal o risco é baixo; como o app é público, a chave pode ser bloqueada por origem.
- **Marcação dos sites muda:** afeta só aquele provider/site; mesmo fallback.
- **Cloudflare:** algumas páginas exigirão abrir o site uma vez para liberar.
- **Conteúdo de terceiros:** o painel mostra o que o site mostra, incluindo spoilers e linguagem
  ofensiva; spoiler borrado e "comentário removido" ajudam, moderação própria não entra.

## 11. Decisões em aberto

1. O botão Comentários entra na barra inferior padrão (só para quem nunca personalizou a barra) ou
   fica só no menu até você decidir?
2. Avatares carregam automaticamente ou só iniciais?
3. Novels entram na v1 ou na fase 3?
