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

## Certification completed on 2026-09-01

- Release executable SHA-256:
  `9f993f2554ecfc61b451332cf310f5129d1b3e5f2660dc20d991ea5b78bf3748`.
- J2K restored 686 Library titles into a fresh Suwayomi v2.3 profile; Yokai
  restored 684. Both counts were checked through the visible restore flow and
  against the final GraphQL Library.
- LNReader restored 9 novels, 6,936 chapters, 2 repositories, and 19 plugins in
  an isolated desktop profile.
- Browse > Sources converted `https://github.com/keiyoushi/extensions` to
  `https://raw.githubusercontent.com/keiyoushi/extensions/repo/index.pb` and
  retained it after restart.
- The Akuma extension APK installed 27 sources, remained singular after
  reinstall/restart, and ordinary, truncated, and renamed-ZIP APKs were rejected
  without changing inventory.
- EPUB/PDF export, restart, clean-profile restore, and corrupt-backup rollback
  completed in isolated WebView2 profiles.

## Native-format boundary confirmed with real backups

- LNReader ZIPs contain installed plugin metadata and executable plugin bundles,
  so their repository manifests can be derived without guessing.
- Official Mihon protobuf backups may contain optional extension stores in top
  field 106. The exact J2K and Yokai fixtures used here do not contain that
  field, and no native format contains APK payloads. Source IDs remain intact;
  stores are restored only when present and explicitly approved.
