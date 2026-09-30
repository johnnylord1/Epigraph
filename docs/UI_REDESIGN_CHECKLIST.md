# UI redesign — inventário e checklist

Memória entre compactações: releia este arquivo e `docs/UI_REDESIGN_PLAN.md` antes de continuar.
Status: `pendente` · `feito` · `feito*` (coberto por componente/tema compartilhado, verificado por amostra) · `limitação`.
Tecnologia: V = View/XML (Conductor ou Activity), C = Compose (em `BaseComposeController`/`ComposeView`), V+C = misto.
Tipo: tela · sub · sheet · dialog · menu · popup · hud · momento · global.

**Resumo (30/09/2026):** 169 superfícies — 59 `feito`, 106 `feito*`, 4 `limitação`, 0 `pendente`.

## F0 — Global e componentes compartilhados
| Superfície | Arquivo | Tec | De onde | Tipo | Status |
|---|---|---|---|---|---|
| Tokens de motion (durações, curvas, springs) | `yokai/presentation/theme/Motion.kt`, `res/values/epigraph_design.xml`, `res/interpolator/` | V+C | — | global | feito |
| Tema Compose (`MaterialExpressiveTheme`, MotionScheme) | `yokai/presentation/theme/Theme.kt` | C | — | global | feito |
| Barra inferior / rail | `res/layout/main_activity.xml`, `styles.xml` `Widget.Tachiyomi.BottomNavigationView` | V | raiz | global | feito |
| Troca de abas raiz (fade through) | `ui/main/RootTabsController.kt` `animateSwap` | V | nav inferior | global | feito (frame `f4-recents-fade-through-mid`) |
| Push/pop padrão (shared axis X + predictive back) | `util/view/ControllerExtensions.kt` `fadeTransactionHandler`, `ui/base/controller/*ChangeHandler.kt` | V | qualquer push | global | feito |
| Predictive back (progresso do gesto) | `ControllerExtensions.kt` `BackHandlerControllerInterface`, `MainActivity` | V | gesto voltar | global | feito — progresso do gesto não verificado no emulador |
| Top bar grande/colapsável + busca | `ui/base/ExpandedAppBarLayout.kt`, `epigraph_app_bar_contents.xml` | V | todas as telas V | global | feito |
| Top bar Compose | `yokai/presentation/component/AppBar.kt` | C | telas C | global | feito* |
| Barra flutuante de seleção (action mode) | `ui/base/FloatingToolbar.kt` | V | seleção em listas | global | feito |
| Diálogo XML (base de ~69 diálogos) | `styles.xml` `Theme.Widget.Epigraph.AlertDialog`, `util/system/MaterialAlertDialogExtensions.kt` | V | vários | dialog | feito (frame `f7-localbooks-import-dialog`) |
| Diálogo Compose (base) | `yokai/presentation/component/*`, M3 `AlertDialog` | C | vários | dialog | feito* |
| Bottom sheet XML (base) | `widget/E2EBottomSheetDialog.kt`, `widget/TabbedBottomSheet.kt`, `BottomSheetDialogTheme` | V | vários | sheet | feito* |
| Menu em sheet | `ui/base/MaterialMenuSheet.kt` | V | vários | menu | feito* |
| Popup menu | `util/view/ViewExtensions.kt` `popupMenu` | V | vários | popup | feito |
| Menu ⋮ principal | `ui/more/OverflowDialog.kt`, `tachi_overflow_layout.xml` | V | top bar raiz | menu | feito |
| Snackbar | tema Material | V | vários | global | feito* |
| Estado vazio | `yokai/presentation/component/EmptyScreen.kt`, `widget/EmptyView` | V+C | listas vazias | global | feito (frame `f7-localbooks-empty`) |
| Carregando / skeleton→conteúdo | `CircularProgressIndicator.kt`, layouts | V+C | listas | global | feito |
| Erro / banners | `yokai/presentation/component/Banners.kt` | C | vários | global | feito* |
| Linha de preferência XML | `SettingsLegacyController`, `Tachiyomi.PreferenceTheme`, `widget/preference/*` | V | Configurações | global | feito* |
| Linha de preferência Compose | `yokai/presentation/component/preference/**` | C | Configurações | global | feito* |
| Switch / slider / checkbox / radio | `styles.xml`, `SwitchPreferenceWidget.kt`, `SliderPreferenceWidget.kt` | V+C | vários | global | feito* |
| Chips | `styles.xml` `Widget.Tachiyomi.Chip.*` | V | detalhes, filtros | global | feito* |
| Botões (primário, outline, texto, LoadingButton) | `styles.xml`, `LoadingButton.kt` | V+C | vários | global | feito |
| Abas segmentadas | `styles.xml` `Theme.Widget.Tabs.Highlight` | V | Recentes, Browse | global | feito* |
| Fast scroll | `ui/library/LibraryFastScroll` | V | Biblioteca | global | feito* |
| Splash | `Theme.Tachiyomi.SplashScreen` | V | abertura | global | feito* |
| Háptica | `util/system/*` | V+C | interações | global | feito |

