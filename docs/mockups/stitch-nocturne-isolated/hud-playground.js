const state = {
  section: "comics",
  openRole: "none",
  buttonSize: 30,
  iconSize: 18,
  clusterGap: 10,
  dividerGap: 6,
  dividerOpacity: 0.12,
  glow: 0.55,
  popoverWidth: 292,
  popoverRadius: 24,
  popoverBlur: 18,
  popoverOpacity: 0.9,
  panelDensity: 0.94,
  icons: {
    density: "density-bars",
    sort: "sort-desc",
    filter: "filter-funnel",
    layout: "layout-grid",
  },
  density: "auto",
  sortMode: "az",
  sortDir: "asc",
  filterValue: "all",
  layout: "grid",
  showProgress: true,
  showOutline: true,
};

const iconOptions = {
  density: [
    ["density-bars", "Bars"],
    ["density-columns", "Columns"],
    ["density-stagger", "Stagger"],
  ],
  sort: [
    ["sort-desc", "Descending"],
    ["sort-alpha", "A-Z"],
    ["sort-clock", "Recent"],
  ],
  filter: [
    ["filter-funnel", "Funnel"],
    ["filter-sliders", "Sliders"],
    ["filter-narrow", "Narrow"],
  ],
  layout: [
    ["layout-grid", "Grid"],
    ["layout-compact", "Compact"],
    ["layout-list", "List"],
  ],
};

const options = {
  comics: {
    sort: [
      ["az", "A-Z"],
      ["unread", "Unread chapters"],
      ["total", "Total chapters"],
      ["added", "Recently added"],
      ["read", "Recently read"],
      ["fetched", "Latest fetched chapter"],
      ["uploaded", "Latest uploaded chapter"],
    ],
    filter: [
      ["all", "All statuses"],
      ["ongoing", "Ongoing"],
      ["completed", "Completed"],
      ["cancelled", "Cancelled"],
      ["hiatus", "Hiatus"],
      ["unknown", "Unknown"],
    ],
  },
  books: {
    sort: [
      ["az", "A-Z"],
      ["author", "Author"],
      ["added", "Recently added"],
      ["read", "Recently read"],
      ["contents", "Book contents"],
    ],
    filter: [
      ["all_books", "All books"],
      ["unopened", "Unopened"],
      ["progress", "In progress"],
      ["finished", "Finished"],
    ],
  },
};

const refs = {
  cluster: document.getElementById("toolbarCluster"),
  popover: document.getElementById("toolbarPopover"),
  tokenPreview: document.getElementById("tokenPreview"),
  previewSegmented: document.getElementById("previewSegmented"),
  sectionSelect: document.getElementById("sectionSelect"),
  openRoleSelect: document.getElementById("openRoleSelect"),
  resetButton: document.getElementById("resetButton"),
  root: document.documentElement,
};

const controls = {
  buttonSizeRange: document.getElementById("buttonSizeRange"),
  iconSizeRange: document.getElementById("iconSizeRange"),
  clusterGapRange: document.getElementById("clusterGapRange"),
  dividerGapRange: document.getElementById("dividerGapRange"),
  dividerOpacityRange: document.getElementById("dividerOpacityRange"),
  glowRange: document.getElementById("glowRange"),
  popoverWidthRange: document.getElementById("popoverWidthRange"),
  popoverRadiusRange: document.getElementById("popoverRadiusRange"),
  popoverBlurRange: document.getElementById("popoverBlurRange"),
  popoverOpacityRange: document.getElementById("popoverOpacityRange"),
  panelDensityRange: document.getElementById("panelDensityRange"),
  iconDensitySelect: document.getElementById("iconDensitySelect"),
  iconSortSelect: document.getElementById("iconSortSelect"),
  iconFilterSelect: document.getElementById("iconFilterSelect"),
  iconLayoutSelect: document.getElementById("iconLayoutSelect"),
};

