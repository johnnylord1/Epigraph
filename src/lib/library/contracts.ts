import type { LibraryPreferredGridColumns, LibraryViewMode } from "../libraryDisplay";

export type LibrarySectionKind = "comics" | "books";
export type BooksTypeFilterId = "all" | "epub" | "pdf" | "sources";
export type BooksStatusFilterId = "all" | "unopened" | "in_progress" | "finished";

export type LibraryCollectionIcon =
  | "books"
  | "download"
  | "folder"
  | "stack"
  | "book"
  | "file";

export type LibrarySectionTabIcon = "stack" | "book";

export interface LibrarySectionTabVM {
  id: LibrarySectionKind;
  label: string;
  icon: LibrarySectionTabIcon;
  active: boolean;
}

export interface LibraryCollectionVM {
  id: string;
  label: string;
  count: number;
  icon: LibraryCollectionIcon;
  active: boolean;
  reorderable: boolean;
  isDefault: boolean;
}

export interface LibrarySortOptionVM {
  id: string;
  label: string;
}

export interface LibraryFilterOptionVM {
  id: string;
  label: string;
}

export interface LibraryToolbarVM {
  searchValue: string;
  searchPlaceholder: string;
  sortMode: string;
  sortDir: "asc" | "desc";
  sortOptions: LibrarySortOptionVM[];
  filterValue: string;
  filterOptions: LibraryFilterOptionVM[];
}

export interface LibraryDisplaySettings {
  viewMode: LibraryViewMode;
  preferredColumns: LibraryPreferredGridColumns;
  showProgress: boolean;
  showOutline: boolean;
}

export interface BooksTypeOptionVM {
  id: BooksTypeFilterId;
  label: string;
  count: number;
  active: boolean;
}

export interface LibraryCardBadgeVM {
  kind: "download" | "unread" | "subtype" | "status";
  label: string;
}

export interface LibraryCardProgressVM {
  primaryLabel: string;
  secondaryLabel?: string;
  percent?: number;
}

export interface LibrarySourceMetricBannerVM {
  flagLabel: string;
  downloadedCount: number;
  newCount: number;
}

export interface LibraryCardVM {
  id: string;
  title: string;
  subtitle?: string;
  coverSrc: string | null;
  coverFit: "cover" | "contain";
  badges: LibraryCardBadgeVM[];
  sourceMetricBanner?: LibrarySourceMetricBannerVM | null;
  metaChips: string[];
  progress?: LibraryCardProgressVM | null;
  selectable: boolean;
  selected: boolean;
  disabled?: boolean;
}

export interface LibrarySectionVM {
  kind: LibrarySectionKind;
  sectionTabs: LibrarySectionTabVM[];
  collections: LibraryCollectionVM[];
  toolbar: LibraryToolbarVM;
  loading: boolean;
  error: string | null;
  emptyMessage: string;
}

export interface ComicsSectionVM extends LibrarySectionVM {
  kind: "comics";
  cards: LibraryCardVM[];
  selectionEnabled: boolean;
  selectedIds: Set<number>;
  showBulkBar: boolean;
}

export interface BooksSectionVM extends LibrarySectionVM {
  kind: "books";
  cards: LibraryCardVM[];
  typeOptions: BooksTypeOptionVM[];
  activeCategoryId: string | null;
  activeType: BooksTypeFilterId;
  activeStatus: BooksStatusFilterId;
  dragDropEnabled: boolean;
  importing: boolean;
  dropActive: boolean;
}

export interface LibraryCollectionsReorderApi {
  activeId: string | null;
  targetId: string | null;
  insertIndex: number | null;
  onDragStart: (id: string, event: DragEvent) => void;
  onDragOver: (id: string, index: number, event: DragEvent) => void;
  onDragLeave: (id: string, event: DragEvent) => void;
  onDrop: (id: string, index: number, event: DragEvent) => void;
  onDragEnd: (event: DragEvent) => void;
}

export type LibraryCardOpenEvent = MouseEvent | KeyboardEvent;

export interface LibraryCardGridCallbacks {
  onOpen: (id: string, event: LibraryCardOpenEvent) => void;
  onContextMenu?: (id: string, event: MouseEvent) => void;
  onPointerDown?: (id: string, event: PointerEvent) => void;
  onPointerUp?: (id: string, event: PointerEvent) => void;
  onPointerLeave?: (id: string, event: PointerEvent) => void;
  onCoverLoad?: (id: string) => void;
  onCoverError?: (id: string) => void;
}

export interface ComicsLibraryActions extends LibraryCardGridCallbacks {
  openSection: (section: LibrarySectionKind) => void;
  selectCollection: (id: string) => void;
  setSearch: (value: string) => void;
  setSortMode: (id: string) => void;
  setSortDir: (dir: "asc" | "desc") => void;
  setFilter: (id: string) => void;
  reorderCollection?: (dragId: string, targetId: string, insertIndex: number) => Promise<void>;
}

export interface BooksLibraryActions extends LibraryCardGridCallbacks {
  openSection: (section: LibrarySectionKind) => void;
  selectCollection: (id: string) => void;
  selectType: (id: BooksTypeFilterId) => void;
  setSearch: (value: string) => void;
  setSortMode: (id: string) => void;
  setSortDir: (dir: "asc" | "desc") => void;
  setFilter: (id: string) => void;
  dragEnter?: (paths: string[]) => void;
  dragLeave?: () => void;
  dropFiles?: (paths: string[]) => Promise<void>;
}