## F1 — Biblioteca
| Superfície | Arquivo | Tec | De onde | Tipo | Status |
|---|---|---|---|---|---|
| Biblioteca (grade/lista, categorias) | `ui/library/LibraryController.kt`, `library_controller.xml` | V | aba Biblioteca | tela | feito |
| Capa na grade (item) | `LibraryGridHolder.kt`, `manga_grid_item.xml` | V | Biblioteca | tela | feito |
| Item em lista | `LibraryListHolder.kt` | V | Biblioteca | tela | feito |
| Cabeçalho de categoria | `LibraryHeaderHolder.kt`, `library_category_header_item.xml` | V | Biblioteca | tela | feito |
| Seletor rápido de categoria | `rounded_category_hopper.xml` | V | Biblioteca | popup | feito |
| Biblioteca Compose (experimental) | `ui/library/compose/LibraryComposeController.kt` | C | pref `composeLibrary` | tela | feito* |
| Biblioteca filtrada | `ui/library/FilteredLibraryController.kt` | V | stats/links | sub | feito* |
| Sheet de filtros (inferior) | `ui/library/filter/FilterBottomSheet.kt` | V | Biblioteca | sheet | feito |
| Filtros expandidos | `ui/library/filter/ExpandedFilterSheet.kt` | V | sheet de filtros | sheet | feito* |
| Reordenar filtros | `ExpandedFilterSheet.kt:181` | V | filtros expandidos | dialog | feito* |
| Exibição (abas) | `ui/library/display/TabbedLibraryDisplaySheet.kt` | V | filtros | sheet | feito* |
| Menu da categoria (cabeçalho) | `LibraryHeaderHolder.kt:346` | V | cabeçalho | menu | feito* |
| Menu de ordenação/grupo | `LibraryController.kt:1148` | V | Biblioteca | menu | feito* |
| Menu de agrupamento | `LibraryController.kt:1434` | V | Biblioteca | menu | feito* |
| Remover da biblioteca | `LibraryController.kt:3428` | V | seleção | dialog | feito* |
| Diálogos de seleção (2) | `LibraryController.kt:3457,3466` | V | seleção | dialog | feito* |
| Mudar categorias (sheet) | `LibraryController.kt:3581` | V | seleção | sheet | feito* |
| Categorias | `ui/category/CategoryController.kt` | V | menu da Biblioteca | sub | feito* |
| Criar/editar categoria | `ui/category/ManageCategoryDialog.kt` | V | Categorias | dialog | feito* |
| Excluir categoria | `CategoryController.kt:136` | V | Categorias | dialog | feito* |
| Livros locais (EPUB/PDF) | `epigraph/books/ui/LocalBooksController.kt` | V | Biblioteca | tela | feito (frames `f7-localbooks-*`) |
| Detalhes de livro local | `epigraph/books/ui/LocalBookDetailsController.kt` | V | Livros locais | tela | feito (frames `f2-book-details-nocturne-accent`, `f2-book-details-chapters-aligned`) |
| Menu de livro local | `res/menu/book_details.xml` | V | detalhes do livro | menu | feito* |

