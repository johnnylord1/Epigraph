# Guia do Usuário — Aethon Desktop

## Visão geral

Aethon Desktop organiza comics, novels e livros locais em uma interface para Windows. As áreas principais são Home, Library, Browse, Downloads e Settings. O aplicativo pode usar um servidor Suwayomi local, sources e integrações externas; não é necessário cadastro no Aethon para abrir um perfil local.

Este guia descreve os principais fluxos do Aethon Desktop e as configurações necessárias para recursos locais e integrações externas.

## Requisitos

- Windows com WebView2 disponível.
- Um perfil local do Aethon.
- Suwayomi e sources configurados para pesquisar, atualizar ou abrir conteúdo remoto.
- Credenciais próprias para trackers, Hardcover ou outras integrações que as solicitarem.
- Acesso à rede para releases, updater e catálogos externos.

Não coloque tokens, senhas ou chaves em screenshots ou relatórios de suporte.

## Primeiros passos

1. Abra o Aethon Desktop pelo atalho ou instalador disponibilizado para Windows.
2. Aguarde a inicialização do perfil local.
3. Se o servidor local não puder iniciar, use **Try again** depois de verificar o serviço. A tela também pode oferecer entrada no shell sem o servidor; Browse e atualização de conteúdo continuarão limitados.
4. Use a barra lateral para alternar entre **Home**, **Library**, **Browse**, **Downloads** e **Settings**.

Quando o servidor local estiver indisponível, o shell continua acessível para consultar dados já armazenados; Browse e atualizações voltam a funcionar após a recuperação do serviço.

## Home e Activity Center

### Onde encontrar

Clique em **Home** na barra lateral. O sino no topo abre **Recent activity**.

### Como utilizar

1. Abra **Home** para ver itens de continuidade, atualizações recentes, estatísticas e atalhos.
2. Use **View library** para ir à biblioteca.
3. Abra o sino para consultar histórico, notificações de atualização e eventos do sistema.
4. Use a ação de retorno do painel para voltar à tela anterior.

### Resultado esperado

O dashboard mostra estados vazios quando não há dados e mantém a navegação consistente. Activity Center agrega itens recentes e marca a atividade visualizada.

### Limitações conhecidas

Capas, atualizações e estatísticas dependem do conteúdo existente no perfil e, para itens remotos, do servidor/source.

## Library

### Onde encontrar

Clique em **Library**. A tela separa comics de books/novels locais.

### Como utilizar

1. Selecione a seção **Comics** ou **Books**.
2. Digite no campo de pesquisa para reduzir os itens visíveis.
3. Abra filtros/ordenação para escolher categorias, gêneros, estado e ordem.
4. Ative o modo de seleção para aplicar ações em massa aos itens escolhidos.
5. Abra um card para acessar os detalhes quando o item estiver disponível.

### Resultado esperado

Pesquisa, filtros, ordenação, categorias e seleção atualizam a lista sem abandonar a seção ativa.

### Limitações conhecidas

- Atualização por source exige servidor e source disponíveis.
- Importação EPUB/PDF exige acesso ao arquivo local e permissão de leitura.

## Downloads

### Onde encontrar

Clique em **Downloads** na barra lateral ou no atalho do topo.

### Como utilizar

1. Consulte a fila e use a pesquisa para localizar um item.
2. Em um download existente, use as ações disponíveis para pausar, retomar, cancelar ou repetir.
3. Verifique a mensagem de estado para distinguir queued, downloading, paused, completed e failed.

### Resultado esperado

A fila preserva o item e atualiza o estado conforme a ação. Busca e estados vazios foram cobertos por testes.

### Limitações conhecidas

Downloads remotos dependem da disponibilidade da source e do servidor.

## Configurações gerais

### Onde encontrar

Abra **Settings > App > General**.

![Settings General em perfil de teste](images/user-guide/settings-01-general.png)

### Como utilizar

1. Revise o perfil ativo e as opções de inicialização.
2. Escolha o idioma em **App language**.
3. Ajuste auto-start/standby do servidor somente se usar o servidor local incorporado.
4. Em Discord Rich Presence, mantenha **Private mode** quando não quiser publicar título/capa.

### Resultado esperado

Os controles refletem a preferência selecionada e o perfil ativo.

### Limitações conhecidas

Discord Rich Presence requer o aplicativo Discord em execução e uma configuração compatível.

## Preferências do leitor

### Onde encontrar

Abra **Settings > Reader & Library > Reader**.

![Preferências do Reader](images/user-guide/settings-02-reader.png)

### Como utilizar

1. Selecione **Single**, **Double** ou **Longstrip** em **Page style**.
2. Escolha **LTR** ou **RTL** conforme a direção da obra.
3. Defina page gap, overlay bars, auto next chapter, mark read e auto-bookmark.
4. Ajuste fit mode e zoom padrão.

### Resultado esperado

As opções alimentam os padrões compartilhados pelos readers. HUD, zoom, navegação, progresso, bookmarks e TTS usam essas preferências.

### Limitações conhecidas

Fullscreen, TTS e atalhos dependem das permissões e capacidades disponíveis no Windows/WebView2.

## Regras de conteúdo

### Onde encontrar

