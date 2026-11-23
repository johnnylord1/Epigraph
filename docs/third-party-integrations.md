# Third-party sources and integrations

This note describes where Epigraph connects to third-party source code and metadata. It records repository behavior; it does not certify a source's licensing, terms, or content rights.

## Source repositories and catalogs

- **Desktop comics:** Suwayomi manages comic source extensions and their catalogs. The desktop Core mediates access to the managed server; extension stores and source content are external to Epigraph.
- **Novels:** Desktop includes the LNReader v3 plugin catalog feed at `https://raw.githubusercontent.com/LNReader/lnreader-plugins/plugins/v3.0.0/.dist/plugins.min.json`. The feed lists plugin metadata and artifact locations; plugins and any content they access are maintained upstream.
- **Android plugins:** Epigraph Mobile can load JavaScript plugin repositories. Repository indexes and plugin artifacts are fetched from their configured upstream URLs; the app's compatibility layer does not establish ownership of those projects.
- **Android tag metadata:** `mobile/tools/nhtags/scrape_nhtags.py` requests paginated tag index pages from `nhentai.net` and writes visible tag names and slugs as JSON assets. It does not fetch gallery pages, images, or chapters, and it does not route requests through FlareSolverr. On HTTP 403 or 429 it waits and retries a bounded number of times, then exits with an error.

## Optional anti-bot helper

Desktop can use FlareSolverr for source requests that require an anti-bot challenge. Epigraph can manage a local FlareSolverr process or connect to a local/Docker service when configured. This is an optional network helper; it is not a source catalog and does not provide reading content. Users remain responsible for the sources and services they configure and for following the applicable upstream terms.

## Scope and maintainer review

Epigraph provides reader clients, library state, and sync services; it does not host or distribute the third-party reading content returned by configured sources. A catalog entry does not imply affiliation with an upstream maintainer or grant permission to use or redistribute that maintainer's code, metadata, or content.

When adding or updating an integration, record its upstream URL, the exact code or metadata included in Epigraph, the relevant license or terms reference, and whether requests are direct or routed through a helper. Review source terms and redistribution rights before adding bundled data. Do not describe a third-party catalog or helper as Epigraph-owned.