## F2 — Detalhes da obra
| Superfície | Arquivo | Tec | De onde | Tipo | Status |
|---|---|---|---|---|---|
| Capa → detalhes (container transform) | `ui/base/controller/CoverExpandChangeHandler.kt` | V | capa na grade | global | feito (frame `f2-container-transform-mid`) |
| Detalhes (cabeçalho + capítulos) | `ui/manga/MangaDetailsController.kt`, `MangaHeaderHolder.kt` | V | Biblioteca/Recentes/Browse | tela | feito |
| Cabeçalho reativo ao scroll (parallax, título sobe) | `MangaDetailsController.kt`, `manga_header_item.xml` | V | detalhes | tela | limitação — implementado; não verificado (obra de teste com 4 capítulos não rola) |
| Paleta derivada da capa | `MangaDetailsController.kt` (`themeMangaDetails`) | V | detalhes | tela | feito — desligada (padrão) verificada; ligada não verificada |
| Linha de capítulo | `ui/manga/chapter/ChapterHolder.kt`, `chapters_item.xml` | V | detalhes | tela | feito |
| Botão de download | `ui/download/DownloadButton.kt` | V | capítulo | tela | feito |
| Metadados (Compose) | `ui/manga/MangaDetailCompose.kt` | C | detalhes | tela | feito |
| Capa em tela cheia | `ui/manga/FullCoverDialog.kt` | V | tocar capa | dialog | feito* |
| Editar obra | `ui/manga/EditMangaDialog.kt` | V | menu | dialog | feito* |
| Ordenar/filtrar capítulos | `ui/manga/chapter/ChaptersSortBottomSheet.kt` | V | detalhes | sheet | feito* |
| Grupos de scanlator | `ChaptersSortBottomSheet.kt:174` | V | sheet de ordenação | dialog | feito* |
| Rastreamento | `ui/manga/track/TrackingBottomSheet.kt` | V | detalhes | sheet | feito* |
| Rastreamento: status/capítulos/nota/remover/datas (5) | `TrackingBottomSheet.kt:456-582` | V | rastreamento | dialog | feito* |
| Categorias da obra | `MangaDetailsController.kt:2081` | V | detalhes | sheet | feito* |
| Diálogos de detalhes (5) | `MangaDetailsController.kt:983,1494,1504,1687,1736` | V | detalhes | dialog | feito* |
| Menu de capítulo | `ui/manga/chapter/BaseChapterHolder.kt` | V | capítulo | popup | feito* |
| Menu de detalhes / tag / título | `res/menu/manga_details*.xml` | V | top bar | menu | feito* |
| Remover/migrar (extensões) | `util/MangaExtensions.kt:408,428` | V | detalhes | dialog | feito* |
| Citações | `epigraph/novel/reader/quote/QuotesSheet.kt` | C | detalhes/leitor | sheet | feito* |
| Tradução avançada | `ui/manga/translation/AdvancedTranslationSheet.kt` | C | detalhes | sheet | feito* |
| Metadados EH | `exh/ui/metadata/MetadataViewController.kt` | C | detalhes | sub | feito* |
| Prévia de páginas | `exh/ui/pagepreview/PagePreviewViewController.kt` | C | detalhes | sub | feito* |
| Recomendações | `exh/recs/RecommendsViewController.kt`, `BrowseRecommendsScreen.kt` | C | detalhes | sub | feito* |
| Busca de recomendações em lote | `exh/recs/batch/*` | C | recomendações | sheet | feito |

## F3 — Leitor
| Superfície | Arquivo | Tec | De onde | Tipo | Status |
|---|---|---|---|---|---|
| Leitor de mangá (HUD topo/base) | `ui/reader/ReaderActivity.kt`, `reader_activity.xml` | V | capítulo | tela | feito (mola; barra r-m, indicador r-xs; frame `f3-reader-hud-rm`) |
| Transição de página/capítulo | `ui/reader/viewer/**` | V | leitor | tela | feito — slide/profundidade/fade × 3 velocidades; frame intermediário não capturado |
| Lista de capítulos no leitor | `ui/reader/chapter/ReaderChapterSheet.kt` | V | HUD | sheet | feito* |
| Configurações do leitor (mangá) | `ui/reader/settings/TabbedReaderSettingsSheet.kt` | V | HUD | sheet | feito |
| Configurações do leitor (novel) | `TabbedNovelReaderSettingsSheet.kt`, `NovelAppearanceView.kt`, `NovelTranslationView.kt` | V | HUD | sheet | feito* |
| Diálogos de novel (aparência 1, tradução 3) | `NovelAppearanceView.kt:163`, `NovelTranslationView.kt:177-266` | V | configurações novel | dialog | feito* |
| Leitor de novel (WebView) | `ui/reader/viewer/text/NovelWebViewViewer.kt` | V | capítulo novel | tela | feito* |
| Controles TTS | `epigraph/novel/reader/bars/NovelReaderActionBar.kt`, `NovelTtsController.kt` | C | HUD novel | hud | feito* |
| Localizar/substituir | `epigraph/novel/reader/settings/NovelFindReplaceSheet.kt` | C | HUD novel | sheet | feito* |
| Presets / regex (diálogos) | `NovelStylePresetSection.kt`, `RegexReplacementSection.kt` | C | configurações novel | dialog | feito* |
| Ação sobre seleção (web) | `epigraph/reader/selection/SelectionWebSheet.kt` | V | seleção de texto | sheet | feito* |
| Modo de leitura (popup) | `ReaderActivity.kt:1410` | V | HUD | popup | feito* |
| Menu do leitor (sheet) | `ReaderActivity.kt:2881` | V | HUD | menu | feito* |
| Diálogos do leitor (reset, busca, outro) | `ReaderActivity.kt:1234,2946,3222` | V | HUD | dialog | feito* |
| Leitor de livros (EPUB/PDF) | `epigraph/books/ui/LocalBookReaderActivity.kt` | V | livro local | tela | limitação — tema aplicado; ~53 textos fixos em inglês em `LocalBookReaderActivity` |
| Configurações do leitor de livros | `epigraph/books/ui/LocalBookReaderSettingsSheet.kt` | V | HUD livros | sheet | limitação — 2 textos fixos em inglês |
| Menu do leitor de livros | `LocalBookReaderActivity.kt:1367` | V | HUD livros | menu | feito* |
| Diálogos do leitor de livros (7) | `LocalBookReaderActivity.kt:1627-2718` | V | HUD livros | dialog | feito* |
| Momento: obra concluída | a definir no leitor | V | último capítulo lido | momento | feito — não disparado no emulador |
| Momento: marco de leitura | a definir no leitor | V | marco atingido | momento | feito — não disparado no emulador |