Abra **Settings > Content & Integrations > Content**.

![Regras de Content](images/user-guide/settings-03-content.png)

### Como utilizar

1. Defina se conteúdo adulto pode aparecer.
2. Ative o filtro por tags bloqueadas.
3. Adicione uma substring em **Blocked tags** e confirme com **Add**.
4. Use **Allowed sources** e **Blocked sources** para revisar as regras de catálogo.

### Resultado esperado

As regras atualizam o estado de Content e são aplicadas como filtro às superfícies compatíveis.

### Limitações conhecidas

Filtros dependentes de catálogo são aplicados somente às sources configuradas e compatíveis.

## About e atualizações

### Onde encontrar

Abra **Settings > Advanced > About**.

![Tela About](images/user-guide/settings-04-about.png)

### Como utilizar

1. Confira **Current build**.
2. Use **Browse** em release history para consultar versões quando houver rede.
3. Use **Check updates** somente em uma build assinada/configurada.
4. Abra **Details** do runtime Suwayomi para diagnosticar um status failed/checking.

### Resultado esperado

About apresenta build, releases, GitHub e status do Suwayomi. Histórico e atualização são carregados quando os serviços de release estão acessíveis.

### Problemas conhecidos

O updater e o histórico dependem de rede, endpoint de releases e assinatura válida do pacote.

## Syncd Desktop

Syncd conecta duas instâncias do Aethon Desktop para replicar biblioteca, progresso, bookmarks, categorias e demais dados compatíveis. A conexão pode ser criada por QR, descoberta na rede local ou endereço manual.

### Criar uma conexão

1. No desktop que hospedará a sessão, abra **Settings > Security > Syncd**.
2. Selecione **Pairing** e clique em **Create pairing QR**.
3. O Aethon prepara automaticamente a conexão e exibe o QR.
4. No segundo desktop, abra o mesmo painel e escolha o host descoberto ou importe o QR.
5. Confirme a solicitação no desktop host.
6. Aguarde os dois painéis exibirem a sessão como **Connected** e a replicação como **Live**.

Se a descoberta automática não localizar o host, informe manualmente o endereço mostrado no painel do desktop host.

### Gerenciar sessões e replicação

1. Abra **Details** para consultar os desktops pareados e o estado de cada sessão.
2. Use **Set active** para escolher a sessão responsável pela replicação atual.
3. Use **Pause replication** quando quiser manter a sessão sem enviar ou receber mudanças.
4. Use **Resume** para continuar ou **Reconnect now** para restabelecer uma conexão interrompida.
5. Use **Forget** somente quando quiser remover permanentemente uma sessão daquele desktop.

### Múltiplas instâncias

O Aethon gerencia automaticamente os recursos necessários para cada instância. Não é preciso escolher portas, editar arquivos internos ou encerrar processos manualmente. Se outra instância estiver aberta no mesmo computador, cada uma permanece isolada e pode ser fechada sem interromper as demais.

## Funcionalidades que exigem configuração

- Browse/Discover/Search reais: dependem de Suwayomi, sources ou plugins.
- Tracking e Hardcover: dependem de credenciais/configuração ausente.
- Discord Rich Presence: depende do Discord e configuração local.
- FlareSolverr: depende de serviço local ou Docker configurado.
- Updater: depende de release, rede e assinatura.
- Importação EPUB/PDF, backup e restore: exigem permissões de arquivo e um destino de armazenamento acessível.
- Migração individual/em massa: depende de sources de origem e destino.

## Solução de problemas

### O perfil não inicia

1. Verifique se o servidor local esperado está ativo.
2. Use **Try again** uma vez após a verificação.
3. Entre no shell sem servidor apenas para consultar dados locais; Browse e atualizações podem ficar indisponíveis.
4. Consulte **Settings > Advanced > About > Suwayomi > Details** quando a tela estiver acessível.

### Uma source não retorna resultados

Confirme que o repositório/extensão está instalado e habilitado, que o idioma/filtro de conteúdo permite a source e que o servidor está acessível. Não reutilize credenciais em campos que não as solicitam.

### Storage permanece em “Refreshing…”

Aguarde a leitura dos caminhos e do uso de disco. Se o estado persistir, reabra Settings e consulte os logs em **Settings > Advanced > Dev Tools**, sem compartilhar caminhos privados ou credenciais.

## Perguntas frequentes

### Preciso de conta Aethon?

Não para um perfil local. Integrações externas podem exigir conta/token próprios.

### Posso ler sem internet?

Sim. Conteúdo local ou previamente baixado permanece disponível; catálogos, atualização e novos downloads exigem rede.

### Posso conectar o Syncd a um celular?

Este guia cobre Syncd entre instâncias do Aethon Desktop. Use outro Aethon Desktop como host ou participante da sessão.

## Glossário

- **Source:** provedor de catálogo/conteúdo.
- **Suwayomi:** serviço local usado por fluxos de manga do desktop.
- **Syncd:** sincronização entre instâncias Aethon Desktop.
- **Profile:** workspace local com preferências e dados próprios.
- **Tombstone:** registro de exclusão usado para convergir sincronização.
- **Replay:** reaplicação de eventos Syncd após reconexão.
