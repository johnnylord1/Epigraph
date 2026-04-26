export type ReaderThemePreference =
  | "dark"
  | "light"
  | "sepia"
  | "system";

export type ReaderTextAlignPreference =
  | "start"
  | "justify";

export type ReaderReadingDirectionPreference =
  | "ltr"
  | "rtl";

export type PdfFitModePreference =
  | "page-width"
  | "page-fit"
  | "auto-fit";

export interface ReaderUniversalPreferences {
  theme: ReaderThemePreference;
  immersiveMode: boolean;
  showProgressIndicator: boolean;
  showUiChrome: boolean;
  readingDirection: ReaderReadingDirectionPreference | null;
  showBookmarksHistoryShell: boolean;
}

export interface ReaderTextReflowPreferences {
  fontFamily: string | null;
  fontSizePx: number;
  lineHeight: number;
  textAlign: ReaderTextAlignPreference;
  paragraphSpacingPx: number;
  horizontalPaddingPx: number;
}

export interface ReaderPdfPreferences {
  zoom: number;
  fitMode: PdfFitModePreference;
  showBookmarksPanel: boolean;
  continuousScroll: boolean;
}

export interface ReaderPreferences {
  universal: ReaderUniversalPreferences;
  textReflow: ReaderTextReflowPreferences;
  pdf: ReaderPdfPreferences;
}

export interface ReaderCapabilities {
  supportsTypography: boolean;
  supportsTextAlign: boolean;
  supportsParagraphSpacing: boolean;
  supportsDirection: boolean;
  supportsZoom: boolean;
  supportsPageFit: boolean;
  supportsBookmarksPanel: boolean;
  supportsToc: boolean;
  supportsContinuousScroll: boolean;
  supportsImmersive: boolean;
}

export type ReaderAdapterKind =
  | "novel-html"
  | "epub"
  | "pdf";

export interface ReaderSection {
  id: string;
  label: string;
}

export type ReaderLocation =
  | {
    kind: "novel-html";
    chapterId: string;
    locator: string | null;
    progressPercent: number;
  }
  | {
    kind: "epub";
    href: string | null;
    cfi: string | null;
    progressPercent: number;
  }
  | {
    kind: "pdf";
    pageIndex: number;
    totalPages: number | null;
    progressPercent: number;
  };

export interface ReaderDocument {
  kind: ReaderAdapterKind;
  title: string;
  sections: ReaderSection[];
}

export interface ReaderAdapter<TInput = unknown> {
  kind: ReaderAdapterKind;
  capabilities: ReaderCapabilities;
  open(input: TInput): Promise<ReaderDocument>;
  applyPreferences(preferences: ReaderPreferences): Promise<void>;
  getLocation(): Promise<ReaderLocation>;
  goTo(location: ReaderLocation): Promise<void>;
  next(): Promise<void>;
  prev(): Promise<void>;
  destroy(): Promise<void>;
}

export const DEFAULT_READER_PREFERENCES: ReaderPreferences = {
  universal: {
    theme: "dark",
    immersiveMode: true,
    showProgressIndicator: true,
    showUiChrome: true,
    readingDirection: "ltr",
    showBookmarksHistoryShell: true,
  },
  textReflow: {
    fontFamily: null,
    fontSizePx: 18,
    lineHeight: 1.7,
    textAlign: "start",
    paragraphSpacingPx: 10,
    horizontalPaddingPx: 20,
  },
  pdf: {
    zoom: 1,
    fitMode: "page-width",
    showBookmarksPanel: false,
    continuousScroll: true,
  },
};

export const READER_CAPABILITY_PRESETS: Record<ReaderAdapterKind, ReaderCapabilities> = {
  "novel-html": {
    supportsTypography: true,
    supportsTextAlign: true,
    supportsParagraphSpacing: true,
    supportsDirection: true,
    supportsZoom: false,
    supportsPageFit: false,
    supportsBookmarksPanel: false,
    supportsToc: true,
    supportsContinuousScroll: false,
    supportsImmersive: true,
  },
  epub: {
    supportsTypography: true,
    supportsTextAlign: true,
    supportsParagraphSpacing: true,
    supportsDirection: true,
    supportsZoom: false,
    supportsPageFit: false,
    supportsBookmarksPanel: false,
    supportsToc: true,
    supportsContinuousScroll: false,
    supportsImmersive: true,
  },
  pdf: {
    supportsTypography: false,
    supportsTextAlign: false,
    supportsParagraphSpacing: false,
    supportsDirection: false,
    supportsZoom: true,
    supportsPageFit: true,
    supportsBookmarksPanel: true,
    supportsToc: true,
    supportsContinuousScroll: true,
    supportsImmersive: true,
  },
};

export function getReaderCapabilities(kind: ReaderAdapterKind): ReaderCapabilities {
  return READER_CAPABILITY_PRESETS[kind];
}

export function canUseTextReflowControls(capabilities: ReaderCapabilities): boolean {
  return capabilities.supportsTypography || capabilities.supportsTextAlign || capabilities.supportsParagraphSpacing;
}