function iconSvg(id) {
  const common = 'fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"';
  switch (id) {
    case "density-bars":
      return `
        <svg class="icon icon--density" viewBox="0 0 24 24" aria-hidden="true">
          <line class="bar-1" x1="5" y1="18" x2="5" y2="11" ${common}></line>
          <line class="bar-2" x1="12" y1="18" x2="12" y2="6" ${common}></line>
          <line class="bar-3" x1="19" y1="18" x2="19" y2="13" ${common}></line>
        </svg>`;
    case "density-columns":
      return `
        <svg class="icon icon--density" viewBox="0 0 24 24" aria-hidden="true">
          <rect class="bar-1" x="4" y="8" width="3" height="10" rx="1.5" fill="currentColor"></rect>
          <rect class="bar-2" x="10.5" y="5" width="3" height="13" rx="1.5" fill="currentColor"></rect>
          <rect class="bar-3" x="17" y="10" width="3" height="8" rx="1.5" fill="currentColor"></rect>
        </svg>`;
    case "density-stagger":
      return `
        <svg class="icon icon--density" viewBox="0 0 24 24" aria-hidden="true">
          <line class="bar-1" x1="6" y1="17" x2="6" y2="9" ${common}></line>
          <line class="bar-2" x1="12" y1="15" x2="12" y2="6" ${common}></line>
          <line class="bar-3" x1="18" y1="18" x2="18" y2="12" ${common}></line>
        </svg>`;
    case "sort-alpha":
      return `
        <svg class="icon icon--sort" viewBox="0 0 24 24" aria-hidden="true">
          <path class="line-1" d="M7 6v12" ${common}></path>
          <path class="line-2" d="M4.5 8.5 7 6l2.5 2.5" ${common}></path>
          <path class="line-3" d="M13 8h7" ${common}></path>
          <path class="line-4" d="M13 12h5" ${common}></path>
          <path class="line-5" d="M13 16h3" ${common}></path>
        </svg>`;
    case "sort-clock":
      return `
        <svg class="icon icon--sort" viewBox="0 0 24 24" aria-hidden="true">
          <circle class="line-1" cx="8" cy="12" r="4.5" ${common}></circle>
          <path class="line-2" d="M8 9.7v2.6l1.9 1.2" ${common}></path>
          <path class="line-3" d="M14.5 8h5" ${common}></path>
          <path class="line-4" d="M14.5 12h3.7" ${common}></path>
          <path class="line-5" d="M14.5 16H17" ${common}></path>
        </svg>`;
    case "sort-desc":
      return `
        <svg class="icon icon--sort" viewBox="0 0 24 24" aria-hidden="true">
          <path class="line-1" d="M5 7h14" ${common}></path>
          <path class="line-2" d="M8 12h11" ${common}></path>
          <path class="line-3" d="M11 17h8" ${common}></path>
        </svg>`;
    case "filter-sliders":
      return `
        <svg class="icon icon--filter" viewBox="0 0 24 24" aria-hidden="true">
          <path class="mouth" d="M5 8h14" ${common}></path>
          <circle class="stem" cx="10" cy="8" r="1.8" fill="currentColor"></circle>
          <path class="mouth" d="M5 16h14" ${common}></path>
          <circle class="stem" cx="15" cy="16" r="1.8" fill="currentColor"></circle>
        </svg>`;
    case "filter-narrow":
      return `
        <svg class="icon icon--filter" viewBox="0 0 24 24" aria-hidden="true">
          <path class="mouth" d="M6 7h12l-4.2 5.2v4.2l-3.6 1.8v-6z" ${common}></path>
          <circle class="stem" cx="12" cy="18" r="1.7" fill="currentColor"></circle>
        </svg>`;
    case "filter-funnel":
      return `
        <svg class="icon icon--filter" viewBox="0 0 24 24" aria-hidden="true">
          <path class="mouth" d="M5 7h14l-5.3 5.9v3.7l-3.4 1.7v-5.4z" ${common}></path>
          <path class="stem" d="M12 18.2v1.3" ${common}></path>
        </svg>`;
    case "layout-compact":
      return `
        <svg class="icon icon--layout" viewBox="0 0 24 24" aria-hidden="true">
          <rect class="cell" x="4" y="6" width="6" height="5" rx="1.2" fill="currentColor"></rect>
          <rect class="cell" x="12.5" y="6" width="7.5" height="5" rx="1.2" fill="currentColor"></rect>
          <rect class="cell" x="4" y="13" width="16" height="5" rx="1.2" fill="currentColor"></rect>
        </svg>`;
    case "layout-list":
      return `
        <svg class="icon icon--layout" viewBox="0 0 24 24" aria-hidden="true">
          <rect class="cell" x="5" y="6" width="3" height="3" rx="0.8" fill="currentColor"></rect>
          <rect class="cell" x="10" y="6.4" width="9" height="2.2" rx="1.1" fill="currentColor"></rect>
          <rect class="cell" x="5" y="11" width="3" height="3" rx="0.8" fill="currentColor"></rect>
          <rect class="cell" x="10" y="11.4" width="9" height="2.2" rx="1.1" fill="currentColor"></rect>
          <rect class="cell" x="5" y="16" width="3" height="3" rx="0.8" fill="currentColor"></rect>
          <rect class="cell" x="10" y="16.4" width="9" height="2.2" rx="1.1" fill="currentColor"></rect>
        </svg>`;
    case "layout-grid":
    default:
      return `
        <svg class="icon icon--layout" viewBox="0 0 24 24" aria-hidden="true">
          <rect class="cell" x="4.2" y="4.2" width="4.1" height="4.1" rx="0.8" fill="currentColor"></rect>
          <rect class="cell" x="9.95" y="4.2" width="4.1" height="4.1" rx="0.8" fill="currentColor"></rect>
          <rect class="cell" x="15.7" y="4.2" width="4.1" height="4.1" rx="0.8" fill="currentColor"></rect>
          <rect class="cell" x="4.2" y="9.95" width="4.1" height="4.1" rx="0.8" fill="currentColor"></rect>
          <rect class="cell" x="9.95" y="9.95" width="4.1" height="4.1" rx="0.8" fill="currentColor"></rect>
          <rect class="cell" x="15.7" y="9.95" width="4.1" height="4.1" rx="0.8" fill="currentColor"></rect>
          <rect class="cell" x="4.2" y="15.7" width="4.1" height="4.1" rx="0.8" fill="currentColor"></rect>
          <rect class="cell" x="9.95" y="15.7" width="4.1" height="4.1" rx="0.8" fill="currentColor"></rect>
          <rect class="cell" x="15.7" y="15.7" width="4.1" height="4.1" rx="0.8" fill="currentColor"></rect>
        </svg>`;
  }
}

