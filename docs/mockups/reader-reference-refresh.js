const state = {
  activeDomain: "comics",
  activeFilter: "all",
  activeReaderIndex: 0,
};

const queueButtons = Array.from(document.querySelectorAll(".queue-item"));
const heroTitle = document.getElementById("hero-title");
const heroSubcopy = document.getElementById("hero-subcopy");
const heroChipState = document.getElementById("hero-chip-state");
const heroChipGenre = document.getElementById("hero-chip-genre");
const heroCover = document.getElementById("hero-cover");
const jumpButtons = Array.from(document.querySelectorAll("[data-jump]"));
const prototypeNavButtons = Array.from(document.querySelectorAll(".prototype-nav-btn"));
const railNavButtons = Array.from(document.querySelectorAll(".rail-item[data-jump]"));
const collectionButtons = Array.from(document.querySelectorAll(".collection-chip"));
const filterButtons = Array.from(document.querySelectorAll(".filter-chip"));
const folderButtons = Array.from(document.querySelectorAll(".folder-item"));
const cardGrid = document.getElementById("library-card-grid");
const comicCards = Array.from(document.querySelectorAll(".comic-card"));
const viewButtons = Array.from(document.querySelectorAll(".mode-option"));
const readerModes = Array.from(document.querySelectorAll(".reader-mode"));
const readerBody = document.getElementById("reader-body");
const readerTitle = document.querySelector(".reader-title strong");
const readerSubtitle = document.querySelector(".reader-title small");
const readerChapterButtons = Array.from(document.querySelectorAll(".reader-chapter"));
const progressInput = document.getElementById("progress-input");
const brightnessInput = document.getElementById("brightness-input");
const progressValue = document.getElementById("progress-value");
const brightnessValue = document.getElementById("brightness-value");
const progressFill = document.getElementById("progress-fill");
const brightnessFill = document.getElementById("brightness-fill");
const bottomPageLabel = document.getElementById("bottom-page-label");
const bottomProgressFill = document.getElementById("bottom-progress-fill");
const pageStage = document.querySelector(".page-stage");
const resumeButton = document.getElementById("resume-reading-btn");
const prevButton = document.getElementById("reader-prev-btn");
const nextButton = document.getElementById("reader-next-btn");

function setActive(buttons, activeButton, activeClass) {
  buttons.forEach((button) => button.classList.toggle(activeClass, button === activeButton));
}

function animatePulse(element) {
  if (!element) return;
  element.animate(
    [
      { transform: "scale(1)", boxShadow: "0 0 0 rgba(199, 228, 125, 0)" },
      { transform: "scale(1.015)", boxShadow: "0 0 0 10px rgba(199, 228, 125, 0.08)" },
      { transform: "scale(1)", boxShadow: "0 0 0 rgba(199, 228, 125, 0)" },
    ],
    { duration: 360, easing: "ease-out" },
  );
}

function jumpTo(targetId) {
  const target = document.getElementById(targetId);
  if (!target) return;
  target.scrollIntoView({ behavior: "smooth", block: "start" });
  prototypeNavButtons.forEach((button) => {
    button.classList.toggle("prototype-nav-btn-active", button.dataset.jump === targetId);
  });
  railNavButtons.forEach((button) => {
    button.classList.toggle("rail-item-active", button.dataset.jump === targetId);
  });
}

function updateHeroFromQueue(button) {
  if (!button) return;
  setActive(queueButtons, button, "queue-item-active");
  heroTitle.textContent = button.dataset.series ?? "The Horizon";
  heroSubcopy.textContent = button.dataset.subcopy ?? "";
  heroChipState.textContent = button.dataset.state ?? "Reading";
  heroChipGenre.textContent = button.dataset.genre ?? "Drama";
  heroChipState.classList.toggle("chip-active", button.dataset.state === "Reading");
  heroCover.className = `feature-cover large ${button.dataset.cover ?? "cover-horizon"}`;
  animatePulse(document.querySelector(".current-title"));

  const readerMatchIndex = readerChapterButtons.findIndex((chapter) =>
    chapter.dataset.readerChapterLabel === button.dataset.readerChapter,
  );
  if (readerMatchIndex >= 0) {
    updateReaderChapter(readerMatchIndex);
  }
}

function cardMatches(card) {
  const tags = (card.dataset.tags ?? "").split(/\s+/);
  const domainMatch = state.activeDomain === "comics"
    ? tags.includes("comics")
    : state.activeDomain === "books"
      ? tags.includes("books")
      : tags.includes("downloaded");
  const filterMatch = state.activeFilter === "all" || tags.includes(state.activeFilter);
  return domainMatch && filterMatch;
}

function applyLibraryFilters() {
  comicCards.forEach((card) => {
    const visible = cardMatches(card);
    card.hidden = !visible;
    if (visible) {
      card.animate(
        [
          { opacity: 0.72, transform: "translateY(8px) scale(0.985)" },
          { opacity: 1, transform: "translateY(0) scale(1)" },
        ],
        { duration: 220, easing: "ease-out" },
      );
    }
  });
}

