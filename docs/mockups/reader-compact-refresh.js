function makeChapters(start, titles, progress) {
  return titles.map((subtitle, index) => ({
    label: `Ch. ${start + index}`,
    subtitle,
    current: progress[index]?.current ?? 1,
    total: progress[index]?.total ?? 24,
  }));
}

const series = [
  {
    id: "horizon",
    title: "The Horizon",
    coverTitle: "THE\nHORIZON",
    kicker: "Drama",
    source: "MangaDex",
    state: "reading",
    note: "quiet post-war drama",
    chapterShort: "Ch. 12",
    summary: "Sparse pacing, long vertical scenes, and a chapter structure that benefits from a very quiet dashboard.",
    cover: "cover-horizon",
    pageAccent: "#c7d2dc",
    offline: false,
    chapters: makeChapters(
      12,
      ["The Boy and the Girl", "Road of Glass", "Ashes and Floodlight", "Last Light"],
      [
        { current: 18, total: 26 },
        { current: 1, total: 24 },
        { current: 1, total: 28 },
        { current: 1, total: 21 },
      ],
    ),
    currentChapterIndex: 0,
  },
  {
    id: "witch-hat",
    title: "Witch Hat Atelier",
    coverTitle: "WITCH\nHAT",
    kicker: "Fantasy",
    source: "Local",
    state: "reading",
    note: "high-detail page art",
    chapterShort: "Ch. 84",
    summary: "Detailed spreads need a compact chrome so the page still owns most of the screen.",
    cover: "cover-witch-hat",
    pageAccent: "#d8c8a2",
    offline: true,
    chapters: makeChapters(
      84,
      ["Silver Eve", "At the Atelier", "Ink and Thread", "The Bell Tower"],
      [
        { current: 12, total: 34 },
        { current: 1, total: 31 },
        { current: 1, total: 29 },
        { current: 1, total: 33 },
      ],
    ),
    currentChapterIndex: 0,
  },
  {
    id: "vagabond",
    title: "Vagabond",
    coverTitle: "VAGA\nBOND",
    kicker: "Seinen",
    source: "Library",
    state: "reading",
    note: "slow reread archive",
    chapterShort: "Ch. 33",
    summary: "A reread shelf where finished and paused works still feel close to the active rotation.",
    cover: "cover-vagabond",
    pageAccent: "#d0c4b0",
    offline: false,
    chapters: makeChapters(
      33,
      ["The Lone Path", "Rain and Dust", "The Shrine", "Silence"],
      [
        { current: 7, total: 22 },
        { current: 1, total: 20 },
        { current: 1, total: 24 },
        { current: 1, total: 19 },
      ],
    ),
    currentChapterIndex: 0,
  },
  {
    id: "dandadan",
    title: "Dandadan",
    coverTitle: "DANDA\nDAN",
    kicker: "Action",
    source: "MANGA Plus",
    state: "upnext",
    note: "2 unread chapters",
    chapterShort: "Ch. 186",
    summary: "Fast weekly pickup with unread chapters pushed near the top, not buried inside a big hero layout.",
    cover: "cover-dandadan",
    pageAccent: "#f0c4cc",
    offline: false,
    chapters: makeChapters(
      186,
      ["Tunnel Noise", "Headlights", "City Run", "Cold Signal"],
      [
        { current: 1, total: 22 },
        { current: 1, total: 21 },
        { current: 1, total: 19 },
        { current: 1, total: 25 },
      ],
    ),
    currentChapterIndex: 0,
  },
  {
    id: "sakamoto",
    title: "Sakamoto Days",
    coverTitle: "SAKA\nMOTO",
    kicker: "Weekly",
    source: "Shonen Jump",
    state: "upnext",
    note: "1 unread chapter",
    chapterShort: "Ch. 164",
    summary: "Weekly rotation title with strong unread count emphasis.",
    cover: "cover-sakamoto",
    pageAccent: "#d0b899",
    offline: true,
    chapters: makeChapters(
      164,
      ["Late Checkout", "Switch Lane", "Paper Target", "Parking Level"],
      [
        { current: 1, total: 20 },
        { current: 1, total: 18 },
        { current: 1, total: 22 },
        { current: 1, total: 17 },
      ],
    ),
    currentChapterIndex: 0,
  },
  {
    id: "frieren",
    title: "Frieren",
    coverTitle: "FRIE\nREN",
    kicker: "Fantasy",
    source: "MangaDex",
    state: "upnext",
    note: "new chapter this morning",
    chapterShort: "Ch. 138",
    summary: "Ongoing fantasy placed in the queue shelf rather than taking over the whole dashboard.",
    cover: "cover-frieren",
    pageAccent: "#cfd6e3",
    offline: false,
    chapters: makeChapters(
      138,
      ["Quiet Spell", "Old Road", "Snow Field", "Golden Ash"],
      [
        { current: 1, total: 24 },
        { current: 1, total: 23 },
        { current: 1, total: 21 },
        { current: 1, total: 26 },
      ],
    ),
    currentChapterIndex: 0,
  },
  {
    id: "girls-last-tour",
    title: "Girls' Last Tour",
    coverTitle: "LAST\nTOUR",
    kicker: "Finished",
    source: "Library",
    state: "finished",
    note: "completed 6 vols",
    chapterShort: "Vol. 6",
    summary: "Completed works stay one click away and do not disappear behind a separate archive-only screen.",
    cover: "cover-last-tour",
    pageAccent: "#d6d1ca",
    offline: true,
    chapters: makeChapters(
      40,
      ["Rain Shelf", "Stone Town", "Signal", "Final Station"],
      [
        { current: 12, total: 12 },
        { current: 15, total: 15 },
        { current: 14, total: 14 },
        { current: 18, total: 18 },
      ],
    ),
    currentChapterIndex: 3,
  },
  {
    id: "goodbye-eri",
    title: "Goodbye, Eri",
    coverTitle: "GOOD\nBYE ERI",
    kicker: "Finished",
    source: "Local",
    state: "finished",
    note: "one-shot archive",
    chapterShort: "One-shot",
    summary: "One-shots and finished works should still feel like part of the library, not dead weight.",
    cover: "cover-eri",
    pageAccent: "#d7c0bb",
    offline: true,
    chapters: makeChapters(
      1,
      ["Opening Cut", "Streetlight", "Projection", "Final Roll"],
      [
        { current: 54, total: 54 },
        { current: 48, total: 48 },
        { current: 50, total: 50 },
        { current: 46, total: 46 },
      ],
    ),
    currentChapterIndex: 3,
  },
  {
    id: "solanin",
    title: "Solanin",
    coverTitle: "SOLA\nNIN",
    kicker: "Finished",
    source: "Library",
    state: "finished",
    note: "completed reread",
    chapterShort: "Vol. 2",
    summary: "Compact finished shelf for shorter completed works.",
    cover: "cover-solanin",
    pageAccent: "#d7cbb8",
    offline: false,
    chapters: makeChapters(
      18,
      ["Late Train", "Band Practice", "Glow", "Two Years Later"],
      [
        { current: 22, total: 22 },
        { current: 24, total: 24 },
        { current: 21, total: 21 },
        { current: 19, total: 19 },
      ],
    ),
    currentChapterIndex: 3,
  },
  {
    id: "pluto",
    title: "Pluto",
    coverTitle: "PLU\nTO",
    kicker: "Finished",
    source: "Library",
    state: "finished",
    note: "completed 8 vols",
    chapterShort: "Vol. 8",
    summary: "Long finished series remains visible on the home dashboard for quick revisits.",
    cover: "cover-pluto",
    pageAccent: "#c7cbd6",
    offline: false,
    chapters: makeChapters(
      60,
      ["The Investigator", "North 2", "The Child", "Last Sky"],
      [
        { current: 18, total: 18 },
        { current: 21, total: 21 },
        { current: 17, total: 17 },
        { current: 23, total: 23 },
      ],
    ),
    currentChapterIndex: 3,
  },
  {
    id: "blame",
    title: "BLAME!",
    coverTitle: "BLAME!",
    kicker: "Finished",
    source: "Offline",
    state: "finished",
    note: "downloaded archive",
    chapterShort: "Vol. 10",
    summary: "Offline completed shelf for dense rereadable material.",
    cover: "cover-blame",
    pageAccent: "#c5ccd2",
    offline: true,
    chapters: makeChapters(
      55,
      ["Megastructure", "Relay", "Dormant City", "Edge Sector"],
      [
        { current: 17, total: 17 },
        { current: 19, total: 19 },
        { current: 18, total: 18 },
        { current: 16, total: 16 },
      ],
    ),
    currentChapterIndex: 3,
  },
];

