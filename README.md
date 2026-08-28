<div align="center">

<a href="https://github.com/johnnylord1/Epigraph">
  <img src="./app/src/main/res/mipmap-xxxhdpi/ic_launcher.png" alt="Epigraph Android icon" height="180" width="180" />
</a>

# Epigraph Mobile

<strong>Native Android reading for the Epigraph library.</strong>

<p>
  <a href="https://github.com/johnnylord1/Epigraph/tree/mobile">Android source</a> ·
  <a href="https://github.com/johnnylord1/Epigraph/tree/main">Desktop source</a> ·
  <a href="https://github.com/johnnylord1/Epigraph/releases">Releases</a> ·
  <a href="https://github.com/johnnylord1/Epigraph/issues">Issues</a>
</p>

[![CI](https://github.com/johnnylord1/Epigraph/actions/workflows/build_push.yml/badge.svg?branch=mobile&labelColor=27303D)](https://github.com/johnnylord1/Epigraph/actions/workflows/build_push.yml?query=branch%3Amobile)
[![License: Apache-2.0](https://img.shields.io/github/license/johnnylord1/Epigraph?labelColor=27303D&color=0877d2)](https://github.com/johnnylord1/Epigraph/blob/main/LICENSE)

</div>

[![Epigraph Stable](https://img.shields.io/github/v/release/johnnylord1/Epigraph?maxAge=3600&label=Stable&labelColor=06599d&color=043b69&filter=v*)](https://github.com/johnnylord1/Epigraph/releases)
[![Epigraph Beta](https://img.shields.io/github/v/release/johnnylord1/Epigraph?maxAge=3600&label=Beta&labelColor=2c2c47&color=1c1c39&filter=v*-b*)](https://github.com/johnnylord1/Epigraph/releases)
[![Epigraph Nightly](https://img.shields.io/github/v/release/johnnylord1/Epigraph?maxAge=3600&label=Nightly&labelColor=B11A3B&color=1c1c39)](https://github.com/johnnylord1/Epigraph/releases)

Epigraph Mobile is the native Android client of Epigraph. It brings manga,
novel, EPUB, and PDF reading, library organization, source discovery, and
offline progress to phones and tablets while the [main branch](https://github.com/johnnylord1/Epigraph/tree/main)
contains the desktop Tauri application and the PC-hosted Core/Syncd services.

<p align="center">
  <img src="./.github/readme-images/screens.gif" alt="Epigraph Android library and reader screens" width="78%" />
</p>

## Epigraph on desktop and Android

The two clients share the Epigraph product identity and compatibility
contracts:

<p align="center">
  <img src="https://github.com/johnnylord1/Epigraph/raw/refs/heads/main/docs/assets/epigraph-hero-banner.png" alt="Epigraph desktop reader and recommendations" width="78%" />
</p>

| Client | Branch | Package or identity |
| --- | --- | --- |
| Android | [mobile](https://github.com/johnnylord1/Epigraph/tree/mobile) | <code>app.epigraph.mobile</code> |
| Desktop | [main](https://github.com/johnnylord1/Epigraph/tree/main) | <code>dev.epigraph.app</code> · <code>epigraph</code> |

## Android identity and migration

The Android application ID is <code>app.epigraph.mobile</code>. It is installed
separately from the legacy <code>app.aethon.mobile</code>; Android private
sandboxes are isolated, so the new app cannot read the old app's private data
automatically.

Move data through an exported backup/import flow or by selecting shared
storage explicitly. The new app does not remove or modify the legacy
installation. New backups use <code>.epigraphbk</code> while existing
<code>.aethonbk</code> backups remain importable.

For paired desktop use, new links use <code>epigraph://</code> and the clients
continue accepting supported <code>aethon://</code>, <code>hayai://</code>, and
<code>tachiyomi://</code> links during the transition. Persisted database and
protocol identifiers remain stable where compatibility requires them.

## Features

- Manga and comic library with categories, source browsing, downloads,
  tracking, backups, and offline reading.
- Native novel reader with LNReader-compatible JavaScript plugins, repository
  management, validation, and on-device QuickJS execution.
- Continuous chapter reading, smooth auto-scroll, chapter transitions,
  progress controls, orientation preferences, TTS, and tablet-friendly
  layouts.
- Recommendations that distinguish manga and novels and can search installed
  sources from an external recommendation.
- Reader and browse improvements including page previews, infinite scrolling,
  source navigation, filters, and source-specific metadata.
- Library update reports, migration tooling, crash reporting, stable/beta/
  nightly variants, and device-friendly performance controls.

## Build

Open the repository in Android Studio or run Gradle from the
<code>mobile</code> branch.

~~~bash
./gradlew assembleDevDebug
./gradlew assembleStandardRelease
~~~

The application requires Android 7.0 or higher. Release artifacts and
workflow status are available from
[GitHub Actions](https://github.com/johnnylord1/Epigraph/actions) and the
[Epigraph Releases page](https://github.com/johnnylord1/Epigraph/releases).

## Verification

~~~bash
./gradlew test
./gradlew lint
~~~

The mobile build also validates SQLDelight migrations and the compatibility
contracts used by the desktop Core/Syncd boundary.

## Foundation and credits

Epigraph Mobile preserves its upstream history and legal attribution. The
Android foundation is [Hayai](https://github.com/HayaiApp/hayai), built on
[Yōkai](https://github.com/null2264/yokai),
[Mihon](https://github.com/mihonapp/mihon),
[TachiyomiJ2K](https://github.com/Jays2Kings/tachiyomiJ2K),
[TachiyomiSY](https://github.com/jobobby04/TachiyomiSY), and
[LNReader](https://github.com/LNReader/lnreader). Those names, projects, and
licenses describe provenance and are not Epigraph branding.

## Contributing

Pull requests are welcome. For a substantial change, open an issue first so
the desktop/mobile compatibility impact can be discussed.

Before reporting a bug, check the
[changelog and releases](https://github.com/johnnylord1/Epigraph/releases) and
[existing issues](https://github.com/johnnylord1/Epigraph/issues). Include
the app version, device/Android version, reproduction steps, and screenshots
or logs when relevant.

## Disclaimer and license

Epigraph does not host or distribute third-party content. Users are
responsible for their own sources, servers, downloads, and local files.

The repository preserves the terms of the
[Apache License 2.0](https://github.com/johnnylord1/Epigraph/blob/main/LICENSE), including the historical copyright
notices required by its upstream projects.
