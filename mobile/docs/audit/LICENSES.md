# License and provenance matrix

## Project lineage

| Component | License/status | Use |
|---|---|---|
| Hayai / Yōkai / J2K / Mihon lineage | Apache-2.0 lineage documented upstream | Fork foundation |
| Tsundoku | Apache-2.0 | Candidate donor/reference for EPUB, text reader, TTS, and tests after security review |
| AhmerPdfium/Viewer | Apache-2.0 candidate | PDF rendering engine behind an Epigraph adapter |
| SyncYomi | GPL-2.0 | Behavioral/API reference only; no source copying |

Resolved dependencies include Apache-2.0, MIT, BSD-2-Clause, BSD-3-Clause, MPL-2.0, and Android SDK terms.

## Manual attribution required

The automatic report did not identify licenses for MPAndroidChart, PhotoView, subsampling-scale-image-view, DirectionalViewPager, and conductor-support-preference. Verify upstream license files and add AboutLibraries overrides before release.

Native/transpiled components need a manual bill of materials, including QuickJS, SQLite, libarchive, Conscrypt, image-decoder, bundled JavaScript, Cheerio, and other npm-derived assets.

## Distribution blockers

- Firebase/Crashlytics/Google Services are removed from the Epigraph working product; the upstream baseline/history still contains their former configuration and must not be used as an Epigraph service.
- Remove or document the tracked `.tmp_qjs` binary artifacts, their hashes, source, and license.
- Preserve Apache/MIT/MPL notices in the APK and repository.
- Keystores and signing credentials remain outside Git.