const updates = [
  { tone: "sage", title: "3 simulpub chapters landed", meta: "Dandadan, Frieren, Sakamoto Days" },
  { tone: "amber", title: "Offline queue is ready", meta: "Witch Hat Atelier and BLAME! fully cached" },
  { tone: "blue", title: "Tracking synced", meta: "AniList and local progress match on 9 works" },
  { tone: "muted", title: "Finished shelf updated", meta: "Goodbye, Eri added to archive row" },
];

const viewMeta = {
  dashboard: { kicker: "Reading flow", title: "Dashboard" },
  library: { kicker: "Collection density", title: "Library" },
  reader: { kicker: "Minimal chrome", title: "Reader" },
};

const state = {
  activeView: "dashboard",
  activeSeriesId: "horizon",
  activeChapterIndex: 0,
  libraryFilter: "all",
  cardView: "grid",
  readerMode: "fit",
  brightness: 82,
  currentPage: 18,
};

const elements = {
  viewKicker: document.getElementById("view-kicker"),
  viewTitle: document.getElementById("view-title"),
  currentSeries: document.getElementById("current-series"),
  updatesFeed: document.getElementById("updates-feed"),
  queueShelf: document.getElementById("queue-shelf"),
  finishedShelf: document.getElementById("finished-shelf"),
  collectionList: document.getElementById("collection-list"),
  libraryGrid: document.getElementById("library-grid"),
  libraryHeading: document.getElementById("library-heading"),
  libraryCount: document.getElementById("library-count"),
  readerSeriesTitle: document.getElementById("reader-series-title"),
  readerSeriesMeta: document.getElementById("reader-series-meta"),
  stageSeriesLabel: document.getElementById("stage-series-label"),
  stagePageLabel: document.getElementById("stage-page-label"),
  chapterList: document.getElementById("chapter-list"),
  progressRange: document.getElementById("progress-range"),
  brightnessRange: document.getElementById("brightness-range"),
  readerProgressNumber: document.getElementById("reader-progress-number"),
  readerProgressFill: document.getElementById("reader-progress-fill"),
  footerProgressFill: document.getElementById("footer-progress-fill"),
  footerProgressLabel: document.getElementById("footer-progress-label"),
  brightnessNumber: document.getElementById("brightness-number"),
  readerLayout: document.getElementById("reader-layout"),
  pageSheet: document.getElementById("page-sheet"),
  views: Array.from(document.querySelectorAll(".view")),
  navButtons: Array.from(document.querySelectorAll(".nav-button")),
  filterButtons: Array.from(document.querySelectorAll(".filter-chip")),
  densityButtons: Array.from(document.querySelectorAll(".density-button")),
  modeButtons: Array.from(document.querySelectorAll(".mode-chip")),
};

