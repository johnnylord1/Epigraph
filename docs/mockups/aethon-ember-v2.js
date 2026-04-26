const titles = {
  home: ["Home", "Reading room"],
  library: ["Library", "Shelves"],
  browse: ["Browse", "Sources"],
  downloads: ["Downloads", "Queue"],
  settings: ["Settings", "Preferences"],
  series: ["Library / Series", "Houseki no Kuni"],
  book: ["Library / Book", "Spice & Wolf"],
  reader: ["Reader", "Chapter 108"],
};

const title = document.querySelector("#title");
const crumb = document.querySelector("#crumb");
const screens = [...document.querySelectorAll("[data-screen]")];
const navButtons = [...document.querySelectorAll(".nav-btn[data-view]")];
const cards = document.querySelector("#cards");
const rangeBox = document.querySelector("#range-box");
const chapterList = document.querySelector("#chapter-list");
const readerShell = document.querySelector("#reader-shell");
const stage = document.querySelector("#stage");
const splash = document.querySelector("#splash");
const splashText = document.querySelector("#splash-text");
const selectedTags = new Set(["Seinen"]);

function openView(view) {
  const next = titles[view] ? view : "home";
  screens.forEach((screen) => screen.classList.toggle("active", screen.dataset.screen === next));
  navButtons.forEach((button) => button.classList.toggle("active", button.dataset.view === next));
  crumb.textContent = titles[next][0];
  title.textContent = titles[next][1];
}

function ripple(button, event) {
  const dot = document.createElement("span");
  const rect = button.getBoundingClientRect();
  dot.className = "ripple";
  dot.style.left = `${event.clientX - rect.left}px`;
  dot.style.top = `${event.clientY - rect.top}px`;
  button.append(dot);
  setTimeout(() => dot.remove(), 430);
}

function activateInContainer(button) {
  const parent = button.closest(".segmented, .chips, .side");
  if (!parent) return;
  [...parent.querySelectorAll(":scope > button")].forEach((item) => {
    item.classList.toggle("active", item === button);
  });
}

function showBrowse(name) {
  document.querySelectorAll("[data-pane]").forEach((pane) => {
    pane.classList.toggle("active", pane.dataset.pane === name);
  });
}

function renderTags() {
  const box = document.querySelector("#selected-tags");
  if (!box) return;
  box.innerHTML = "";
  for (const tag of selectedTags) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.removeTag = tag;
    button.textContent = `${tag} x`;
    box.append(button);
  }
  document.querySelectorAll("[data-tag]").forEach((button) => {
    button.classList.toggle("active", selectedTags.has(button.dataset.tag));
  });
}

function showSplash(mode) {
  const labels = {
    loading: "Initializing reader",
    idle: "Click or press any key to continue",
    pin: "Enter app lock PIN",
    error: "Could not reach server",
  };
  splash.dataset.mode = mode;
  splashText.textContent = labels[mode] || labels.loading;
  splash.classList.add("visible");
}

document.addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (button) ripple(button, event);

  const viewButton = event.target.closest("[data-view]");
  if (viewButton?.dataset.view) openView(viewButton.dataset.view);

  const selectable = event.target.closest(".selectable");
  if (selectable && (event.ctrlKey || event.metaKey || event.shiftKey)) {
    event.preventDefault();
    event.stopPropagation();
    selectable.classList.toggle("selected");
    return;
  }

  if (event.target.closest("[data-open-series]")) openView("series");
  if (event.target.closest("[data-open-book]")) openView("book");
  if (event.target.closest("[data-open-reader]")) openView("reader");

  const splashButton = event.target.closest("[data-splash]");
  if (splashButton) showSplash(splashButton.dataset.splash);
  if (event.target.closest("#close-splash")) splash.classList.remove("visible");

  const segmentedButton = event.target.closest(".segmented button, .chips button");
  if (segmentedButton) activateInContainer(segmentedButton);

  const folderButton = event.target.closest(".side > .folder");
  if (folderButton) activateInContainer(folderButton);

  const layout = event.target.closest("[data-layout]");
  if (layout) {
    cards.classList.toggle("is-compact", layout.dataset.layout === "compact");
    cards.classList.toggle("is-list", layout.dataset.layout === "list");
  }

  const browseButton = event.target.closest("[data-browse]");
  if (browseButton) showBrowse(browseButton.dataset.browse);

  const tagButton = event.target.closest("[data-tag]");
  if (tagButton) {
    const tag = tagButton.dataset.tag;
    selectedTags.has(tag) ? selectedTags.delete(tag) : selectedTags.add(tag);
    renderTags();
  }

  const removeTag = event.target.closest("[data-remove-tag]");
  if (removeTag) {
    selectedTags.delete(removeTag.dataset.removeTag);
    renderTags();
  }

  const tagMode = event.target.closest("#tag-mode");
  if (tagMode) tagMode.textContent = tagMode.textContent.includes("AND") ? "Mode: OR" : "Mode: AND";

  const libraryToggle = event.target.closest("#library-toggle");
  if (libraryToggle) {
    const added = libraryToggle.textContent.trim() !== "Added";
    libraryToggle.textContent = added ? "Added" : "In library";
    libraryToggle.classList.toggle("primary", added);
    libraryToggle.classList.toggle("soft", !added);
  }

  const scanlator = event.target.closest("#scanlator");
  if (scanlator) {
    const values = ["Scanlator: Any", "Scanlator: Hex", "Scanlator: Official"];
    scanlator.textContent = values[(values.indexOf(scanlator.textContent) + 1) % values.length];
  }

  const sort = event.target.closest("#sort-dir");
  if (sort) sort.textContent = sort.textContent.includes("desc") ? "Sort: Source asc" : "Sort: Source desc";

  if (event.target.closest("#range-toggle")) rangeBox.classList.toggle("open");

  const chapterLayout = event.target.closest("[data-chapter-layout]");
  if (chapterLayout) chapterList.classList.toggle("grid", chapterLayout.dataset.chapterLayout === "grid");

  const readerMode = event.target.closest("[data-reader-mode]");
  if (readerMode) {
    readerShell.classList.toggle("vertical", readerMode.dataset.readerMode === "vertical");
    readerShell.classList.toggle("double", readerMode.dataset.readerMode === "double");
    readerShell.classList.toggle("focus", readerMode.dataset.readerMode === "focus");
  }

  if (event.target.closest("#warmth")) stage.classList.toggle("warm");

  const pause = event.target.closest("#pause-downloads");
  if (pause) pause.textContent = pause.textContent === "Pause" ? "Resume" : "Pause";
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && splash.classList.contains("visible")) {
    splash.classList.remove("visible");
  }
});

renderTags();
setTimeout(() => splash.classList.remove("visible"), 900);
