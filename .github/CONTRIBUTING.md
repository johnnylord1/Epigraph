# Contributing to Epigraph

Thanks for improving Epigraph. Keep changes focused, explain the user impact, and avoid mixing unrelated refactors with a feature or fix.

## Before you start

1. Search existing issues and pull requests.
2. Open an issue for a large behavior change or a change to persisted data, pairing, backups, source contracts, or the managed runtime.
3. Branch from `main` for desktop work. Android work belongs on the `mobile` branch.
4. Never commit credentials, local profiles, downloaded content, signing keys, or private repository URLs.

## Desktop setup

Install Node.js, pnpm 10.33.0, Rust through rustup, the Tauri v2 prerequisites, and Microsoft Edge WebView2 on Windows.

```bash
pnpm install
pnpm tauri:dev
```

A development (debug) build keeps its own data in `%LOCALAPPDATA%\Epigraph-dev`
(or `EPIGRAPH_DEV_DATA_DIR`), with its own WebView profile and sync Core on port
4787, so it never reads or changes the library of an installed release. Only
the local Suwayomi ports (4567 and 4667) are shared: close the installed app
before reading manga in a development build.

## Verification

Run the checks that cover your change. The normal desktop baseline is:

```bash
pnpm test:unit
pnpm test:browser
cargo test --manifest-path src-tauri/Cargo.toml
git diff --check
```

Changes to themes, sources, Syncd, Suwayomi, installers, or release infrastructure require their focused certification commands. Run the full gate before release-oriented work:

```bash
pnpm release:verify
```

## Pull requests

- Keep one logical change per pull request.
- Include screenshots for visible UI changes in the Nocturne theme and any other affected themes.
- Document manual checks for native behavior that automated tests cannot exercise.
- Preserve user libraries, profiles, backups, and compatibility boundaries.
- Update `CHANGELOG.md` when users will observe the change.
- Use descriptive commits such as `fix: restore source count after repository refresh`.

By contributing, you agree that your contribution is licensed under the repository's [Apache License 2.0](../LICENSE).
