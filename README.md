<div align="center">
  <img src="docs/banner.svg" width="100%" alt="Aethon" />
</div>

<div align="center">

[![release](https://img.shields.io/github/v/release/Youwes09/Moku?style=flat&color=a8c4a8&labelColor=151515)](https://github.com/Youwes09/Moku/releases/latest)
[![downloads](https://img.shields.io/github/downloads/Youwes09/Moku/total?style=flat&color=a8c4a8&labelColor=151515)](https://github.com/Youwes09/Moku/releases/latest)
[![license](https://img.shields.io/github/license/Youwes09/Moku?style=flat&color=a8c4a8&labelColor=151515)](./LICENSE)
[![discord](https://img.shields.io/discord/1485151759511978077?style=flat&color=a8c4a8&labelColor=151515&label=discord)](https://discord.gg/cfncTbJ2)

</div>

<br/>

Aethon is a fast, minimal manga reader frontend built from the upstream [Moku](https://github.com/Youwes09/Moku) codebase for [Suwayomi-Server](https://github.com/Suwayomi/Suwayomi-Server). It keeps the same lightweight Tauri approach with no Electron overhead.

---

## Screenshots

<div align="center">
  <img src="docs/screenshots/Moku-Home.png" width="49%" alt="Home" />
  <img src="docs/screenshots/Moku-Discover.png" width="49%" alt="Discover" />
  <img src="docs/screenshots/Moku-Reader.png" width="49%" alt="Reader" />
  <img src="docs/screenshots/Moku-Preview.png" width="49%" alt="Preview" />
  <img src="docs/screenshots/Moku-Tracker.png" width="49%" alt="Tracker" />
  <img src="docs/screenshots/Moku-Settings.png" width="49%" alt="Settings" />
</div>

<div align="center">
  <a href="docs/screenshots">View all screenshots →</a>
</div>

---

## Features

- **Library management** — organize manga into folders, track unread counts, filter by genre
- **Built-in reader** — single page, long strip, configurable fit modes, customizable keybinds
- **Extension support** — install and manage Suwayomi extensions directly from the app
- **Download management** — queue and monitor chapter downloads with progress toasts
- **Tracker integration** — sync reading progress with AniList, MyAnimeList, Kitsu, and more
- **Auto-start server** — optionally launch Suwayomi in the background on startup
- **Multiple themes** — Dark, Light, Midnight, Warm, High Contrast, and more
- **Auto-updates** — in-app update checker with silent background notifications

---

## Installation

### Flatpak (Linux, recommended)

Suwayomi-Server and a bundled JRE are included — no separate install needed.

```bash
flatpak install moku.flatpak
flatpak run dev.moku.app
```

Download the latest `moku.flatpak` from the [releases page](https://github.com/Youwes09/Moku/releases/latest).

### Nix

```bash
nix run github:Youwes09/Moku
```

Add to your flake:

```nix
inputs.moku.url = "github:Youwes09/Moku";
```

### Windows

Download the `.exe` installer from the [releases page](https://github.com/Youwes09/Moku/releases/latest). Suwayomi-Server and a JRE are bundled.

### macOS

Download the `.dmg` from the [releases page](https://github.com/Youwes09/Moku/releases/latest).

> **Note:** Builds are ad-hoc signed. On first launch you may need to run:
> ```bash
> xattr -rd com.apple.quarantine /Applications/Aethon.app
> ```

---

## Requirements

If you're not using the bundled Flatpak or Windows installer, [Suwayomi-Server](https://github.com/Suwayomi/Suwayomi-Server) must be running separately. By default Aethon connects to `http://127.0.0.1:4567`.

You can point Aethon at any Suwayomi instance — local or remote — via **Settings → General → Server URL**.

---

## Development

**Prerequisites:** [Node.js](https://nodejs.org) 18.12+, `npm`, [pnpm](https://pnpm.io) or the `npm exec pnpm` fallback, [Rust via rustup](https://rustup.rs), [Microsoft Edge WebView2](https://developer.microsoft.com/en-us/microsoft-edge/webview2/), Visual Studio Build Tools with MSVC + Windows SDK on Windows, and [Tauri v2 prerequisites](https://tauri.app/start/prerequisites/).

### Preferred dev path

If `pnpm` is already installed:

```bash
git clone https://github.com/Youwes09/Moku Aethon
cd Aethon
pnpm install
pnpm tauri:dev
```

### Fallback dev path

If `pnpm` is not installed globally but `npm` is available, use:

```bash
git clone https://github.com/Youwes09/Moku Aethon
cd Aethon
npm exec pnpm install --frozen-lockfile
npm exec pnpm exec vite build
npm exec pnpm tauri info
npm exec pnpm tauri:dev
```

### Windows desktop notes

- `npm exec pnpm exec vite build` is enough to validate the JS/frontend baseline.
- `npm exec pnpm tauri:dev` additionally requires WebView2, `rustup`/`rustc`/`cargo`, and Visual Studio Build Tools with MSVC + Windows SDK.
- In the current validation environment, the frontend build succeeded and `tauri info` confirmed WebView2 is installed, but Rust and Visual Studio Build Tools were missing, so native desktop boot could not be completed here.

### Runtime launch policy

For local desktop verification, use the managed launcher instead of opening raw gates directly:

- Desktop shortcut: `Aethon.lnk`
- Script: `scripts/launch-latest-aethon.ps1`
- Cleanup: `scripts/stop-aethon-orphans.ps1`

Purpose-specific Syncd gates still exist, but they are only for Syncd protocol/runtime verification. The full policy lives in [docs/runtime-session-policy.md](./docs/runtime-session-policy.md).

### Nix

Or with Nix:

```bash
nix develop
pnpm install
pnpm tauri:dev
```

---

## Stack

| | |
|---|---|
| [Tauri v2](https://tauri.app) | Native app shell |
| [Svelte 5](https://svelte.dev) + [TypeScript](https://www.typescriptlang.org) | UI |
| [Vite](https://vitejs.dev) | Frontend bundler |
| [Crane](https://github.com/ipetkov/crane) | Nix Rust builds |

---

## Community

Questions, feedback, or just want to hang out — join the Discord.

[![Discord](https://img.shields.io/discord/1485151759511978077?style=for-the-badge&color=a8c4a8&labelColor=151515&label=Join+the+Discord)](https://discord.gg/cfncTbJ2)

---

## License

Distributed under the [Apache 2.0 License](./LICENSE).

---

## Disclaimer

Aethon does not host or distribute any content. The developers have no affiliation with any content providers accessible through connected sources.
