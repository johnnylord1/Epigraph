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
    cover: "cover-horizon",
    kicker: "Drama",
    state: "reading",
    source: "MangaDex",
    note: "post-war drama",
    chapterShort: "Ch. 12",
    pageTint: "#c7d2dc",
    offline: false,
    chapters: makeChapters(12, ["The Boy and the Girl", "Road of Glass", "Ashes", "Last Light"], [
      { current: 18, total: 26 },
      { current: 1, total: 24 },
      { current: 1, total: 28 },
      { current: 1, total: 21 },
    ]),
    currentChapterIndex: 0,
  },
  {
    id: "witch-hat",
    title: "Witch Hat Atelier",
    coverTitle: "WITCH\nHAT",
    cover: "cover-witch-hat",
    kicker: "Fantasy",
    state: "reading",
    source: "Local",
    note: "high-detail art",
    chapterShort: "Ch. 84",
    pageTint: "#d8c8a2",
    offline: true,
    chapters: makeChapters(84, ["Silver Eve", "At the Atelier", "Ink and Thread", "Bell Tower"], [
      { current: 12, total: 34 },
      { current: 1, total: 31 },
      { current: 1, total: 29 },
      { current: 1, total: 33 },
    ]),
    currentChapterIndex: 0,
  },
  {
    id: "vagabond",
    title: "Vagabond",
    coverTitle: "VAGA\nBOND",
    cover: "cover-vagabond",
    kicker: "Seinen",
    state: "reading",
    source: "Library",
    note: "slow reread",
    chapterShort: "Ch. 33",
    pageTint: "#d0c4b0",
    offline: false,
    chapters: makeChapters(33, ["The Lone Path", "Rain and Dust", "The Shrine", "Silence"], [
      { current: 7, total: 22 },
      { current: 1, total: 20 },
      { current: 1, total: 24 },
      { current: 1, total: 19 },
    ]),
    currentChapterIndex: 0,
  },
  {
    id: "dandadan",
    title: "Dandadan",
    coverTitle: "DANDA\nDAN",
    cover: "cover-dandadan",
    kicker: "Action",
    state: "upnext",
    source: "MANGA Plus",
    note: "2 unread",
    chapterShort: "Ch. 186",
    pageTint: "#f0c4cc",
    offline: false,
    chapters: makeChapters(186, ["Tunnel Noise", "Headlights", "City Run", "Cold Signal"], [
      { current: 1, total: 22 },
      { current: 1, total: 21 },
      { current: 1, total: 19 },
      { current: 1, total: 25 },
    ]),
    currentChapterIndex: 0,
  },
  {
    id: "sakamoto",
    title: "Sakamoto Days",
    coverTitle: "SAKA\nMOTO",
    cover: "cover-sakamoto",
    kicker: "Weekly",
    state: "upnext",
    source: "Shonen Jump",
    note: "1 unread",
    chapterShort: "Ch. 164",
    pageTint: "#d0b899",
    offline: true,
    chapters: makeChapters(164, ["Late Checkout", "Switch Lane", "Paper Target", "Parking Level"], [
      { current: 1, total: 20 },
      { current: 1, total: 18 },
      { current: 1, total: 22 },
      { current: 1, total: 17 },
    ]),
    currentChapterIndex: 0,
  },
  {
    id: "frieren",
    title: "Frieren",
    coverTitle: "FRIE\nREN",
    cover: "cover-frieren",
    kicker: "Fantasy",
    state: "upnext",
    source: "MangaDex",
    note: "new chapter",
    chapterShort: "Ch. 138",
    pageTint: "#cfd6e3",
    offline: false,
    chapters: makeChapters(138, ["Quiet Spell", "Old Road", "Snow Field", "Golden Ash"], [
      { current: 1, total: 24 },
      { current: 1, total: 23 },
      { current: 1, total: 21 },
      { current: 1, total: 26 },
    ]),
    currentChapterIndex: 0,
  },
  {
    id: "girls-last-tour",
    title: "Girls' Last Tour",
    coverTitle: "LAST\nTOUR",
    cover: "cover-last-tour",
    kicker: "Finished",
    state: "finished",
    source: "Library",
    note: "completed 6 vols",
    chapterShort: "Vol. 6",
    pageTint: "#d6d1ca",
    offline: true,
    chapters: makeChapters(40, ["Rain Shelf", "Stone Town", "Signal", "Final Station"], [
      { current: 12, total: 12 },
      { current: 15, total: 15 },
      { current: 14, total: 14 },
      { current: 18, total: 18 },
    ]),
    currentChapterIndex: 3,
  },
  {
    id: "goodbye-eri",
    title: "Goodbye, Eri",
    coverTitle: "GOOD\nBYE ERI",
    cover: "cover-eri",
    kicker: "Finished",
    state: "finished",
    source: "Local",
    note: "one-shot",
    chapterShort: "One-shot",
    pageTint: "#d7c0bb",
    offline: true,
    chapters: makeChapters(1, ["Opening Cut", "Streetlight", "Projection", "Final Roll"], [
      { current: 54, total: 54 },
      { current: 48, total: 48 },
      { current: 50, total: 50 },
      { current: 46, total: 46 },
    ]),
    currentChapterIndex: 3,
  },
  {
    id: "solanin",
    title: "Solanin",
    coverTitle: "SOLA\nNIN",
    cover: "cover-solanin",
    kicker: "Finished",
    state: "finished",
    source: "Library",
    note: "completed reread",
    chapterShort: "Vol. 2",
    pageTint: "#d7cbb8",
    offline: false,
    chapters: makeChapters(18, ["Late Train", "Band Practice", "Glow", "Two Years Later"], [
      { current: 22, total: 22 },
      { current: 24, total: 24 },
      { current: 21, total: 21 },
      { current: 19, total: 19 },
    ]),
    currentChapterIndex: 3,
  },
  {
    id: "pluto",
    title: "Pluto",
    coverTitle: "PLU\nTO",
    cover: "cover-pluto",
    kicker: "Finished",
    state: "finished",
    source: "Library",
    note: "completed 8 vols",
    chapterShort: "Vol. 8",
    pageTint: "#c7cbd6",
    offline: false,
    chapters: makeChapters(60, ["Investigator", "North 2", "The Child", "Last Sky"], [
      { current: 18, total: 18 },
      { current: 21, total: 21 },
      { current: 17, total: 17 },
      { current: 23, total: 23 },
    ]),
    currentChapterIndex: 3,
  },
  {
    id: "blame",
    title: "BLAME!",
    coverTitle: "BLAME!",
    cover: "cover-blame",
    kicker: "Finished",
    state: "finished",
    source: "Offline",
    note: "downloaded",
    chapterShort: "Vol. 10",
    pageTint: "#c5ccd2",
    offline: true,
    chapters: makeChapters(55, ["Megastructure", "Relay", "Dormant City", "Edge Sector"], [
      { current: 17, total: 17 },
      { current: 19, total: 19 },
      { current: 18, total: 18 },
      { current: 16, total: 16 },
    ]),
    currentChapterIndex: 3,
  },
];

