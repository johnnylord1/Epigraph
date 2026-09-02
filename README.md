<div align="center">

# Epigraph

**A desktop reading library for comics, novels, EPUB, and PDF.**

<img src="docs/assets/epigraph-readme-cover.webp" alt="Epigraph, read across formats" width="100%">

[Download for Windows](https://github.com/johnnylord1/Epigraph/releases/latest) | [Desktop documentation](docs/desktop-features.md) | [Android client](https://github.com/johnnylord1/Epigraph/tree/mobile)

[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-a995cf)](LICENSE)

</div>

Epigraph brings source-based comics and novels together with local EPUB and PDF books in one native desktop workspace. It keeps each format's reader and data model intact while sharing discovery, downloads, recommendations, themes, and cross-device identity.

## Install

The current Windows x64 installer is available on the [Releases page](https://github.com/johnnylord1/Epigraph/releases/latest). The installer runs per user and lets you choose the destination directory.

Epigraph can manage its bundled Suwayomi runtime or connect to an external Suwayomi server. Content extensions and repositories are configured by the user; Epigraph does not include third-party catalogs.

## One library, several ways to read

### Comics

Browse installed sources, manage downloads, migrate titles safely, and read with native comic controls. Suwayomi integration covers metadata, chapters, extensions, updates, and library state.

### Books

Import EPUB and PDF files, keep independent reading progress, and use reader-specific controls including themes, typography, bookmarks, and text to speech where supported.

### Epigraph Core

The desktop can host authenticated pairing and Syncd replication for trusted devices. Sessions, scopes, snapshots, reconnect behavior, and device removal remain visible and controllable from the app.

<img src="docs/screenshots/epigraph-Home.png" alt="Epigraph desktop home in the Nocturne theme" width="100%">

Recommendations are calculated from the library and connected providers. Results remain explainable, source-aware, and empty when supporting data is unavailable.

## Build from source

Desktop prerequisites:

- Node.js and pnpm 10.33.0
- Rust through rustup
- Tauri v2 system prerequisites
- Microsoft Edge WebView2 on Windows

```bash
pnpm install
pnpm tauri:dev
```

Create a production bundle:

```bash
pnpm tauri:build
```

Run the main verification suites:

```bash
pnpm test:unit
pnpm test:browser
cargo test --manifest-path src-tauri/Cargo.toml
```

The complete release gate is available as `pnpm release:verify`. On Windows it
builds the frontend first and stages the pinned Suwayomi runtime after verifying
its SHA-256, so a fresh checkout does not depend on an ignored local bundle.

## Project map

- [`main`](https://github.com/johnnylord1/Epigraph/tree/main) contains the Tauri desktop app, Epigraph Core, Syncd, and desktop documentation.
- [`mobile`](https://github.com/johnnylord1/Epigraph/tree/mobile) contains the native Android client.
- [`docs/desktop-features.md`](docs/desktop-features.md) documents implemented desktop capabilities and their boundaries.
- [`docs/screenshots`](docs/screenshots) contains the current desktop interface gallery.
- [`docs/roadmap.md`](docs/roadmap.md) tracks planned work.
- [`CHANGELOG.md`](CHANGELOG.md) records user-facing release changes.

## Contributing and security

Read the [contribution guide](.github/CONTRIBUTING.md) before opening a pull request. Please report vulnerabilities through the private process described in the [security policy](.github/SECURITY.md), not through a public issue.

## Credits and legal

Epigraph is licensed under [Apache License 2.0](LICENSE). The project preserves required upstream attribution for its desktop and Android foundations.

Epigraph integrates with [Suwayomi-Server](https://github.com/Suwayomi/Suwayomi-Server) but does not host, provide, or distribute third-party content. Users are responsible for their sources, servers, downloads, and local files.