## F4 — Recentes
| Superfície | Arquivo | Tec | De onde | Tipo | Status |
|---|---|---|---|---|---|
| Recentes (agrupado/histórico/atualizações) | `ui/recents/RecentsController.kt` | V | aba Recentes | tela | feito (frame `f4-recents-grouped`) |
| Linha recente | `RecentMangaHolder.kt`, `recent_manga_item.xml` | V | Recentes | tela | feito |
| Cabeçalhos e divisores | `recents_header_item.xml`, `RecentMangaDivider.kt`, `RecentMangaHeaderItem.kt` | V | Recentes | tela | feito |
| Popup do cabeçalho | `RecentMangaHeaderItem.kt` | V | Recentes | popup | feito* |
| Cartão Para você | `ui/source/DiscoverEntryItem.kt`, `browse_discover_item.xml` | V | Recentes | tela | feito |
| Para você (Discover) | `epigraph/recommendations/ui/DiscoverScreen.kt` | C | cartão Para você | sub | feito |
| Fila de downloads | `ui/download/DownloadBottomSheet.kt`, `download_item.xml` | V | Recentes (sheet) | sheet | feito |
| Opções de Recentes | `ui/recents/options/TabbedRecentsOptionsSheet.kt` | V | Recentes | sheet | feito* |
| Diálogos de Recentes (2) | `RecentsController.kt:958,1474` | V | Recentes | dialog | feito* |
| Fontes ocultas (histórico 3, atualizações 2) | `RecentsHistoryView.kt`, `RecentsUpdatesView.kt` | V | opções | dialog | feito (frame `f5-browse`) |
| Próximos lançamentos | `ui/upcoming/UpcomingController.kt` | C | Recentes | sub | feito* |
| Relatório de atualização | `LibraryUpdateReportController.kt`, `LibraryUpdateReportScreen.kt` | C | notificação/Recentes | sub | feito |
| Estatísticas | `ui/more/stats/StatsController.kt` | V | menu ⋮ | sub | feito* |
| Estatísticas detalhadas + diálogos (3) | `ui/more/stats/details/StatsDetailsController.kt` | V | Estatísticas | sub | feito* |
| Estatísticas de novel | `NovelStatsController.kt`, `NovelStatsScreen.kt` | C | Estatísticas | sub | feito |