const updates = [
  { tone: "", title: "3 new chapters", meta: "Dandadan, Frieren, Sakamoto Days" },
  { tone: "amber", title: "Offline ready", meta: "Witch Hat Atelier and BLAME!" },
  { tone: "blue", title: "Tracking synced", meta: "9 works updated" },
];

const state = {
  activeView: "dashboard",
  activeSeriesId: "horizon",
  activeChapterIndex: 0,
  libraryFilter: "all",
  cardView: "covers",
  readerMode: "paged",
  currentPage: 18,
  brightness: 82,
};

const elements = {
  views: Array.from(document.querySelectorAll(".view")),
  railButtons: Array.from(document.querySelectorAll(".rail-button")),
  categoryButtons: Array.from(document.querySelectorAll(".category-button")),
  segmentButtons: Array.from(document.querySelectorAll(".segment-button[data-card-view]")),
  readerModeButtons: Array.from(document.querySelectorAll(".segment-button[data-reader-mode]")),
  currentPanel: document.getElementById("current-panel"),
  updatesList: document.getElementById("updates-list"),
  queueShelf: document.getElementById("queue-shelf"),
  finishedShelf: document.getElementById("finished-shelf"),
  libraryTitle: document.getElementById("library-title"),
  libraryCount: document.getElementById("library-count"),
  libraryGrid: document.getElementById("library-grid"),
  readerLayout: document.getElementById("reader-layout"),
  chapterList: document.getElementById("chapter-list"),
  readerSeriesTitle: document.getElementById("reader-series-title"),
  readerSeriesMeta: document.getElementById("reader-series-meta"),
  stageSeriesLabel: document.getElementById("stage-series-label"),
  stagePageLabel: document.getElementById("stage-page-label"),
  pageSheet: document.getElementById("page-sheet"),
  brightnessRange: document.getElementById("brightness-range"),
  brightnessValue: document.getElementById("brightness-value"),
  progressRange: document.getElementById("progress-range"),
  progressValue: document.getElementById("progress-value"),
  footerPageLabel: document.getElementById("footer-page-label"),
  footerProgressFill: document.getElementById("footer-progress-fill"),
};

