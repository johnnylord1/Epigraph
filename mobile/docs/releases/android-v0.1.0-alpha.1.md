# Epigraph Mobile 0.1.0-alpha.1

First Android pre-release of Epigraph: one library and one set of readers for comics, novels,
EPUB and PDF, synchronized with Epigraph on the desktop over your local network.

This is an alpha. Create a backup before you update, and report anything that breaks.

## Which APK to install

| File | Use it on |
| --- | --- |
| `app-standard-arm64-v8a-release.apk` | Most phones and tablets from the last several years |
| `app-standard-armeabi-v7a-release.apk` | Older 32-bit phones |
| `app-standard-x86_64-release.apk` / `app-standard-x86-release.apk` | Emulators and x86 Chromebooks |
| `app-standard-universal-release.apk` | Any device, if you are unsure (larger download) |

- Android 7.0 (API 24) or newer.
- Package `app.epigraph.mobile`, version `0.1.0-alpha.1` (code 1). It installs next to Hayai,
  Yokai or Tachiyomi instead of replacing them; move your library with a backup.
- Signing certificate SHA-256:
  `15:EA:77:B5:EB:98:32:D6:50:9A:1B:B6:00:E5:F2:09:29:1C:C0:BD:10:91:D4:53:CF:D7:5F:3F:77:61:AE:B8`

### File checksums (SHA-256)

```
3019720b4d338d87ff4ab6857979439e5c725d0062698f78081caf70b1b20605  app-standard-arm64-v8a-release.apk
faa987b1be5cd54d4332d6bd3ccb32287ac3fb79bf2236a769826fc6afff0a64  app-standard-armeabi-v7a-release.apk
089c5c7bc347524e789429b8364917d78973564fe5859f68594199a7d83fef72  app-standard-universal-release.apk
a284de0f536d05a9c4706a5b6de465e2ac2386f91c308afa2eb8bc7cafade5f7  app-standard-x86-release.apk
9d8f0e0eb78f4bd3eda804d994956bf9b53cbf748a3063cad99fbb0abd01b378  app-standard-x86_64-release.apk
```

## Highlights

- **One library** for comics, novels, EPUB and PDF, with a Comics / Books & novels switch and
  categories.
- **Readers**: comics (paged and webtoon), novels (quotes, search in chapter, find-and-replace,
  auto-scroll, read-aloud), EPUB (table of contents, themes, typography, read-aloud) and PDF
  (original pages or reflowed text).
- **Epigraph Core sync**: pair with the desktop by PIN, QR code or pairing bundle. Library,
  progress, categories and tracking sync through an outbox, and the app never shows "synced"
  while changes are still waiting.
- **Backups** use `.epigraphbk`. Restore also accepts `.tachibk`, `.proto.gz` and JSON backups.
- **Nocturne design** shared with the desktop app, with one details page for every kind of title.

The full list is in [CHANGELOG.md](../../CHANGELOG.md).

## Privacy

- Backups and sync never contain cookies, sessions or passwords.
- Tracker logins travel only to your paired Core, sealed with the Android Keystore, and are wiped
  when you unpair.
- No analytics or crash-reporting service is included.
- Extensions are always installed through Android's visible package installer.

## Known limitations

- Backups store your library, progress and settings, but not the EPUB and PDF files themselves.
  After restoring, open each book and choose **Relink file** to point it at the original file.
- Novels restored from a backup made before this version appear under Comics until you install
  their plugin. Backups made with this version record which titles are novels.
- PDF text selection and OCR are not available yet.
- Tracker sync turns on only when the paired Core supports it.
- PIN pairing finds the desktop with multicast DNS. On networks that block it, pair with the QR
  code or the pairing bundle instead.
