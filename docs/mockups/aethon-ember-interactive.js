const titles = {
  home: ["Home", "Aethon"],
  library: ["Library", "Your shelves"],
  browse: ["Browse", "Search sources"],
  downloads: ["Downloads", "Queue"],
  settings: ["Settings", "Preferences"],
  detail: ["Library / Series", "Houseki no Kuni"],
  reader: ["Reader / Chapter 108", "Reading"],
};

const panels = [...document.querySelectorAll("[data-panel]")];
const navButtons = [...document.querySelectorAll("[data-view]")];
const railButtons = [...document.querySelectorAll(".rail-btn")];
const title = document.querySelector("#view-title");
const crumb = document.querySelector("#crumb");
const grid = document.querySelector("#library-grid");
const reader = document.querySelector('[data-panel="reader"]');
const pageStage = document.querySelector("#page-stage");

function openView(view) {
  panels.forEach((panel) => panel.classList.toggle("is-visible", panel.dataset.panel === view));
  railButtons.forEach((button) => button.classList.toggle("is-active", button.dataset.view === view));
  const [nextCrumb, nextTitle] = titles[view] ?? titles.home;
  crumb.textContent = nextCrumb;
  title.textContent = nextTitle;
}

function pulse(button, event) {
  const ripple = document.createElement("span");
  const rect = button.getBoundingClientRect();
  ripple.className = "ripple";
  ripple.style.left = `${event.clientX - rect.left}px`;
  ripple.style.top = `${event.clientY - rect.top}px`;
  button.append(ripple);
  setTimeout(() => ripple.remove(), 420);
}

document.addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (button) pulse(button, event);

  const viewButton = event.target.closest("[data-view]");
  if (viewButton?.dataset.view) openView(viewButton.dataset.view);

  if (event.target.closest("[data-open-detail]")) openView("detail");
  if (event.target.closest("[data-open-reader]")) openView("reader");

  const layoutButton = event.target.closest("[data-layout]");
  if (layoutButton) {
    document.querySelectorAll("[data-layout]").forEach((item) => item.classList.toggle("is-active", item === layoutButton));
    grid.classList.toggle("is-compact", layoutButton.dataset.layout === "compact");
    grid.classList.toggle("is-list", layoutButton.dataset.layout === "list");
  }

  const readerMode = event.target.closest("[data-reader-mode]");
  if (readerMode) {
    document.querySelectorAll("[data-reader-mode]").forEach((item) => item.classList.toggle("is-active", item === readerMode));
    reader.classList.toggle("is-vertical", readerMode.dataset.readerMode === "vertical");
    reader.classList.toggle("is-focus", readerMode.dataset.readerMode === "focus");
  }
});

document.querySelector("#brightness")?.addEventListener("click", () => {
  pageStage.classList.toggle("is-warm");
});

document.querySelector("#global-search")?.addEventListener("keydown", (event) => {
  if (event.key === "Enter") openView("browse");
});

const style = document.createElement("style");
style.textContent = `
  button { position: relative; overflow: hidden; }
  .ripple {
    position: absolute;
    width: 8px;
    height: 8px;
    border-radius: 999px;
    background: rgba(231, 182, 107, 0.34);
    pointer-events: none;
    transform: translate(-50%, -50%) scale(1);
    animation: ripple 420ms ease-out forwards;
  }
  @keyframes ripple {
    to { opacity: 0; transform: translate(-50%, -50%) scale(18); }
  }
`;
document.head.append(style);