function getSeries(id = state.activeSeriesId) {
  return series.find((item) => item.id === id) ?? series[0];
}

function getActiveChapter() {
  const item = getSeries();
  return item.chapters[state.activeChapterIndex] ?? item.chapters[0];
}

function statusLabel(item) {
  if (item.state === "reading") return "Reading";
  if (item.state === "upnext") return "Updated";
  return "Finished";
}

function cover(item) {
  return `
    <div class="cover-art ${item.cover}">
      <span class="cover-kicker">${item.kicker}</span>
      <strong class="cover-title">${item.coverTitle}</strong>
      <span class="cover-meta">${item.chapterShort}</span>
    </div>
  `;
}

function pulse(element) {
  if (!element) return;
  element.classList.remove("pulse");
  requestAnimationFrame(() => {
    element.classList.add("pulse");
    window.setTimeout(() => element.classList.remove("pulse"), 180);
  });
}

function setView(view) {
  state.activeView = view;
  elements.views.forEach((panel) => {
    const active = panel.dataset.viewPanel === view;
    panel.hidden = !active;
    panel.classList.toggle("view-active", active);
  });
  elements.railButtons.forEach((button) => {
    button.classList.toggle("rail-button-active", button.dataset.view === view);
  });
}

function activeFilterItems() {
  return series.filter((item) => {
    if (state.libraryFilter === "all") return true;
    if (state.libraryFilter === "offline") return item.offline;
    return item.state === state.libraryFilter;
  });
}

function updateProgress() {
  const chapter = getActiveChapter();
  state.currentPage = Math.max(1, Math.min(state.currentPage, chapter.total));
  const percent = (state.currentPage / chapter.total) * 100;
  const pageLabel = `Page ${state.currentPage} / ${chapter.total}`;
  const progressLabel = `${state.currentPage} / ${chapter.total}`;

  elements.readerSeriesMeta.textContent = `${chapter.label} - ${pageLabel}`;
  elements.stagePageLabel.textContent = pageLabel;
  elements.progressValue.textContent = progressLabel;
  elements.footerPageLabel.textContent = pageLabel;
  elements.footerProgressFill.style.width = `${percent}%`;
  elements.progressRange.max = String(chapter.total);
  elements.progressRange.value = String(state.currentPage);
}

function renderCurrent() {
  const item = getSeries();
  const chapter = getActiveChapter();
  const percent = Math.round((state.currentPage / chapter.total) * 100);

  elements.currentPanel.innerHTML = `
    <div class="current-grid">
      ${cover(item)}
      <div class="current-copy">
        <p class="current-meta">${item.source} / ${chapter.label}</p>
        <div class="current-title-row">
          <h2>${item.title}</h2>
          <span class="count-pill">${percent}%</span>
        </div>
        <p class="current-meta">${chapter.subtitle} / page ${state.currentPage} of ${chapter.total}</p>
        <div class="progress-track"><span style="width:${percent}%"></span></div>
        <div class="current-actions">
          <button type="button" class="current-action current-action-primary" data-view="reader">Resume</button>
          <button type="button" class="current-action" data-view="library">Library</button>
        </div>
        <div class="chapter-pills">
          ${item.chapters.map((entry, index) => `
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
  elements.updatesList.innerHTML = updates.map((item) => `
    <article class="update-item">
      <span class="update-dot ${item.tone}"></span>
      <div>
        <strong>${item.title}</strong>
        <span>${item.meta}</span>
      </div>
    </article>
  `).join("");
}

function renderShelf(element, items) {
  element.innerHTML = items.map((item) => `
    <button type="button" class="shelf-card" data-series="${item.id}" data-open-reader="true">
      ${cover(item)}
      <strong>${item.title}</strong>
      <span>${item.note}</span>
    </button>
  `).join("");
}

function renderDashboard() {
  renderCurrent();
  renderShelf(
    elements.queueShelf,
    series.filter((item) => item.state !== "finished" && item.id !== state.activeSeriesId).slice(0, 5),
  );
  renderShelf(elements.finishedShelf, series.filter((item) => item.state === "finished").slice(0, 5));
}

