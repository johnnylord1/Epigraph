# Backup restore and repository fixes

## Goal

Make backup export/import and manual extension repository setup reliable, while
presenting restore readiness in a concise, user-oriented interface.

## Implemented

- Record manga extension store URLs in unified exports.
- Provision missing manga stores/extensions before restore, then wait for the
  Suwayomi source inventory to converge.
- Provision novel/LNReader repositories and plugins before applying Library.
- Recover LNReader repository provenance from `Setting.json` plugin artifact
  URLs and keep each plugin bound to the repository recorded by the backup.
- Accept current `index.pb` extension stores and inspect their `index.json`
  companion for native Tachiyomi source reconciliation.
- Keep dependency failures non-destructive and visible in the final summary.
- Accept common GitHub repository links and resolve them to canonical raw
  indexes without removing existing stores first.
- Replace the technical restore matrix with content cards, icons, title counts,
  collapsed details, warnings, and progress feedback.
- Cover the orchestration contracts with unit and shell-jsdom regressions.
- Revalidate the adjacent Library, Activity Center, About, and updater fixes.

## Verification contract

- Focused backup, Sources, Settings, Library, About, and updater tests pass.
- Full unit/jsdom and frontend build pass from the current checkout.
- Suwayomi certification/workflow gates run in disposable state where available.
- `git diff --check` passes before the scoped commit.

## Native-format boundary confirmed with real backups

- LNReader ZIPs contain installed plugin metadata and executable plugin bundles,
  so their repository manifests can be derived without guessing.
- TachiyomiJ2K `.tachibk` protobuf backups contain source IDs/names but no
  repository URL or APK payload. Automatic repository restoration is possible
  only for Epigraph unified exports that explicitly record those URLs.