function getSeries(id) {
  return series.find((item) => item.id === id) ?? series[0];
}

function getActiveSeries() {
  return getSeries(state.activeSeriesId);
}

function getActiveChapter() {
  const item = getActiveSeries();
  return item.chapters[state.activeChapterIndex] ?? item.chapters[0];
}

function getStateLabel(item) {
  if (item.state === "reading") return "Reading";
  if (item.state === "upnext") return "Up next";
  if (item.state === "finished") return "Finished";
  return "Shelf";
}

function buildCover(item) {
  return `
    <div class="cover-art ${item.cover}">
      <span class="cover-kicker">${item.kicker}</span>
      <strong class="cover-title">${item.coverTitle}</strong>
      <em class="cover-meta">${item.chapterShort}</em>
    </div>
  `;
}

function pulse(element) {
  if (!element) return;
  element.classList.remove("pulse");
  window.requestAnimationFrame(() => {
    element.classList.add("pulse");
    window.setTimeout(() => element.classList.remove("pulse"), 220);
  });
}

function applyActiveStates() {
  elements.navButtons.forEach((button) => {
    button.classList.toggle("nav-button-active", button.dataset.view === state.activeView);
  });
  elements.filterButtons.forEach((button) => {
    button.classList.toggle("filter-chip-active", button.dataset.filter === state.libraryFilter);
  });
  elements.densityButtons.forEach((button) => {
    button.classList.toggle("density-button-active", button.dataset.cardView === state.cardView);
  });
  elements.modeButtons.forEach((button) => {
    button.classList.toggle("mode-chip-active", button.dataset.readerMode === state.readerMode);
  });
}

function updateTopbar() {
  const meta = viewMeta[state.activeView];
  elements.viewKicker.textContent = meta.kicker;
  elements.viewTitle.textContent = meta.title;
}

function switchView(view) {
  state.activeView = view;
  elements.views.forEach((panel) => {
    const active = panel.dataset.viewPanel === view;
    panel.hidden = !active;
    panel.classList.toggle("view-active", active);
  });
  applyActiveStates();
  updateTopbar();
}