function populateIconSelect(select, list, value) {
  select.innerHTML = "";
  list.forEach(([id, label]) => {
    const option = document.createElement("option");
    option.value = id;
    option.textContent = label;
    option.selected = value === id;
    select.appendChild(option);
  });
}

function applyCssVars() {
  refs.root.style.setProperty("--toolbar-button-size", `${state.buttonSize}px`);
  refs.root.style.setProperty("--toolbar-icon-size", `${state.iconSize}px`);
  refs.root.style.setProperty("--toolbar-gap", `${state.clusterGap}px`);
  refs.root.style.setProperty("--divider-gap", `${state.dividerGap}px`);
  refs.root.style.setProperty("--divider-opacity", String(state.dividerOpacity));
  refs.root.style.setProperty("--accent-glow", String(state.glow));
  refs.root.style.setProperty("--popover-width", `${state.popoverWidth}px`);
  refs.root.style.setProperty("--popover-radius", `${state.popoverRadius}px`);
  refs.root.style.setProperty("--popover-blur", String(state.popoverBlur));
  refs.root.style.setProperty("--popover-opacity", String(state.popoverOpacity));
  refs.root.style.setProperty("--panel-density", String(state.panelDensity));
}

function buildCluster() {
  const roles = [
    ["density", "Items per row"],
    ["sort", "Sort"],
    ["filter", "Filter"],
    ["layout", "Layout"],
  ];

  refs.cluster.innerHTML = "";

  roles.forEach(([role, label], index) => {
    const button = document.createElement("button");
    button.className = "toolbar-button" + (state.openRole === role ? " is-active" : "");
    button.type = "button";
    button.dataset.role = role;
    button.ariaLabel = label;
    button.innerHTML = iconSvg(state.icons[role]);
    button.addEventListener("click", () => {
      state.openRole = state.openRole === role ? "none" : role;
      controls.openRoleSelect.value = state.openRole;
      buildCluster();
      renderPopover();
    });
    refs.cluster.appendChild(button);
    if (index < roles.length - 1) {
      const divider = document.createElement("span");
      divider.className = "toolbar-divider";
      refs.cluster.appendChild(divider);
    }
  });
}