## F5 — Explorar (Browse)
| Superfície | Arquivo | Tec | De onde | Tipo | Status |
|---|---|---|---|---|---|
| Fontes | `ui/source/BrowseController.kt`, `source_item.xml`, `source_header_item.xml` | V | aba Browse | tela | feito (frame `f5-browse`) |
| Extensões / migração (sheet) | `ui/extension/ExtensionBottomSheet.kt` | V | Browse | sheet | feito |
| Diálogos de extensões (4) | `ExtensionBottomSheet.kt:324,431,555,566` | V | extensões | dialog | feito* |
| Popups de extensão (2) | `ExtensionBottomSheet.kt:338,707` | V | extensões | popup | feito* |
| Detalhes da extensão | `yokai/presentation/extension/ExtensionDetailsController.kt`, `ui/extension/details/*` | V+C | extensões | sub | feito* |
| Filtro de extensões (idiomas) | `ui/extension/ExtensionFilterController.kt` | V | extensões | sub | feito* |
| Repositórios de extensão | `yokai/presentation/extension/repo/ExtensionRepoScreen.kt` | C | Config. Browse | sub | feito |
| Navegar fonte (grade/lista) | `ui/source/browse/BrowseSourceController.kt` | V+C | Fontes | sub | feito* |
| Filtros da fonte | `ui/source/browse/compose/ComposeSourceFilterSheet.kt` | C | navegar fonte | sheet | feito |
| Salvar/excluir busca | `BrowseSourceController.kt:493,519` | V | filtros | dialog | feito* |
| Busca global | `ui/source/globalsearch/GlobalSearchController.kt` | V | Browse/detalhes | sub | feito* |
| Migração (fontes) | `ui/migration/MigrationController.kt` | V | Browse | sub | feito* |
| Pré-migração + sheet | `PreMigrationController.kt`, `MigrationBottomSheetDialog.kt` | V | migração | sub | feito* |
| Lista de migração + diálogos (3) | `MigrationListController.kt` | V | pré-migração | sub | feito |
| Busca de migração | `ui/migration/SearchController.kt` | V | migração | sub | feito* |
| Smart search / batch add / follows MangaDex | `exh/ui/smartsearch`, `exh/ui/batchadd`, `exh/md/follows` | C | Browse | sub | feito |
| Intercept (links) | `exh/ui/intercept/InterceptActivity.kt` + diálogos (2) | V | link externo | tela | feito* |

## F6 — Configurações
| Superfície | Arquivo | Tec | De onde | Tipo | Status |
|---|---|---|---|---|---|
| Configurações (principal) | `ui/setting/controllers/SettingsMainController.kt` | V | menu ⋮ | tela | feito* |
| Busca nas configurações | `controllers/search/SettingsSearchController.kt` | V | Configurações | sub | feito* |
| Geral | `SettingsGeneralController.kt` | V | Configurações | sub | feito* |
| Aparência + ícone do app | `SettingsAppearanceController.kt` (+ diálogo :79) | V | Configurações | sub | feito* |
| Biblioteca | `SettingsLibraryController.kt` | V | Configurações | sub | feito* |
| Leitores (hub) | `SettingsReaderHubController.kt` | V | Configurações | sub | feito* |
| Leitor de mangá | `SettingsMangaReaderController.kt` | V | Leitores | sub | feito (frame `f3-reader-pageturn-style-dialog`) |
| Leitor de novel / Tradução | `SettingsNovelReaderController.kt` | V | Leitores | sub | feito* |
| Leitor de livros | `SettingsBooksReaderController.kt` | V | Leitores | sub | feito* |
| Downloads | `SettingsDownloadController.kt` | V | Configurações | sub | feito* |
| Rastreamento + login/logout | `SettingsTrackingController.kt`, `widget/preference/Track*Dialog.kt` | V | Configurações | sub | feito* |
| Logins OAuth/WebView (5) | `ui/setting/track/*LoginActivity.kt` | V | Rastreamento | tela | feito* |
| Browse | `SettingsBrowseController.kt` | V | Configurações | sub | feito* |
| Fontes | `SettingsSourcesController.kt` | V | Configurações | sub | feito* |
| Recentes + diálogos (3) | `SettingsRecentsController.kt` | V | Configurações | sub | feito* |
| Dados e armazenamento (backup) | `SettingsDataController.kt`, `SettingsDataScreen.kt` | C | Configurações | sub | feito |
| Backup legado + diálogos (3) | `legacy/SettingsDataLegacyController.kt` | V | Dados | sub | feito* |
| Economia de dados | `SettingsDataSaverController.kt` | C | Configurações | sub | feito* |
| Segurança | `SettingsSecurityController.kt` | V | Configurações | sub | feito* |
| Avançado | `SettingsAdvancedController.kt`, `SettingsAdvancedScreen.kt` | C | Configurações | sub | feito* |
| Avançado legado + diálogos (6) | `legacy/SettingsAdvancedLegacyController.kt` | V | Avançado | sub | feito* |
| Epigraph Core (sync) | `SettingsepigraphCoreController.kt`, `SettingsepigraphCoreScreen.kt` | C | Configurações | sub | feito* |
| Pareamento com o Core | `epigraph/sync/core/pairing/epigraphCorePairingController.kt` | V | Epigraph Core | sub | feito* |
| E-Hentai / MangaDex | `SettingsEhController.kt`, `exh/ui/settings/*` | C | Configurações | sub | feito* |
| Limpar banco + diálogo | `database/ClearDatabaseController.kt` | V | Avançado | sub | feito* |
| Debug / workers / schema de backup | `debug/*` | V | Avançado | sub | feito* |
| Storybook | `settings/screen/advanced/StoryBookScreen.kt` | C | Debug | sub | feito* |
| Sobre + licenças + atualização | `AboutController.kt`, `settings/screen/about/*` | C | Configurações | sub | feito |
| Diálogos de preferência Compose (lista, multi, texto, tri-estado) | `component/preference/widget/*` | C | Config. C | dialog | feito* |
| Diálogo de preferência XML | `widget/preference/MatPreference.kt` | V | Config. V | dialog | feito* |

