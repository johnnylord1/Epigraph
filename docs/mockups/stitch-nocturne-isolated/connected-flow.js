(function () {
  const pages = {
    "home.html": {
      hotspots: [
        { label: "Library", href: "./library-archive.html", x: 1.8, y: 16.2, w: 5.1, h: 4.6 },
        { label: "Browse", href: "./browse.html", x: 1.8, y: 22.1, w: 5.1, h: 4.6 },
        { label: "Downloads", href: "./downloads.html", x: 1.8, y: 28.0, w: 5.1, h: 4.6 },
        { label: "Settings", href: "./settings.html", x: 1.8, y: 33.9, w: 5.1, h: 4.6 },
        { label: "Continue", href: "./reader.html", x: 34.5, y: 27.2, w: 17.5, h: 6.2 },
        { label: "Manga", href: "./series-detail.html", x: 63.0, y: 34.6, w: 14.2, h: 22.8 },
        { label: "Novel", href: "./novel-detail.html", x: 79.0, y: 34.6, w: 14.2, h: 22.8 }
      ]
    },
    "library-archive.html": {
      hotspots: [
        { label: "Home", href: "./home.html", x: 1.8, y: 10.2, w: 5.1, h: 4.6 },
        { label: "Browse", href: "./browse.html", x: 1.8, y: 22.0, w: 5.1, h: 4.6 },
        { label: "Downloads", href: "./downloads.html", x: 1.8, y: 27.9, w: 5.1, h: 4.6 },
        { label: "Settings", href: "./settings.html", x: 1.8, y: 33.8, w: 5.1, h: 4.6 },
        { label: "Series Detail", href: "./series-detail.html", x: 17.3, y: 28.8, w: 14.4, h: 28.6 },
        { label: "Novel Detail", href: "./novel-detail.html", x: 67.9, y: 28.8, w: 14.4, h: 23.0 },
        { label: "Reader", href: "./reader.html", x: 17.3, y: 59.8, w: 14.4, h: 28.6 }
      ]
    },
    "browse.html": {
      hotspots: [
        { label: "Home", href: "./home.html", x: 1.8, y: 10.2, w: 5.1, h: 4.6 },
        { label: "Library", href: "./library-archive.html", x: 1.8, y: 16.1, w: 5.1, h: 4.6 },
        { label: "Downloads", href: "./downloads.html", x: 1.8, y: 28.0, w: 5.1, h: 4.6 },
        { label: "Settings", href: "./settings.html", x: 1.8, y: 33.9, w: 5.1, h: 4.6 },
        { label: "Series Result", href: "./series-detail.html", x: 23.2, y: 39.5, w: 30.0, h: 22.0 },
        { label: "Novel Result", href: "./novel-detail.html", x: 56.2, y: 39.5, w: 28.0, h: 22.0 }
      ]
    },
    "series-detail.html": {
      hotspots: [
        { label: "Back Library", href: "./library-archive.html", x: 10.3, y: 8.3, w: 13.2, h: 4.6 },
        { label: "Continue", href: "./reader.html", x: 35.2, y: 28.5, w: 19.8, h: 6.3 },
        { label: "Downloads", href: "./downloads.html", x: 56.8, y: 28.5, w: 11.2, h: 6.3 },
        { label: "Reader Chapter", href: "./reader.html", x: 18.2, y: 44.8, w: 62.5, h: 7.4 },
        { label: "Home", href: "./home.html", x: 1.8, y: 10.2, w: 5.1, h: 4.6 }
      ]
    },
    "reader.html": {
      hotspots: [
        { label: "Back", href: "./series-detail.html", x: 2.4, y: 4.2, w: 7.0, h: 4.3 },
        { label: "Library", href: "./library-archive.html", x: 11.0, y: 4.2, w: 8.0, h: 4.3 },
        { label: "Settings", href: "./settings.html", x: 89.4, y: 4.2, w: 7.1, h: 4.3 },
        { label: "Novel", href: "./novel-detail.html", x: 69.0, y: 91.1, w: 10.5, h: 5.0 },
        { label: "Series", href: "./series-detail.html", x: 80.6, y: 91.1, w: 10.5, h: 5.0 }
      ]
    },
    "novel-detail.html": {
      hotspots: [
        { label: "Back Library", href: "./library-archive.html", x: 10.4, y: 8.4, w: 13.2, h: 4.6 },
        { label: "Continue", href: "./reader.html", x: 33.6, y: 27.8, w: 20.2, h: 6.2 },
        { label: "Browse", href: "./browse.html", x: 56.2, y: 27.8, w: 12.4, h: 6.2 },
        { label: "Section", href: "./reader.html", x: 19.6, y: 47.0, w: 58.8, h: 8.0 },
        { label: "Home", href: "./home.html", x: 1.8, y: 10.2, w: 5.1, h: 4.6 }
      ]
    },
    "downloads.html": {
      hotspots: [
        { label: "Home", href: "./home.html", x: 1.8, y: 10.2, w: 5.1, h: 4.6 },
        { label: "Library", href: "./library-archive.html", x: 1.8, y: 16.1, w: 5.1, h: 4.6 },
        { label: "Series", href: "./series-detail.html", x: 22.0, y: 30.5, w: 57.0, h: 8.6 },
        { label: "Settings", href: "./settings.html", x: 1.8, y: 33.9, w: 5.1, h: 4.6 }
      ]
    },
    "settings.html": {
      hotspots: [
        { label: "Home", href: "./home.html", x: 1.8, y: 10.2, w: 5.1, h: 4.6 },
        { label: "Library", href: "./library-archive.html", x: 1.8, y: 16.1, w: 5.1, h: 4.6 },
        { label: "Downloads", href: "./downloads.html", x: 1.8, y: 28.0, w: 5.1, h: 4.6 },
        { label: "Reader", href: "./reader.html", x: 52.5, y: 58.0, w: 24.5, h: 13.8 },
        { label: "Theme Preview", href: "./library-archive.html", x: 52.5, y: 41.0, w: 24.5, h: 13.8 }
      ]
    }
  };

  const path = window.location.pathname.split("/").pop();
  const screen = pages[path];
  if (!screen) return;

  const style = document.createElement("style");
  style.textContent = `
    .aethon-hotspots {
      position: fixed;
      inset: 0;
      z-index: 9999;
      pointer-events: none;
    }
    .aethon-hotspot {
      position: absolute;
      border: 1px solid transparent;
      background: transparent;
      border-radius: 12px;
      cursor: pointer;
      pointer-events: auto;
      transition: border-color 120ms ease, background 120ms ease, transform 120ms ease;
    }
    .aethon-hotspot:hover,
    .aethon-hotspot:focus-visible {
      border-color: rgba(205, 189, 255, 0.42);
      background: rgba(205, 189, 255, 0.08);
      transform: translateY(-1px);
      outline: none;
    }
    .aethon-hotspot::after {
      content: attr(data-label);
      position: absolute;
      left: 50%;
      top: calc(100% + 8px);
      transform: translateX(-50%);
      padding: 6px 8px;
      border-radius: 999px;
      font: 11px/1 Inter, system-ui, sans-serif;
      letter-spacing: .03em;
      color: #f0edf8;
      background: rgba(15, 17, 24, 0.92);
      border: 1px solid rgba(205, 189, 255, 0.16);
      white-space: nowrap;
      opacity: 0;
      pointer-events: none;
      transition: opacity 120ms ease;
    }
    .aethon-hotspot:hover::after,
    .aethon-hotspot:focus-visible::after {
      opacity: 1;
    }
    @media (max-width: 900px) {
      .aethon-hotspot::after { display: none; }
    }
  `;
  document.head.appendChild(style);

  const layer = document.createElement("div");
  layer.className = "aethon-hotspots";

  screen.hotspots.forEach((spot) => {
    const a = document.createElement("a");
    a.className = "aethon-hotspot";
    a.href = spot.href;
    a.dataset.label = spot.label;
    a.setAttribute("aria-label", spot.label);
    a.style.left = `${spot.x}%`;
    a.style.top = `${spot.y}%`;
    a.style.width = `${spot.w}%`;
    a.style.height = `${spot.h}%`;
    layer.appendChild(a);
  });

  document.body.appendChild(layer);
})();