function updateReaderProgress(currentValue, totalValue) {
  const percent = Math.max(0, Math.min(1, currentValue / totalValue));
  progressValue.textContent = `${currentValue} / ${totalValue}`;
  bottomPageLabel.textContent = `Page ${currentValue} / ${totalValue}`;
  progressInput.max = String(totalValue);
  progressInput.value = String(currentValue);
  progressFill.style.width = `${percent * 100}%`;
  bottomProgressFill.style.width = `${percent * 100}%`;
}

function updateReaderChapter(index) {
  state.activeReaderIndex = Math.max(0, Math.min(readerChapterButtons.length - 1, index));
  const button = readerChapterButtons[state.activeReaderIndex];
  setActive(readerChapterButtons, button, "reader-chapter-active");
  readerTitle.textContent = "The Horizon";
  readerSubtitle.textContent = button.dataset.readerChapterLabel ?? "";

  const [currentRaw, totalRaw] = (button.dataset.readerProgress ?? "18 / 26").split("/").map((part) => Number(part.trim()));
  const current = Number.isFinite(currentRaw) ? currentRaw : 18;
  const total = Number.isFinite(totalRaw) ? totalRaw : 26;
  updateReaderProgress(current, total);
  animatePulse(document.querySelector(".comic-page"));
}

function updateBrightness(value) {
  brightnessValue.textContent = `${value}%`;
  brightnessFill.style.width = `${value}%`;
  const brightnessScale = Math.max(0.55, value / 100);
  pageStage.style.filter = `brightness(${brightnessScale})`;
}

jumpButtons.forEach((button) => {
  button.addEventListener("click", () => jumpTo(button.dataset.jump));
});

queueButtons.forEach((button) => {
  button.addEventListener("click", () => updateHeroFromQueue(button));
});

collectionButtons.forEach((button) => {
  button.addEventListener("click", () => {
    state.activeDomain = button.dataset.domain ?? "comics";
    setActive(collectionButtons, button, "chip-active");
    applyLibraryFilters();
  });
});

filterButtons.forEach((button) => {
  button.addEventListener("click", () => {
    state.activeFilter = button.dataset.filter ?? "all";
    setActive(filterButtons, button, "chip-active");
    folderButtons.forEach((folder) => folder.classList.toggle("folder-item-active", folder.dataset.filter === state.activeFilter));
    applyLibraryFilters();
  });
});

folderButtons.forEach((button) => {
  button.addEventListener("click", () => {
    state.activeFilter = button.dataset.filter ?? "all";
    setActive(folderButtons, button, "folder-item-active");
    filterButtons.forEach((filterButton) => {
      filterButton.classList.toggle("chip-active", filterButton.dataset.filter === state.activeFilter);
    });
    applyLibraryFilters();
  });
});

viewButtons.forEach((button) => {
  button.addEventListener("click", () => {
    cardGrid.dataset.view = button.dataset.view ?? "grid";
    setActive(viewButtons, button, "mode-active");
    cardGrid.animate(
      [
        { opacity: 0.88, transform: "translateY(8px)" },
        { opacity: 1, transform: "translateY(0)" },
      ],
      { duration: 220, easing: "ease-out" },
    );
  });
});

readerModes.forEach((button) => {
  button.addEventListener("click", () => {
    const mode = button.dataset.readerMode ?? "fit";
    readerBody.dataset.readerLayout = mode;
    setActive(readerModes, button, "chip-active");
    animatePulse(pageStage);
  });
});

readerChapterButtons.forEach((button, index) => {
  button.addEventListener("click", () => updateReaderChapter(index));
});

progressInput?.addEventListener("input", () => {
  updateReaderProgress(Number(progressInput.value), Number(progressInput.max));
});

brightnessInput?.addEventListener("input", () => {
  updateBrightness(Number(brightnessInput.value));
});

resumeButton?.addEventListener("click", () => {
  jumpTo("reader-screen");
  animatePulse(resumeButton);
});

prevButton?.addEventListener("click", () => {
  updateReaderChapter(state.activeReaderIndex - 1);
});

nextButton?.addEventListener("click", () => {
  updateReaderChapter(state.activeReaderIndex + 1);
});

const screenObserver = new IntersectionObserver(
  (entries) => {
    const visibleEntry = entries
      .filter((entry) => entry.isIntersecting)
      .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
    if (!visibleEntry) return;
    const targetId = visibleEntry.target.id;
    prototypeNavButtons.forEach((button) => {
      button.classList.toggle("prototype-nav-btn-active", button.dataset.jump === targetId);
    });
    railNavButtons.forEach((button) => {
      button.classList.toggle("rail-item-active", button.dataset.jump === targetId);
    });
  },
  { threshold: [0.35, 0.6, 0.8] },
);

document.querySelectorAll(".screen").forEach((screen) => screenObserver.observe(screen));

updateHeroFromQueue(queueButtons[0]);
applyLibraryFilters();
updateReaderChapter(0);
updateBrightness(Number(brightnessInput?.value ?? 72));
