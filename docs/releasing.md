# Releasing

Desktop and mobile ship on their own schedules. Each build gets its own release,
and one fixed release, `stable`, always holds the current version of both apps.

| Release | Tag | Contents | Marked |
| --- | --- | --- | --- |
| Epigraph Desktop 0.0.8 | `desktop-v0.0.8` | installer, `.sig`, `latest.json` | Pre-release |
| Epigraph Mobile 0.1.0-alpha.7 | `mobile-v0.1.0-alpha.7` | `Epigraph-mobile_<version>_<abi>.apk` | Pre-release |
| Epigraph — current versions | `stable` | current `latest.json` and current APKs | Latest |

The updaters only read the release marked Latest, which is always `stable`:

- Desktop: `releases/latest/download/latest.json` (`src-tauri/tauri.conf.json`). The
  manifest points at the installer inside the `desktop-v…` release.
- Mobile: `releases/latest` for the APK names and the `## Android` section of the notes
  (`AppUpdateChecker.kt`, `GithubRelease.kt`). With betas enabled it reads the 10 newest
  releases and picks the highest APK version.

Old versions stay in their `desktop-v…` / `mobile-v…` releases, which the script marks
Pre-release so the release list sets them apart from `stable`. With betas enabled, the
mobile app labels an update found in one of them as a beta. Publish fewer, batched
releases rather than one per fix. The `v0.0.1`–`v0.0.7` releases predated this split and
were deleted on 2026-10-25; their git tags remain.

All commands below run from the desktop checkout with an authenticated `gh`, and
accept `--dry-run` to print the plan first.

## Desktop

1. Bump the version in `package.json`, `src-tauri/tauri.conf.json` and
   `src-tauri/Cargo.toml`, commit and push.
2. Run the **Build Windows** workflow with that version. It creates the draft
   `desktop-v<version>`.
3. Write the notes in a file (Markdown, `###` headings at most) and publish:

   ```
   node scripts/publish-release.mjs desktop 0.0.8 --notes notes-desktop.md
   ```

   This publishes the draft as a pre-release without marking it Latest, copies its `latest.json` to
   `stable`, rewrites the `## Windows` section of `stable` and marks `stable` Latest.

## Mobile

1. Bump `versionName`/`versionCode`, build the release APKs and sign them
   (`mobile/docs/RELEASE_SIGNING.md`).
2. Put `Epigraph-mobile_<version>_{arm64-v8a,armeabi-v7a,universal}.apk` in one folder.
   Only those three names are published; test and emulator builds are ignored.
3. Publish:

   ```
   node scripts/publish-release.mjs mobile 0.1.0-alpha.7 path/to/apks --notes notes-android.md
   ```

   This creates the pre-release `mobile-v<version>`, replaces the APKs in `stable`, rewrites its
   `## Android` section and marks `stable` Latest.

## Other commands

- `status` shows which desktop and mobile versions `stable` serves.
- `init <tag>` creates `stable` once from an existing combined release, for example
  `init v0.0.7`.
- A version older than the one in `stable` is refused unless `--force` is passed
  (rollback).

## Compatibility

Either app can be released alone. The sync server rejects clients below its minimum
version or with another protocol version (`upgrade_required`). Within one protocol
version, both sides must ignore fields they do not know, so a newer app keeps syncing
with an older one: add fields, never rename or remove them. Changes that break that
need a protocol version bump and a release of both apps.
