# Epigraph release signing

Release signing is intentionally configured without storing credentials in the
repository. The default local files are:

- `%USERPROFILE%\secrets\epigraph-release.p12` (private key store)
- `%USERPROFILE%\secrets\epigraph-keystore.properties` (Gradle properties)

Both files must remain private and must be included in a secure backup. They are
ignored by the repository as defense in depth. Never paste their contents into a
commit, issue, build log or chat. The certificate alias is `epigraph-release`; the
current public certificate fingerprint is
`15:EA:77:B5:EB:98:32:D6:50:9A:1B:B6:00:E5:F2:09:29:1C:C0:BD:10:91:D4:53:CF:D7:5F:3F:77:61:AE:B8`.

To build a store-style APK from PowerShell, run from the repository root:

```powershell
$env:GRADLE_USER_HOME = "$PWD/.gradle-user-home"
$env:GRADLE_OPTS = '-Dorg.gradle.jvmargs=-Xmx2048m -Xss256k -XX:ReservedCodeCacheSize=64m -XX:+TieredCompilation -Dorg.gradle.workers.max=1'
.\gradlew.bat :app:assembleStandardRelease `
  --no-daemon --no-parallel --max-workers=1 --no-configuration-cache `
  --project-prop 'epigraph.requireSigning=true' --console=plain
.\gradlew.bat --stop
```

The fail-closed property `epigraph.requireSigning=true` makes the build stop when
the keystore is absent or incomplete. A CI runner can provide a protected file at
another path with `--project-prop
"epigraph.signing.properties=$env:EPIGRAPH_SIGNING_PROPERTIES"`; the file must define
`storeFile`, `storePassword`, `keyAlias`, `keyPassword` and optional `storeType`.

The output is under
`app/build/outputs/apk/standard/release/`. Verify it before distribution with
the Android SDK `apksigner verify --verbose --print-certs` and `zipalign -c -v 4`.

This key was generated locally for the current Epigraph checkout. If the app is
already registered in Google Play or another store, use the store's existing
upload/release-key process instead of replacing that identity.