## F7 — Outras superfícies
| Superfície | Arquivo | Tec | De onde | Tipo | Status |
|---|---|---|---|---|---|
| Onboarding | `yokai/presentation/onboarding/*` | C | primeira execução | tela | feito (frames `f7-onboarding-*`; sem caixa dupla, um botão cheio por passo; ao concluir, a biblioteca volta só com a própria app bar) |
| Novidades (what's new) | `MainActivity.kt:2130` | V | após atualização | sheet | feito* |
| Aviso inicial | `MainActivity.kt:273` | V | abertura | dialog | feito* |
| Crash | `ui/crash/CrashActivity.kt` | V | falha | tela | feito* |
| Biometria | `ui/security/BiometricActivity.kt` | V | bloqueio | tela | feito* |
| WebView | `ui/webview/WebViewActivity.kt`, `WebViewScreenContent.kt` | C | vários | tela | feito* |
| Reconciliação de extensões (sync) | `epigraph/sync/core/extensions/ExtensionReconciliationActivity.kt` | C | sync | tela | feito |
| Dependência LNReader | `epigraph/sync/core/novels/LnReaderDependencyActivity.kt` | V | sync | tela | feito |
| Instalação de extensão | `extension/util/ExtensionInstallBroadcast.kt` | V | instalar | tela | limitação (Package Installer do sistema, obrigatório pelo AGENTS) |
| Logins EH / MangaDex | `exh/ui/login/*`, `exh/md/MangaDexLoginActivity.kt` | V+C | Config. | tela | feito |
| Momento: importação concluída | `SettingsDataScreen.kt` / restore | C | restaurar backup | momento | feito — restauração não disparada; importação de livro verificada (`f8-moment-import-*`) |
| Momento: backup concluído | `SettingsDataScreen.kt` / create | C | criar backup | momento | feito — não disparado no emulador |

## Referências (padrão a extrair)
Vencedores verificados na web em 30/09/2026 (developer.apple.com/design/awards/2025, 9to5google/androidauthority, Play Best of 2025).
Os padrões de cada app vêm de conhecimento prévio. **Não foram verificados ao vivo**, porque não há os apps instalados no emulador.
1. **Apple Books.** A capa abre o livro por container transform, e a cor da capa tinge o fundo da página de detalhes.
2. **Readwise Reader.** A hierarquia é só tipográfica. O HUD do leitor some com fade curto e volta com mola discreta.
3. **Things 3.** Os itens expandem no próprio lugar, e a lista reordena com mola, sem pular.
4. **CapWords (ADA 2025, Delight).** O momento de conquista é curto: antecipação, pop, assentamento. Um único elemento se move por vez.
5. **Balatro (ADA 2025, Delight).** Contadores rolam com overshoot sutil, e o squash faz o número pesar.
6. **Taobao (ADA 2025, Interaction).** Sheets físicas com velocidade herdada do dedo e snap em alturas definidas.
7. **Focus Friend (Play Best of 2025).** A recompensa fica fora do fluxo principal. As telas de uso frequente são sóbrias.
8. **Goodnotes (Play, telas grandes).** Adaptação real a tablets: rail, colunas, largura máxima de texto.
9. **Material 3 Expressive (Google).** `MotionScheme.expressive()`, molas nomeadas, morph de formas (`RoundedPolygon`) e predictive back.
10. **Pocket Casts / Mihon.** Densidade de lista para bibliotecas grandes, cabeçalho de detalhes que colapsa e título que sobe para a barra.