function listMarkup(items, selectedValue, onClickKey) {
  return `
    <div class="popover-list">
      ${items
        .map(
          ([id, label]) => `
            <button class="popover-item${selectedValue === id ? " is-selected" : ""}" type="button" data-${onClickKey}="${id}">
              <span>${label}</span>
              <span class="popover-item__check">✓</span>
            </button>`
        )
        .join("")}
    </div>
  `;
}

function renderPopover() {
  const role = state.openRole;
  if (!role || role === "none") {
    refs.popover.classList.remove("is-open");
    refs.popover.setAttribute("aria-hidden", "true");
    refs.popover.innerHTML = "";
    return;
  }

  const current = options[state.section];
  let content = "";

  if (role === "density") {
    const densityOptions = [["auto", "Auto"], ["4", "4"], ["5", "5"], ["6", "6"], ["8", "8"], ["10", "10"]];
    content = `
      <div class="toolbar-popover__surface">
        <div class="popover-head">
          <div>
            <h3>Items per row</h3>
            <p>Compact grid density for the archive wall.</p>
          </div>
          <span class="popover-meta">${state.density === "auto" ? "Auto" : state.density}</span>
        </div>
        <div class="density-rail">
          ${densityOptions
            .map(
              ([id, label]) =>
                `<button class="density-chip${state.density === id ? " is-selected" : ""}" type="button" data-density="${id}">${label}</button>`
            )
            .join("")}
        </div>
      </div>`;
  }

  if (role === "sort") {
    const currentLabel = current.sort.find(([id]) => id === state.sortMode)?.[1] || "A-Z";
    content = `
      <div class="toolbar-popover__surface">
        <div class="popover-head">
          <div>
            <h3>Sort by</h3>
            <p>Matches the current library section.</p>
          </div>
          <span class="popover-meta">${currentLabel}</span>
        </div>
        ${listMarkup(current.sort, state.sortMode, "sort")}
        <div class="toggle-row">
          <span>Direction</span>
          <div class="mini-switch">
            <button class="switch-button${state.sortDir === "asc" ? " is-selected" : ""}" type="button" data-dir="asc">Asc</button>
            <button class="switch-button${state.sortDir === "desc" ? " is-selected" : ""}" type="button" data-dir="desc">Desc</button>
          </div>
        </div>
      </div>`;
  }

  if (role === "filter") {
    const filterLabel = current.filter.find(([id]) => id === state.filterValue)?.[1] || "All";
    content = `
      <div class="toolbar-popover__surface">
        <div class="popover-head">
          <div>
            <h3>Filter by</h3>
            <p>Status filter for the active section.</p>
          </div>
          <span class="popover-meta">${filterLabel}</span>
        </div>
        ${listMarkup(current.filter, state.filterValue, "filter")}
      </div>`;
  }

  if (role === "layout") {
    const layoutLabel = state.layout === "compact_grid" ? "Compact" : state.layout === "list" ? "List" : "Grid";
    content = `
      <div class="toolbar-popover__surface">
        <div class="popover-head">
          <div>
            <h3>Layout</h3>
            <p>Visual mode and metadata overlays.</p>
          </div>
          <span class="popover-meta">${layoutLabel}</span>
        </div>
        <div class="inline-segment">
          <button class="${state.layout === "grid" ? "is-selected" : ""}" data-layout="grid" type="button">Grid</button>
          <button class="${state.layout === "compact_grid" ? "is-selected" : ""}" data-layout="compact_grid" type="button">Compact</button>
          <button class="${state.layout === "list" ? "is-selected" : ""}" data-layout="list" type="button">List</button>
        </div>
        <div class="toggle-row">
          <span>Show progress</span>
          <div class="mini-switch">
            <button class="switch-button${state.showProgress ? " is-selected" : ""}" data-progress="on" type="button">On</button>
            <button class="switch-button${!state.showProgress ? " is-selected" : ""}" data-progress="off" type="button">Off</button>
          </div>
        </div>
        <div class="toggle-row">
          <span>Show outlines</span>
          <div class="mini-switch">
            <button class="switch-button${state.showOutline ? " is-selected" : ""}" data-outline="on" type="button">On</button>
            <button class="switch-button${!state.showOutline ? " is-selected" : ""}" data-outline="off" type="button">Off</button>
          </div>
        </div>
      </div>`;
  }

  refs.popover.innerHTML = content;
  refs.popover.classList.add("is-open");
  refs.popover.setAttribute("aria-hidden", "false");

  requestAnimationFrame(() => {
    const activeButton = refs.cluster.querySelector(`.toolbar-button[data-role="${role}"]`);
    if (!activeButton) return;
    const rect = activeButton.getBoundingClientRect();
    const popRect = refs.popover.getBoundingClientRect();
    const gutter = 16;
    const left = Math.min(
      window.innerWidth - popRect.width - gutter,
      Math.max(gutter, rect.left + rect.width / 2 - popRect.width / 2)
    );
    refs.popover.style.left = `${Math.round(left)}px`;
    refs.popover.style.top = `${Math.round(rect.bottom + 12)}px`;
  });

  refs.popover.querySelectorAll("[data-density]").forEach((button) => {
    button.addEventListener("click", () => {
      state.density = button.dataset.density;
      renderPopover();
      renderTokens();
    });
  });
  refs.popover.querySelectorAll("[data-sort]").forEach((button) => {
    button.addEventListener("click", () => {
      state.sortMode = button.dataset.sort;
      renderPopover();
      renderTokens();
    });
  });
  refs.popover.querySelectorAll("[data-filter]").forEach((button) => {
    button.addEventListener("click", () => {
      state.filterValue = button.dataset.filter;
      renderPopover();
      renderTokens();
    });
  });
  refs.popover.querySelectorAll("[data-dir]").forEach((button) => {
    button.addEventListener("click", () => {
      state.sortDir = button.dataset.dir;
      renderPopover();
      renderTokens();
    });
  });
  refs.popover.querySelectorAll("[data-layout]").forEach((button) => {
    button.addEventListener("click", () => {
      state.layout = button.dataset.layout;
      renderPopover();
      renderTokens();
    });
  });
  refs.popover.querySelectorAll("[data-progress]").forEach((button) => {
    button.addEventListener("click", () => {
      state.showProgress = button.dataset.progress === "on";
      renderPopover();
      renderTokens();
    });
  });
  refs.popover.querySelectorAll("[data-outline]").forEach((button) => {
    button.addEventListener("click", () => {
      state.showOutline = button.dataset.outline === "on";
      renderPopover();
      renderTokens();
    });
  });
}

