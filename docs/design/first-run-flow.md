# Fluxo do primeiro uso do Epigraph

```mermaid
flowchart TD
    A[App recém-instalado] --> B[Escolher e aplicar tema]
    B --> C{Como deseja começar?}

    C -->|Sincronizar dispositivo| S1[Criar ou receber pareamento]
    S1 --> S2{Conexão aprovada?}
    S2 -->|Não| S3[Mostrar erro e tentar novamente]
    S3 --> S1
    S2 -->|Sim| S4{Biblioteca recebida?}
    S4 -->|Sim| Z[Resumo e abrir biblioteca]
    S4 -->|Não| D[Buscar obras e ver populares]

    C -->|Importar backups| K1[Selecionar um ou mais arquivos]
    K1 --> K2[Inspecionar Epigraph, Mihon, Tachiyomi e LNReader]
    K2 --> K3[Revisar obras, conflitos e dependências encontradas]
    K3 --> K4{Restauração concluída?}
    K4 -->|Não| K5[Mostrar erro sem descartar arquivos]
    K5 --> K4
    K4 -->|Sim| K6{Algum backup não trouxe repositório?}
    K6 -->|Mihon ou Tachiyomi| R1[Solicitar repositório de quadrinhos]
    K6 -->|Outro tipo ausente| R2[Solicitar somente o tipo ausente]
    K6 -->|Tudo disponível| K7{Biblioteca possui obras?}
    R1 --> R3[Carregar catálogo e instalar extensão]
    R2 --> R3
    R3 --> K7
    K7 -->|Sim| Z
    K7 -->|Não| D

    C -->|Começar do zero| F1[Adicionar URL de repositório]
    F1 --> F2[Carregar catálogo na mesma tela]
    F2 --> F3[Ver detalhes e instalar extensões]
    F3 --> D

    D --> D1[Pesquisar por nome ou escolher populares]
    D1 --> D2[Adicionar obras à biblioteca]
    D2 --> Z

    B -. Fazer depois .-> P[Salvar etapa e dados preenchidos]
    S1 -. Fazer depois .-> P
    K1 -. Fazer depois .-> P
    R3 -. Fazer depois .-> P
    D -. Fazer depois .-> P
    P --> Q[Retomar exatamente da tarefa pendente]
    Q --> T{Qual tarefa estava pendente?}
    T --> S1
    T --> K1
    T --> R3
    T --> D
```

## Regra de dependências de backup

- Mihon/Tachiyomi: restauram biblioteca, categorias e progresso, mas exigem que o usuário informe novamente o repositório de quadrinhos.
- Epigraph ou outros formatos: o planner reutiliza somente dependências efetivamente presentes e válidas.
- Importação mista: preserva as dependências encontradas e pede apenas as ausentes.
- A configuração de repositórios acontece dentro do first run, sem enviar o usuário para Configurações.