function updateProgressUI() {
  const chapter = getActiveChapter();
  const percent = Math.max(0, Math.min(1, state.currentPage / chapter.total));
  const progressLabel = `${state.currentPage} / ${chapter.total}`;
  const pageLabel = `Page ${state.currentPage} / ${chapter.total}`;

  elements.readerSeriesMeta.textContent = `${chapter.label} / page ${state.currentPage}`;
  elements.stagePageLabel.textContent = pageLabel;
  elements.readerProgressNumber.textContent = progressLabel;
  elements.footerProgressLabel.textContent = pageLabel;
  elements.readerProgressFill.style.width = `${percent * 100}%`;
  elements.footerProgressFill.style.width = `${percent * 100}%`;
  elements.progressRange.max = String(chapter.total);
  elements.progressRange.value = String(state.currentPage);
}

function updateBrightness() {
  elements.brightnessNumber.textContent = `${state.brightness}%`;
  elements.pageSheet.style.setProperty("--sheet-brightness", String(state.brightness / 100));
}

function renderCurrentSeries() {
  const item = getActiveSeries();
  const chapter = getActiveChapter();
  const percent = Math.round((state.currentPage / chapter.total) * 100);

  elements.currentSeries.innerHTML = `
    <div class="current-grid">
      ${buildCover(item)}
      <div class="current-copy">
        <div class="tag-row">
          <span class="status-pill status-${item.state}">${getStateLabel(item)}</span>
          <span class="quiet-pill">${item.source}</span>
          ${item.offline ? '<span class="quiet-pill">Offline</span>' : ""}
        </div>
        <h4>${item.title}</h4>
        <p class="current-summary">${item.summary}</p>
        <div class="progress-line">
          <span>${chapter.label} - ${chapter.subtitle}</span>
          <span>${percent}% read</span>
        </div>
        <div class="mini-progress"><span style="width:${percent}%"></span></div>
        <div class="current-actions">
          <button type="button" class="primary-button" data-view="reader">Resume from page ${state.currentPage}</button>
          <button type="button" class="ghost-button" data-series="${item.id}" data-open-reader="true">Chapter list</button>
        </div>
        <div class="chapter-pills">
          ${item.chapters.slice(0, 4).map((entry, index) => `
            <button type="button" class="chapter-pill ${index === state.activeChapterIndex ? "chapter-pill-active" : ""}" data-chapter-index="${index}">
              <strong>${entry.label}</strong>
              <span>${entry.subtitle}</span>
            </button>
          `).join("")}
        </div>
      </div>
    </div>
  `;
}

function renderUpdates() {
  elements.updatesFeed.innerHTML = updates.map((entry) => `
    <article class="feed-item">
      <span class="tone-dot tone-${entry.tone}"></span>
      <div>
        <strong>${entry.title}</strong>
        <span>${entry.meta}</span>
      </div>
    </article>
  `).join("");
}

function renderShelf(target, items, finished = false) {
  target.innerHTML = items.map((item) => `
    <button type="button" class="shelf-card ${finished ? "shelf-card-finished" : ""}" data-series="${item.id}" data-open-reader="true">
      ${buildCover(item)}
      <div class="shelf-copy">
        <strong>${item.title}</strong>
        <span>${item.note}</span>
      </div>
    </button>
  `).join("");
}

function renderCollections() {
  const filters = [
    { id: "all", label: "All titles" },
    { id: "reading", label: "Reading now" },
    { id: "upnext", label: "Queue" },
    { id: "finished", label: "Finished" },
    { id: "offline", label: "Offline" },
  ];

  elements.collectionList.innerHTML = filters.map((filter) => {
    const count = series.filter((item) => {
      if (filter.id === "all") return true;
      if (filter.id === "offline") return item.offline;
      return item.state === filter.id;
    }).length;
    return `
      <button type="button" class="collection-button ${state.libraryFilter === filter.id ? "collection-button-active" : ""}" data-filter="${filter.id}">
        <span>${filter.label}</span>
        <small>${count}</small>
      </button>
    `;
  }).join("");
}

function getVisibleItems() {
  return series.filter((item) => {
    if (state.libraryFilter === "all") return true;
    if (state.libraryFilter === "offline") return item.offline;
    return item.state === state.libraryFilter;
  });
}