function renderLibrary() {
  const items = activeFilterItems();
  const titleMap = {
    all: "All titles",
    reading: "Reading",
    upnext: "Updates",
    finished: "Finished",
    offline: "Offline",
  };

  elements.libraryTitle.textContent = titleMap[state.libraryFilter];
  elements.libraryCount.textContent = `${items.length} titles`;
  elements.libraryGrid.dataset.cardView = state.cardView;
  elements.libraryGrid.innerHTML = items.map((item) => `
    <button type="button" class="library-card" data-series="${item.id}" data-open-reader="true">
      ${cover(item)}
      <div class="library-card-copy">
        <div class="status-row">
          <span class="status-badge status-badge-${item.state}">${statusLabel(item)}</span>
          ${item.offline ? '<span class="status-badge status-badge-offline">Offline</span>' : ""}
        </div>
        <strong>${item.title}</strong>
        <span>${item.chapterShort} / ${item.note}</span>
      </div>
    </button>
  `).join("");

  elements.categoryButtons.forEach((button) => {
    button.classList.toggle("category-button-active", button.dataset.filter === state.libraryFilter);
  });
  elements.segmentButtons.forEach((button) => {
    button.classList.toggle("segment-button-active", button.dataset.cardView === state.cardView);
  });
}

function renderReader() {
  const item = getSeries();

  elements.readerSeriesTitle.textContent = item.title;
  elements.stageSeriesLabel.textContent = item.title;
  elements.readerLayout.dataset.readerMode = state.readerMode;
  elements.pageSheet.style.setProperty("--page-tint", item.pageTint);
  elements.pageSheet.style.setProperty("--page-brightness", String(state.brightness / 100));
  elements.brightnessValue.textContent = `${state.brightness}%`;
  elements.chapterList.innerHTML = item.chapters.map((entry, index) => `
    <button type="button" class="chapter-button ${index === state.activeChapterIndex ? "chapter-button-active" : ""}" data-chapter-index="${index}">
      <strong>${entry.label}</strong>
      <span>${entry.subtitle}</span>
      <small>${entry.current} / ${entry.total}</small>
    </button>
  `).join("");
  elements.readerModeButtons.forEach((button) => {
    button.classList.toggle("segment-button-active", button.dataset.readerMode === state.readerMode);
  });
  updateProgress();
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

function setChapter(index) {
  const item = getSeries();
  const clampedIndex = Math.max(0, Math.min(item.chapters.length - 1, index));
  state.activeChapterIndex = clampedIndex;
  state.currentPage = item.chapters[clampedIndex].current;
  renderDashboard();
  renderReader();
}

document.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;

  const seriesButton = target.closest("[data-series]");
  if (seriesButton instanceof HTMLElement) {
    setActiveSeries(seriesButton.dataset.series);
    pulse(seriesButton);
    if (seriesButton.dataset.openReader === "true") setView("reader");
    return;
  }

  const viewButton = target.closest("[data-view]");
  if (viewButton instanceof HTMLElement) {
    setView(viewButton.dataset.view);
    pulse(viewButton);
    return;
  }

  const filterButton = target.closest("[data-filter]");
  if (filterButton instanceof HTMLElement) {
    state.libraryFilter = filterButton.dataset.filter;
    renderLibrary();
    return;
  }

  const cardViewButton = target.closest("[data-card-view]");
  if (cardViewButton instanceof HTMLElement) {
    state.cardView = cardViewButton.dataset.cardView;
    renderLibrary();
    return;
  }

  const readerModeButton = target.closest("[data-reader-mode]");
  if (readerModeButton instanceof HTMLElement) {
    state.readerMode = readerModeButton.dataset.readerMode;
    renderReader();
    return;
  }

  const chapterButton = target.closest("[data-chapter-index]");
  if (chapterButton instanceof HTMLElement) {
    setChapter(Number(chapterButton.dataset.chapterIndex));
    return;
  }

  const stepButton = target.closest("[data-step]");
  if (stepButton instanceof HTMLElement) {
    setChapter(state.activeChapterIndex + Number(stepButton.dataset.step));
  }
});

elements.brightnessRange.addEventListener("input", () => {
  state.brightness = Number(elements.brightnessRange.value);
  elements.brightnessValue.textContent = `${state.brightness}%`;
  elements.pageSheet.style.setProperty("--page-brightness", String(state.brightness / 100));
});

elements.progressRange.addEventListener("input", () => {
  state.currentPage = Number(elements.progressRange.value);
  updateProgress();
});

renderUpdates();
renderDashboard();
renderLibrary();
renderReader();