function renderSegmented() {
  refs.previewSegmented.dataset.active = state.section;
  refs.previewSegmented.querySelectorAll("[data-segment]").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.segment === state.section);
  });
}

function renderTokens() {
  refs.tokenPreview.textContent = JSON.stringify(
    {
      section: state.section,
      openRole: state.openRole,
      cluster: {
        buttonSize: state.buttonSize,
        iconSize: state.iconSize,
        gap: state.clusterGap,
        dividerGap: state.dividerGap,
        dividerOpacity: state.dividerOpacity,
        glow: state.glow,
      },
      popover: {
        width: state.popoverWidth,
        radius: state.popoverRadius,
        blur: state.popoverBlur,
        opacity: state.popoverOpacity,
        density: state.panelDensity,
      },
      icons: state.icons,
    },
    null,
    2
  );
}

function clampSectionState() {
  const current = options[state.section];
  if (!current.sort.some(([id]) => id === state.sortMode)) {
    state.sortMode = current.sort[0][0];
  }
  if (!current.filter.some(([id]) => id === state.filterValue)) {
    state.filterValue = current.filter[0][0];
  }
}

function syncControls() {
  controls.buttonSizeRange.value = String(state.buttonSize);
  controls.iconSizeRange.value = String(state.iconSize);
  controls.clusterGapRange.value = String(state.clusterGap);
  controls.dividerGapRange.value = String(state.dividerGap);
  controls.dividerOpacityRange.value = String(state.dividerOpacity);
  controls.glowRange.value = String(state.glow);
  controls.popoverWidthRange.value = String(state.popoverWidth);
  controls.popoverRadiusRange.value = String(state.popoverRadius);
  controls.popoverBlurRange.value = String(state.popoverBlur);
  controls.popoverOpacityRange.value = String(state.popoverOpacity);
  controls.panelDensityRange.value = String(state.panelDensity);
  refs.sectionSelect.value = state.section;
  refs.openRoleSelect.value = state.openRole;
  populateIconSelect(controls.iconDensitySelect, iconOptions.density, state.icons.density);
  populateIconSelect(controls.iconSortSelect, iconOptions.sort, state.icons.sort);
  populateIconSelect(controls.iconFilterSelect, iconOptions.filter, state.icons.filter);
  populateIconSelect(controls.iconLayoutSelect, iconOptions.layout, state.icons.layout);
}

