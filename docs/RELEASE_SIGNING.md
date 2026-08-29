# Epigraph release signing

Release signing is intentionally configured without storing credentials in the
repository. The default local files are:

- `%USERPROFILE%\secrets\aethon-release.p12` (private key store)
- `%USERPROFILE%\secrets\aethon-keystore.properties` (Gradle properties)

Both files must remain private and must be included in a secure backup. They are
ignored by the repository as defense in depth. Never paste their contents into a
commit, issue, build log or chat. The certificate alias is `aethon-release`; the
current public certificate fingerprint is
`4D:DB:42:D5:55:CA:80:3C:9D:66:FB:EB:EB:56:51:E7:1C:08:72:36:37:18:B8:EF:15:90:B8:F9:3F:0E:50:E4`.

To build a store-style APK from PowerShell, run from the repository root:

```powershell
$env:GRADLE_USER_HOME = "$PWD/.gradle-user-home"
$env:GRADLE_OPTS = '-Dorg.gradle.jvmargs=-Xmx2048m -Xss256k -XX:ReservedCodeCacheSize=64m -XX:+TieredCompilation -Dorg.gradle.workers.max=1'
.\gradlew.bat :app:assembleStandardRelease `
  --no-daemon --no-parallel --max-workers=1 --no-configuration-cache `
  --project-prop 'aethon.requireSigning=true' --console=plain
.\gradlew.bat --stop
```

The fail-closed property `aethon.requireSigning=true` makes the build stop when
the keystore is absent or incomplete. A CI runner can provide a protected file at
another path with `--project-prop
"aethon.signing.properties=$env:AETHON_SIGNING_PROPERTIES"`; the file must define
`storeFile`, `storePassword`, `keyAlias`, `keyPassword` and optional `storeType`.

The output is under
`app/build/outputs/apk/standard/release/`. Verify it before distribution with
the Android SDK `apksigner verify --verbose --print-certs` and `zipalign -c -v 4`.

This key was generated locally for the current Epigraph checkout. If the app is
already registered in Google Play or another store, use the store's existing
upload/release-key process instead of replacing that identity.
