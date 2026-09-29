import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { page } from "@vitest/browser/context";
import { createFirstRunState } from "../../lib/firstRun";
import { DEFAULT_SETTINGS, store } from "../../store/state.svelte";
import { applyAppLanguage } from "../../lib/i18n/runtime";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null), convertFileSrc: (path: string) => path }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}), emit: vi.fn(async () => {}), emitTo: vi.fn(async () => {}) }));
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: vi.fn(async () => new Response("{}", { status: 503 })) }));
vi.mock("../../lib/client", () => ({
  getServerUrl: () => "http://127.0.0.1:0",
  getServerAuthHeader: () => null,
  serverFileUrl: (url: string) => url,
  thumbUrl: (url: string) => url,
  gql: vi.fn(async () => ({ sources: { nodes: [] }, trackers: { nodes: [] }, mangas: { nodes: [] }, trackRecords: { nodes: [] }, extensions: { nodes: [] }, settings: {} })),
  gqlUpload: vi.fn(async () => ({})),
}));
vi.mock("../../lib/setup/firstRunDiscoveryWorkflow", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/setup/firstRunDiscoveryWorkflow")>();
  return {
    ...actual,
    createProductionFirstRunDiscoveryWorkflow: () => actual.createFirstRunDiscoveryWorkflow({
      loadMangaSources: async () => [{ id: "fixture-comics", name: "Comics source" }],
      loadNovelSources: async () => [{ id: "fixture-novels", name: "Novels source" }],
      findManga: async () => ["The quiet forest", "Across the sea"].map((title, id) => ({ id, title, coverUrl: null, inLibrary: false })),
      findNovels: async () => ["A traveller's journal", "Letters from home"].map((title, id) => ({ id: String(id), path: String(id), title, coverUrl: null, inLibrary: false })),
      addManga: async (_source, item) => {
        store.setLibraryMangaSnapshot([{ id: Number(item.id), title: item.title, thumbnailUrl: "", inLibrary: true }]);
      },
      addNovel: async () => {},
    }),
  };
});

import FirstRun from "./FirstRun.svelte";
import FirstRunBackupStep from "./FirstRunBackupStep.svelte";
import { createBackupWorkflow } from "../../lib/backup/backupWorkflow";
import { contrastRatio } from "../../lib/theme/paletteQuality";