function renderLibrary() {
  const visibleItems = getVisibleItems();
  const headingMap = {
    all: "All manga in one compact grid",
    reading: "Current reads stay tight and visible",
    upnext: "Unread queue without extra noise",
    finished: "Completed works remain part of the product",
    offline: "Offline titles ready to open instantly",
  };

  elements.libraryHeading.textContent = headingMap[state.libraryFilter];
  elements.libraryCount.textContent = `${visibleItems.length} titles`;
  elements.libraryGrid.dataset.cardView = state.cardView;
  elements.libraryGrid.innerHTML = visibleItems.map((item) => `
    <button type="button" class="library-card" data-series="${item.id}" data-open-reader="true">
      ${buildCover(item)}
      <div class="library-card-copy">
        <div class="tag-row">
          <span class="status-pill status-${item.state}">${getStateLabel(item)}</span>
          ${item.offline ? '<span class="quiet-pill">Offline</span>' : ""}
        </div>
        <strong>${item.title}</strong>
        <span>${item.chapterShort} / ${item.note}</span>
      </div>
    </button>
  `).join("");
}

function renderReader() {
  const item = getActiveSeries();
  const chapter = getActiveChapter();

  elements.readerSeriesTitle.textContent = item.title;
  elements.stageSeriesLabel.textContent = item.title;
  elements.readerLayout.dataset.readerMode = state.readerMode;
  elements.pageSheet.style.setProperty("--page-accent", item.pageAccent);
  elements.chapterList.innerHTML = item.chapters.map((entry, index) => `
    <button type="button" class="chapter-button ${index === state.activeChapterIndex ? "chapter-button-active" : ""}" data-chapter-index="${index}">
      <strong>${entry.label}</strong>
      <span>${entry.subtitle}</span>
      <small>${entry.current} / ${entry.total}</small>
    </button>
  `).join("");

  state.currentPage = Math.max(1, Math.min(state.currentPage, chapter.total));
  updateProgressUI();
}

function renderDashboard() {
  renderCurrentSeries();
  renderShelf(
    elements.queueShelf,
    series.filter((item) => item.state === "reading" || item.state === "upnext").filter((item) => item.id !== state.activeSeriesId).slice(0, 5),
  );
  renderShelf(elements.finishedShelf, series.filter((item) => item.state === "finished").slice(0, 5), true);
}

function setActiveSeries(id) {
  const item = getSeries(id);
  state.activeSeriesId = item.id;
  state.activeChapterIndex = item.currentChapterIndex ?? 0;
  state.currentPage = item.chapters[state.activeChapterIndex]?.current ?? 1;
  renderDashboard();
  renderLibrary();
  renderReader();
}

function selectChapter(index) {
  const item = getActiveSeries();
  const clamped = Math.max(0, Math.min(item.chapters.length - 1, index));
  state.activeChapterIndex = clamped;
  state.currentPage = item.chapters[clamped].current;
  renderCurrentSeries();
  renderReader();
}

document.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;

  const seriesButton = target.closest("[data-series]");
  if (seriesButton instanceof HTMLElement) {
    setActiveSeries(seriesButton.dataset.series);
    pulse(seriesButton);
    if (seriesButton.dataset.openReader === "true") {
      switchView("reader");
    }
    return;
  }

  const viewButton = target.closest("[data-view]");
  if (viewButton instanceof HTMLElement) {
    switchView(viewButton.dataset.view);
    pulse(viewButton);
    return;
  }

  const filterButton = target.closest("[data-filter]");
  if (filterButton instanceof HTMLElement) {
    state.libraryFilter = filterButton.dataset.filter;
    renderCollections();
    renderLibrary();
    applyActiveStates();
    pulse(filterButton);
    return;
  }

  const densityButton = target.closest("[data-card-view]");
  if (densityButton instanceof HTMLElement) {
    state.cardView = densityButton.dataset.cardView;
    renderLibrary();
    applyActiveStates();
    return;
  }

  const chapterButton = target.closest("[data-chapter-index]");
  if (chapterButton instanceof HTMLElement) {
    selectChapter(Number(chapterButton.dataset.chapterIndex));
    return;
  }

  const modeButton = target.closest("[data-reader-mode]");
  if (modeButton instanceof HTMLElement) {
    state.readerMode = modeButton.dataset.readerMode;
    renderReader();
    applyActiveStates();
    return;
  }

  const stepButton = target.closest("[data-step]");
  if (stepButton instanceof HTMLElement) {
    selectChapter(state.activeChapterIndex + Number(stepButton.dataset.step));
  }
});

elements.progressRange.addEventListener("input", () => {
  state.currentPage = Number(elements.progressRange.value);
  updateProgressUI();
});

elements.brightnessRange.addEventListener("input", () => {
  state.brightness = Number(elements.brightnessRange.value);
  updateBrightness();
});

renderUpdates();
renderCollections();
renderDashboard();
renderLibrary();
renderReader();
updateTopbar();
applyActiveStates();
updateBrightness();
