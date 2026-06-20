export const APP_I18N_MESSAGES = {
  en: {
    common: {
      never: "Never",
      minute: "{count} minute",
      minutes: "{count} minutes",
      create: "Create",
      delete: "Delete",
      resetData: "Reset data",
      resetting: "Resetting...",
      confirmReset: "Confirm reset",
    },
    shell: {
      navigation: {
        primary: "Primary navigation",
        home: "Home",
        library: "Library",
        browse: "Browse",
        downloads: "Downloads",
        settings: "Settings",
        goHome: "Go to Home",
        logoAlt: "Aethon logo",
      },
      pageState: {
        status: "Page status",
        failedTitle: "Page failed to load",
        failedBody: "Aethon couldn't open this page.",
        retry: "Retry page",
        loading: "Loading",
        openingTitle: "Opening page",
        openingBody: "Aethon is loading this surface.",
      },
      detailState: {
        status: "Detail status",
        openingTitle: "Opening details",
        openingBody: "Aethon is loading this detail page.",
        failedTitle: "Details failed to load",
        failedBody: "Aethon couldn't open this detail page.",
        retry: "Retry details",
      },
    },
    settings: {
      general: {
        group: "App",
        title: "General",
        description: "App defaults, profiles, startup behavior, and language preferences.",
        startup: {
          title: "Startup",
          launchLibrary: "Launch into library",
          launchLibraryHint: "Open the last active library section on startup.",
          autoStartServer: "Auto-start local server",
          autoStartServerHint: "Only when using the embedded desktop server.",
          serverStandby: "Local server standby",
          serverStandbyHint: "Let Aethon stop Suwayomi after idle while Library can use its local snapshot.",
          standbyAfter: "Standby after idle",
          standbyAfterHint: "Minimum idle time before the embedded server may sleep.",
          idleTimeout: "Idle timeout",
          idleTimeoutHint: "Pause background operations after inactivity.",
          discord: "Discord Rich Presence",
          discordHint: "Show reading activity when supported.",
        },
        profiles: {
          title: "Profiles",
          active: "Active profile",
          activeHint: "Controls the local workspace, paths, and defaults used on the next launch.",
          resetTitle: "Reset this profile workspace data",
          deleteTitle: "Remove profile from Settings",
          deleteActiveTitle: "Close this session before deleting the active profile",
          resetDiskTitle: "Reset profile data on disk",
          create: "Create profile",
          createHint: "Create a separate local Aethon workspace with its own server port.",
          namePlaceholder: "Profile name",
        },
        appLanguage: {
          label: "App language",
          hint: "Changes native Aethon interface text. Source language remains separate.",
          system: "System default",
        },
        desktop: {
          title: "Desktop defaults",
          serverUrl: "Server URL",
          serverManagedHint: "Managed by the active profile for this session.",
          serverBaseHint: "Base URL of your Suwayomi instance.",
          sourceLanguage: "Preferred source language",
          sourceLanguageHint: "Used to preselect languages in Search and deduplicate sources.",
          currentSession: "Current session",
          nextLaunch: "Next launch default",
        },
      },
    },
  },
  "pt-BR": {
    common: {
      never: "Nunca",
      minute: "{count} minuto",
      minutes: "{count} minutos",
      create: "Criar",
      delete: "Excluir",
      resetData: "Redefinir dados",
      resetting: "Redefinindo...",
      confirmReset: "Confirmar redefinicao",
    },
    shell: {
      navigation: {
        primary: "Navegacao principal",
        home: "Inicio",
        library: "Biblioteca",
        browse: "Explorar",
        downloads: "Downloads",
        settings: "Configuracoes",
        goHome: "Ir para o inicio",
        logoAlt: "Logo do Aethon",
      },
      pageState: {
        status: "Status da pagina",
        failedTitle: "Falha ao carregar a pagina",
        failedBody: "O Aethon nao conseguiu abrir esta pagina.",
        retry: "Tentar novamente",
        loading: "Carregando",
        openingTitle: "Abrindo pagina",
        openingBody: "O Aethon esta carregando esta tela.",
      },
      detailState: {
        status: "Status dos detalhes",
        openingTitle: "Abrindo detalhes",
        openingBody: "O Aethon esta carregando os detalhes.",
        failedTitle: "Falha ao carregar os detalhes",
        failedBody: "O Aethon nao conseguiu abrir os detalhes.",
        retry: "Tentar novamente",
      },
    },
    settings: {
      general: {
        group: "Aplicativo",
        title: "Geral",
        description: "Padroes do aplicativo, perfis, inicializacao e preferencias de idioma.",
        startup: {
          title: "Inicializacao",
          launchLibrary: "Iniciar na biblioteca",
          launchLibraryHint: "Abre a ultima secao ativa da biblioteca ao iniciar.",
          autoStartServer: "Iniciar servidor local automaticamente",
          autoStartServerHint: "Somente ao usar o servidor integrado do desktop.",
          serverStandby: "Suspensao do servidor local",
          serverStandbyHint: "Permite que o Aethon pare o Suwayomi quando ocioso enquanto a Biblioteca usa o snapshot local.",
          standbyAfter: "Suspender apos inatividade",
          standbyAfterHint: "Tempo minimo de inatividade antes que o servidor integrado possa suspender.",
          idleTimeout: "Tempo limite de inatividade",
          idleTimeoutHint: "Pausa operacoes em segundo plano apos inatividade.",
          discord: "Presenca rica do Discord",
          discordHint: "Mostra a atividade de leitura quando houver suporte.",
        },
        profiles: {
          title: "Perfis",
          active: "Perfil ativo",
          activeHint: "Controla o espaco local, caminhos e padroes usados na proxima inicializacao.",
          resetTitle: "Redefinir os dados locais deste perfil",
          deleteTitle: "Remover perfil das Configuracoes",
          deleteActiveTitle: "Encerre esta sessao antes de excluir o perfil ativo",
          resetDiskTitle: "Redefinir dados do perfil no disco",
          create: "Criar perfil",
          createHint: "Cria um espaco local separado do Aethon com sua propria porta de servidor.",
          namePlaceholder: "Nome do perfil",
        },
        appLanguage: {
          label: "Idioma do app",
          hint: "Altera textos nativos da interface do Aethon. O idioma das sources continua separado.",
          system: "Padrao do sistema",
        },
        desktop: {
          title: "Padroes do desktop",
          serverUrl: "URL do servidor",
          serverManagedHint: "Gerenciada pelo perfil ativo nesta sessao.",
          serverBaseHint: "URL base da sua instancia do Suwayomi.",
          sourceLanguage: "Idioma preferido das sources",
          sourceLanguageHint: "Usado para preselecionar idiomas na busca e remover sources duplicadas.",
          currentSession: "Sessao atual",
          nextLaunch: "Padrao da proxima inicializacao",
        },
      },
    },
  },
  "pt-PT": {
    settings: {
      general: {
        appLanguage: {
          label: "Idioma da app",
          hint: "Altera os textos nativos da interface do Aethon. O idioma das sources continua separado.",
          system: "Predefinicao do sistema",
        },
      },
    },
  },
  es: {
    settings: {
      general: {
        appLanguage: {
          label: "Idioma de la app",
          hint: "Cambia los textos nativos de Aethon. El idioma de las sources sigue separado.",
          system: "Predeterminado del sistema",
        },
      },
    },
  },
  fr: {
    settings: {
      general: {
        appLanguage: {
          label: "Langue de l'app",
          hint: "Modifie les textes natifs d'Aethon. La langue des sources reste separee.",
          system: "Par defaut du systeme",
        },
      },
    },
  },
  de: {
    settings: {
      general: {
        appLanguage: {
          label: "App-Sprache",
          hint: "Andert native Aethon-Oberflachentexte. Die Source-Sprache bleibt getrennt.",
          system: "Systemstandard",
        },
      },
    },
  },
  it: {
    settings: {
      general: {
        appLanguage: {
          label: "Lingua app",
          hint: "Cambia i testi nativi di Aethon. La lingua delle source resta separata.",
          system: "Predefinita di sistema",
        },
      },
    },
  },
  ja: {
    settings: {
      general: {
        appLanguage: {
          label: "アプリの言語",
          hint: "Aethon のネイティブ UI テキストを変更します。ソース言語とは別です。",
          system: "システム標準",
        },
      },
    },
  },
  ko: {
    settings: {
      general: {
        appLanguage: {
          label: "앱 언어",
          hint: "Aethon 기본 인터페이스 텍스트를 변경합니다. 소스 언어와는 별개입니다.",
          system: "시스템 기본값",
        },
      },
    },
  },
  "zh-CN": {
    settings: {
      general: {
        appLanguage: {
          label: "应用语言",
          hint: "更改 Aethon 原生界面文本。来源语言保持独立。",
          system: "系统默认",
        },
      },
    },
  },
} satisfies Record<string, unknown>;