beforeEach(() => {
  document.body.style.minWidth = "0";
  document.body.style.minHeight = "100%";
  localStorage.clear();
  store.settings = { ...DEFAULT_SETTINGS, appLanguage: "en", theme: "light", discordRpc: false };
  document.documentElement.dataset.theme = "light";
  store.libraryMangaSnapshot = [];
  store.books = [];
  store.runtimeResolvedLocalProfileId = "test";
  store.runtimeServerUrl = "http://127.0.0.1:0";
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

test.each([{ width: 1280, height: 800 }, { width: 800, height: 600 }])(
  "uses the full first-run workspace at $width × $height",
  async ({ width, height }) => {
    await page.viewport(width, height);
    const { container } = render(FirstRun, { props: { initialState: createFirstRunState() } });

    expect(container.querySelectorAll(".first-run-titlebar")).toHaveLength(1);
    expect(container.querySelectorAll(".first-run-progress")).toHaveLength(1);
    expect(container.querySelectorAll(".first-run-workspace")).toHaveLength(1);
    expect(container.querySelectorAll(".first-run-page")).toHaveLength(1);
    expect(container.querySelector(".settings-page, .browse-topbar, .sidebar, .rail")).toBeNull();
    expect(screen.getByText("Initial setup")).toBeTruthy();

    const shell = container.querySelector<HTMLElement>(".first-run-shell")!;
    const pageInner = container.querySelector<HTMLElement>(".first-run-page-inner")!;
    expect(shell.getBoundingClientRect().top).toBeGreaterThanOrEqual(0);
    expect(shell.getBoundingClientRect().bottom).toBeLessThanOrEqual(window.innerHeight);
    expect(pageInner.getBoundingClientRect().width).toBeGreaterThanOrEqual(width * 0.85);
    const themeGrid = container.querySelector<HTMLElement>(".theme-grid")!;
    expect(getComputedStyle(themeGrid).gridTemplateColumns.split(" ")).toHaveLength(width <= 700 ? 2 : 4);
    if (width <= 900) expect(getComputedStyle(container.querySelector(".first-run-progress li")!).display).toBe("grid");

    const continueButton = screen.getByRole("button", { name: "Continue" });
    continueButton.scrollIntoView({ block: "center" });
    const buttonRect = continueButton.getBoundingClientRect();
    expect(buttonRect.bottom).toBeLessThanOrEqual(window.innerHeight);
    expect(document.elementFromPoint(buttonRect.x + buttonRect.width / 2, buttonRect.y + buttonRect.height / 2)?.closest("button")).toBe(continueButton);

    await fireEvent.click(continueButton);
    expect(screen.getByRole("heading", { name: "How do you want to begin?" })).toBeTruthy();
    expect(container.querySelectorAll(".first-run-page")).toHaveLength(1);
    expect(container.querySelector(".settings-page, .browse-topbar, .sidebar, .rail")).toBeNull();
  },
);

test("keeps setup choices inside the mockup surface instead of nesting production pages", () => {
  const { container } = render(FirstRun, { props: { initialState: { ...createFirstRunState(), step: "entry" } } });

  expect(container.querySelector(".first-run-choice-list")).not.toBeNull();
  expect(screen.getByRole("button", { name: /Restore backups/i })).toBeTruthy();
  expect(container.querySelector(".settings-page, .browse-topbar, .sources-page, .rail")).toBeNull();
});

test.each([{ width: 1280, height: 800 }, { width: 800, height: 600 }])(
  "aligns progress and content to the same grid at $width × $height",
  async ({ width, height }) => {
    await page.viewport(width, height);
    const { container } = render(FirstRun, { props: { initialState: createFirstRunState() } });
    const progress = container.querySelector(".first-run-progress ol")!.getBoundingClientRect();
    const content = container.querySelector(".first-run-page-inner")!.getBoundingClientRect();
    expect(Math.abs(progress.left - content.left)).toBeLessThanOrEqual(1);
    expect(Math.abs(progress.right - content.right)).toBeLessThanOrEqual(1);
  },
);

test("spreads the progress steps symmetrically across the content width", async () => {
  await page.viewport(1280, 800);
  const { container } = render(FirstRun, { props: { initialState: createFirstRunState() } });
  const bar = container.querySelector(".first-run-progress ol")!.getBoundingClientRect();
  const steps = [...container.querySelectorAll(".first-run-progress li")];
  const firstIcon = steps[0].querySelector(".first-run-progress-icon")!.getBoundingClientRect();
  const lastLabel = steps.at(-1)!.querySelector(".first-run-progress-label")!.getBoundingClientRect();
  expect(Math.abs(firstIcon.left - bar.left)).toBeLessThanOrEqual(1);
  expect(Math.abs(bar.right - lastLabel.right)).toBeLessThanOrEqual(1);
});

test("theme previews represent the palette actually applied by each choice", async () => {
  const { container } = render(FirstRun, { props: { initialState: createFirstRunState() } });
  const tokenProbe = document.createElement("span");
  container.appendChild(tokenProbe);
  for (const label of ["Nocturne", "Dark", "AMOLED", "High Contrast", "Light", "Light Contrast", "Midnight", "Warm"]) {
    const choice = screen.getByRole("button", { name: label });
    await fireEvent.click(choice);
    expect(choice.getAttribute("aria-pressed")).toBe("true");
    // App owns applying the selected theme outside this isolated component.
    document.documentElement.dataset.theme = store.settings.theme;
    // The primary fill is painted by the button's ::before layer so the press ripple can sit above it.
    const primaryButton = screen.getByRole("button", { name: "Continue" });
    const primaryFill = getComputedStyle(primaryButton, "::before").backgroundColor;
    expect(contrastRatio(getComputedStyle(primaryButton).color, primaryFill), `${label} primary contrast`).toBeGreaterThanOrEqual(4.5);
    const swatches = [...choice.querySelectorAll(".theme-swatches i")];
    for (const [index, token] of ["--bg-base", "--bg-raised", "--accent", "--text-primary"].entries()) {
      tokenProbe.style.backgroundColor = `var(${token})`;
      expect(getComputedStyle(swatches[index]).backgroundColor, `${label} ${token}`).toBe(getComputedStyle(tokenProbe).backgroundColor);
    }
  }
});

test.each([{ width: 1280, height: 600 }, { width: 800, height: 600 }])(
  "keeps the common grid when a native scrollbar reserves space at $width × $height",
  async ({ width, height }) => {
    await page.viewport(width, height);
    const { container } = render(FirstRun, { props: { initialState: createFirstRunState() } });
    const scrollport = container.querySelector<HTMLElement>(".first-run-page")!;
    // WebView2 on Windows reserves scrollbar width; headless Chromium may overlay it.
    scrollport.style.scrollbarGutter = "stable";
    scrollport.style.overflowY = "scroll";
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const progress = container.querySelector(".first-run-progress ol")!.getBoundingClientRect();
    const content = container.querySelector(".first-run-page-inner")!.getBoundingClientRect();
    expect(scrollport.offsetWidth - scrollport.clientWidth).toBeGreaterThan(0);
    expect(Math.abs(progress.left - content.left)).toBeLessThanOrEqual(1);
    expect(Math.abs(progress.right - content.right)).toBeLessThanOrEqual(1);
    expect(scrollport.scrollWidth).toBeLessThanOrEqual(scrollport.clientWidth);
  },
);

test.each([0.85, 1.15])("setup controls follow app typography at resolution scale %s", (scale) => {
  document.documentElement.style.setProperty("--app-resolution-scale", String(scale));
  const { container } = render(FirstRun, { props: { initialState: createFirstRunState() } });
  expect(parseFloat(getComputedStyle(container.querySelector(".first-run-progress li")!).fontSize)).toBeCloseTo(13 * scale, 1);
  expect(parseFloat(getComputedStyle(screen.getByRole("button", { name: "Continue" })).fontSize)).toBeCloseTo(13 * scale, 1);
  expect(parseFloat(getComputedStyle(screen.getByRole("button", { name: "Nocturne" })).fontSize)).toBeCloseTo(14 * scale, 1);
});

test.each(["theme", "backup", "sources", "trackers", "discover"] as const)(
  "uses the app's action tokens in the %s step",
  async (step) => {
    document.documentElement.dataset.theme = "nocturne";
    document.documentElement.style.setProperty("--app-resolution-scale", "0.85");
    const { container } = render(FirstRun, { props: { initialState: { ...createFirstRunState(), step, path: step === "backup" ? "backup" : "fresh" } } });
    if (step === "trackers") await screen.findByText("Hardcover");
    const probe = document.createElement("span");
    probe.style.color = "var(--color-on-accent-strong)";
    container.appendChild(probe);
    const primary = container.querySelector<HTMLElement>("button.fr-btn--primary")!;
    expect(primary).not.toBeNull();
    expect(getComputedStyle(primary).color).toBe(getComputedStyle(probe).color);
    const fillProbe = document.createElement("span");
    fillProbe.style.backgroundColor = "var(--accent)";
    container.appendChild(fillProbe);
    expect(getComputedStyle(primary, "::before").backgroundColor).toBe(getComputedStyle(fillProbe).backgroundColor);
    const expectedSize = primary.classList.contains("fr-btn--small") ? 9.35 : 11.05;
    expect(parseFloat(getComputedStyle(primary).fontSize)).toBeCloseTo(expectedSize, 1);
  },
);

test("uses the workspace width for tracker choices and actions", async () => {
  await page.viewport(1280, 800);
  const { container } = render(FirstRun, { props: { initialState: { ...createFirstRunState(), step: "trackers", path: "fresh" } } });
  await screen.findByText("Hardcover");
  const inner = container.querySelector(".first-run-page-inner")!.getBoundingClientRect();
  const grid = container.querySelector<HTMLElement>(".tracker-grid")!;
  const actions = container.querySelector<HTMLElement>(".fr-footer")!;
  expect(grid.getBoundingClientRect().width).toBeCloseTo(inner.width, 0);
  expect(getComputedStyle(grid).gridTemplateColumns.split(" ")).toHaveLength(3);
  expect(actions.getBoundingClientRect().right).toBeCloseTo(inner.right, 0);
  // Rows stay borderless and unfilled until hovered.
  const row = container.querySelector<HTMLElement>(".tracker-row")!;
  expect(getComputedStyle(row).backgroundColor).toBe("rgba(0, 0, 0, 0)");
  expect(getComputedStyle(row).borderTopWidth).toBe("0px");
});

test("backup review keeps the mockup's open summary instead of a segmented panel", async () => {
  const workflow = createBackupWorkflow({
    inspect: async () => ({ plan: null, workCount: 9, chapterCount: 6936, repositoryCount: 2, extensionCount: 19, conflictCount: 0, libraryKinds: ["novels"], needsSourceKinds: [] }),
    restore: async () => {},
  });
  const { container } = render(FirstRunBackupStep, { props: { workflow, picker: async () => [new File(["layout fixture"], "novels.epigraphbk")] } });
  await fireEvent.click(screen.getByRole("button", { name: "Select" }));
  await screen.findByText("novels.epigraphbk");
  await fireEvent.click(screen.getByRole("button", { name: "Review import" }));
  expect(screen.getByText("9", { exact: true })).toBeTruthy();
  const summary = container.querySelector<HTMLElement>(".summary-strip")!;
  expect(getComputedStyle(summary).backgroundColor).toBe("rgba(0, 0, 0, 0)");
  expect(getComputedStyle(summary.firstElementChild!).borderRightWidth).toBe("0px");
});

test("uses the quiet titlebar and a borderless file selection area", () => {
  const { container } = render(FirstRun, { props: { initialState: { ...createFirstRunState(), step: "backup", path: "backup" } } });
  const probe = document.createElement("span");
  probe.style.color = "var(--text-secondary)";
  probe.style.backgroundColor = "color-mix(in srgb, var(--text-primary) 4%, transparent)";
  container.appendChild(probe);
  const subtitle = container.querySelector(".first-run-identity small")!;
  const upload = container.querySelector(".upload-zone")!;
  expect(getComputedStyle(subtitle).color).toBe(getComputedStyle(probe).color);
  expect(getComputedStyle(subtitle).borderLeftWidth).toBe("0px");
  expect(getComputedStyle(upload).backgroundColor).toBe(getComputedStyle(probe).backgroundColor);
  expect(getComputedStyle(upload).borderTopWidth).toBe("0px");
});

test("preserves readable step labels for assistive technology in a narrow window", async () => {
  await page.viewport(390, 700);
  const { container } = render(FirstRun, { props: { initialState: createFirstRunState() } });
  const labels = [...container.querySelectorAll(".first-run-progress-label")];
  expect(labels).toHaveLength(5);
  for (const label of labels) {
    expect(getComputedStyle(label).display).not.toBe("none");
    expect(getComputedStyle(label).visibility).not.toBe("hidden");
    expect(label.getAttribute("aria-hidden")).not.toBe("true");
  }
});

test.each(["backup", "sources", "trackers", "discover"] as const)("preserves heading hierarchy and focus in the dedicated %s step", async (step) => {
  await page.viewport(800, 600);
  const { container } = render(FirstRun, { props: { initialState: { ...createFirstRunState(), step, path: step === "backup" ? "backup" : "fresh" } } });
  const heading = screen.getByRole("heading", { level: 1 });
  await waitFor(() => expect(document.activeElement).toBe(heading));
  expect(parseFloat(getComputedStyle(heading).fontSize)).toBeGreaterThanOrEqual(28);
  expect(parseFloat(getComputedStyle(heading).fontSize)).toBeLessThanOrEqual(34);
  expect(container.querySelector(".settings-page, .browse-topbar, .sources-page, .rail")).toBeNull();
});

test.each([{ width: 1280, height: 800 }, { width: 800, height: 600 }])(
  "offers compact Portuguese discovery controls at $width × $height",
  async ({ width, height }) => {
    await page.viewport(width, height);
    store.settings.appLanguage = "pt-BR";
    applyAppLanguage("pt-BR");
    const { container } = render(FirstRun, { props: { initialState: { ...createFirstRunState(), step: "discover", path: "fresh" } } });
    await screen.findByText("A traveller's journal");
    expect(screen.getByRole("heading", { name: "Adicione obras à biblioteca" })).toBeTruthy();
    expect(container.querySelector(".browse-topbar, .settings-page, .rail")).toBeNull();
    const grid = container.querySelector<HTMLElement>(".work-grid")!;
    expect(getComputedStyle(grid).gridTemplateColumns.split(" ")).toHaveLength(width === 800 ? 4 : 7);
    expect(container.querySelector(".work-card")!.getBoundingClientRect().width).toBeLessThanOrEqual(192);
    expect(container.querySelector<HTMLElement>(".first-run-page")!.scrollWidth).toBeLessThanOrEqual(width);
    expect(screen.getByRole("button", { name: "Concluir configuração" }).hasAttribute("disabled")).toBe(true);
    console.info("Discovery screenshot:", await page.screenshot());
    await page.getByRole("button", { name: "Adicionar The quiet forest", exact: true }).click();
    await waitFor(() => expect(screen.getByRole("button", { name: "Concluir configuração" }).hasAttribute("disabled")).toBe(false));
    await page.getByRole("button", { name: "Concluir configuração", exact: true }).click();
    expect(screen.getByRole("heading", { name: "Tudo pronto" })).toBeTruthy();
  },
);


test.each([{ width: 1280, height: 800 }, { width: 800, height: 600 }, { width: 1920, height: 1080 }])(
  "keeps titlebar controls aligned and the primary action at the workspace edge at $width × $height",
  async ({ width, height }) => {
    await page.viewport(width, height);
    const { container } = render(FirstRun, { props: { initialState: createFirstRunState() } });
    const header = container.querySelector(".first-run-titlebar")!.getBoundingClientRect();
    const controls = [...container.querySelectorAll(".window-controls-inline__btn")];
    expect(controls).toHaveLength(3);
    for (const control of controls) {
      const bounds = control.getBoundingClientRect();
      expect(bounds.width).toBeGreaterThanOrEqual(44);
      expect(bounds.height).toBeGreaterThanOrEqual(40);
      expect(Math.abs(bounds.top + bounds.height / 2 - (header.top + header.height / 2))).toBeLessThanOrEqual(1);
      const icon = control.querySelector("svg, .material-symbols-outlined")!;
      expect(icon.getBoundingClientRect().width).toBeGreaterThanOrEqual(12);
    }
    const primary = screen.getByRole("button", { name: "Continue" }).getBoundingClientRect();
    expect(primary.bottom).toBeGreaterThanOrEqual(height - 40);
    expect(primary.bottom).toBeLessThanOrEqual(height);
    expect(primary.right).toBeGreaterThanOrEqual(width - 64);
    expect(container.querySelector<HTMLElement>(".first-run-page")!.scrollWidth).toBeLessThanOrEqual(width);
  },
);

test("uses the same page and chrome palette as the app for all built-in themes", async () => {
  await page.viewport(1280, 800);
  const { container } = render(FirstRun, { props: { initialState: createFirstRunState() } });
  const pageProbe = document.createElement("div");
  pageProbe.style.background = "var(--component-app-bg)";
  const chromeProbe = document.createElement("div");
  chromeProbe.style.background = "var(--component-topbar-bg)";
  container.append(pageProbe, chromeProbe);
  for (const label of ["Nocturne", "Dark", "AMOLED", "High Contrast", "Light", "Light Contrast", "Midnight", "Warm"]) {
    await fireEvent.click(screen.getByRole("button", { name: label }));
    document.documentElement.dataset.theme = store.settings.theme;
    const shell = getComputedStyle(container.querySelector(".first-run-shell")!);
    const chrome = getComputedStyle(container.querySelector(".first-run-titlebar")!);
    expect(shell.backgroundColor, label).toBe(getComputedStyle(pageProbe).backgroundColor);
    expect(shell.backgroundImage, label).toBe(getComputedStyle(pageProbe).backgroundImage);
    expect(chrome.backgroundColor, label).toBe(getComputedStyle(chromeProbe).backgroundColor);
    if (label === "Nocturne" || label === "Light") console.info(label + " First Run screenshot:", await page.screenshot());
  }
});

test.each([{ width: 1280, height: 800 }, { width: 1920, height: 1080 }])(
  "keeps setup choices compact without shrinking the workspace at $width × $height",
  async ({ width, height }) => {
    await page.viewport(width, height);
    const { container } = render(FirstRun, { props: { initialState: createFirstRunState() } });
    const headingSize = parseFloat(getComputedStyle(screen.getByRole("heading", { level: 1 })).fontSize);
    expect(headingSize).toBeGreaterThanOrEqual(28);
    expect(headingSize).toBeLessThanOrEqual(34);
    for (const choice of container.querySelectorAll(".theme-option")) {
      expect(choice.getBoundingClientRect().height).toBeLessThanOrEqual(144);
      expect(choice.querySelector(".theme-swatches")!.getBoundingClientRect().height).toBeLessThanOrEqual(96);
    }
    expect(container.querySelector(".first-run-page-inner")!.getBoundingClientRect().width).toBeGreaterThan(width * .85);
    await fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    // Entry choices are one row of equal cards that stay compact next to the workspace.
    const cards = [...container.querySelectorAll(".entry-list button")].map((choice) => choice.getBoundingClientRect());
    expect(cards).toHaveLength(3);
    for (const card of cards) {
      expect(card.height).toBeLessThanOrEqual(200);
      expect(Math.abs(card.top - cards[0].top)).toBeLessThanOrEqual(1);
      expect(Math.abs(card.height - cards[0].height)).toBeLessThanOrEqual(1);
    }
  },
);