function rerender() {
  clampSectionState();
  applyCssVars();
  renderSegmented();
  buildCluster();
  renderPopover();
  renderTokens();
  syncControls();
}

refs.previewSegmented.querySelectorAll("[data-segment]").forEach((button) => {
  button.addEventListener("click", () => {
    state.section = button.dataset.segment;
    rerender();
  });
});

refs.sectionSelect.addEventListener("change", (event) => {
  state.section = event.target.value;
  rerender();
});

refs.openRoleSelect.addEventListener("change", (event) => {
  state.openRole = event.target.value;
  rerender();
});

controls.buttonSizeRange.addEventListener("input", (event) => {
  state.buttonSize = Number(event.target.value);
  applyCssVars();
  renderTokens();
});
controls.iconSizeRange.addEventListener("input", (event) => {
  state.iconSize = Number(event.target.value);
  applyCssVars();
  renderTokens();
});
controls.clusterGapRange.addEventListener("input", (event) => {
  state.clusterGap = Number(event.target.value);
  applyCssVars();
  renderTokens();
});
controls.dividerGapRange.addEventListener("input", (event) => {
  state.dividerGap = Number(event.target.value);
  applyCssVars();
  renderTokens();
});
controls.dividerOpacityRange.addEventListener("input", (event) => {
  state.dividerOpacity = Number(event.target.value);
  applyCssVars();
  renderTokens();
});
controls.glowRange.addEventListener("input", (event) => {
  state.glow = Number(event.target.value);
  applyCssVars();
  renderTokens();
});
controls.popoverWidthRange.addEventListener("input", (event) => {
  state.popoverWidth = Number(event.target.value);
  applyCssVars();
  renderPopover();
  renderTokens();
});
controls.popoverRadiusRange.addEventListener("input", (event) => {
  state.popoverRadius = Number(event.target.value);
  applyCssVars();
  renderPopover();
  renderTokens();
});
controls.popoverBlurRange.addEventListener("input", (event) => {
  state.popoverBlur = Number(event.target.value);
  applyCssVars();
  renderTokens();
});
controls.popoverOpacityRange.addEventListener("input", (event) => {
  state.popoverOpacity = Number(event.target.value);
  applyCssVars();
  renderTokens();
});
controls.panelDensityRange.addEventListener("input", (event) => {
  state.panelDensity = Number(event.target.value);
  applyCssVars();
  renderPopover();
  renderTokens();
});

controls.iconDensitySelect.addEventListener("change", (event) => {
  state.icons.density = event.target.value;
  buildCluster();
  renderTokens();
});
controls.iconSortSelect.addEventListener("change", (event) => {
  state.icons.sort = event.target.value;
  buildCluster();
  renderTokens();
});
controls.iconFilterSelect.addEventListener("change", (event) => {
  state.icons.filter = event.target.value;
  buildCluster();
  renderTokens();
});
controls.iconLayoutSelect.addEventListener("change", (event) => {
  state.icons.layout = event.target.value;
  buildCluster();
  renderTokens();
});

refs.resetButton.addEventListener("click", () => {
  Object.assign(state, {
    section: "comics",
    openRole: "none",
    buttonSize: 30,
    iconSize: 18,
    clusterGap: 10,
    dividerGap: 6,
    dividerOpacity: 0.12,
    glow: 0.55,
    popoverWidth: 292,
    popoverRadius: 24,
    popoverBlur: 18,
    popoverOpacity: 0.9,
    panelDensity: 0.94,
    icons: {
      density: "density-bars",
      sort: "sort-desc",
      filter: "filter-funnel",
      layout: "layout-grid",
    },
    density: "auto",
    sortMode: "az",
    sortDir: "asc",
    filterValue: "all",
    layout: "grid",
    showProgress: true,
    showOutline: true,
  });
  rerender();
});

document.addEventListener("mousedown", (event) => {
  const insideCluster = refs.cluster.contains(event.target);
  const insidePopover = refs.popover.contains(event.target);
  const insideControls = document.querySelector(".controls-panel").contains(event.target);
  if (!insideCluster && !insidePopover && !insideControls) {
    state.openRole = "none";
    rerender();
  }
});

rerender();
