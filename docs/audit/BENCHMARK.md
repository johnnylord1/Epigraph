# Baseline benchmark record

## Build measurements

Environment: Windows, Android Studio JBR 21, Gradle caches initially cold, x86_64 API 36.1 emulator.

| Operation | Measurement |
|---|---|
| v1.13.0 task discovery | 4m54s cold |
| selected baseline `assembleDevDebug` | 3m36s after dependency/cache preparation |
| selected baseline release + unit tests | 7m01s |
| explicit main activity startup reported by `am start -W` | 7.2s warm during emulator post-boot contention |
| Epigraph P0 focused tests + debug APK | 4m05s from changed build graph |
| Epigraph minified standard release + release unit tests | 4m19s warm |
| Epigraph clean-package cold activity start (`am start -W`) | 10.7s during post-install contention |
| Epigraph post-onboarding cold activity start after reinstall | 6.0s |
| Schema 38 migration verification | 43s |
| Contracts/data/books serial focused gate | 2m57s |
| `lintDevDebug` after current foundation | 5m55s; 0 errors |
| Current app release tests + debug APK | 2m05s; 158/158 app tests |
| Current full lint after SAF/PDF/sync routing | 6m04s; 0 errors |

The startup number is not a product benchmark: the emulator had just booted and logcat showed system-wide contention/skipped frames. It is retained only as initial evidence.

## Missing benchmark gates

- Macrobenchmark and Baseline Profile are not configured as Epigraph gates.
- No reproducible fixtures exist yet for 100, 1,000, 5,000, or 10,000 works and 100,000 chapters.
- Search/filter latency and cold-start regression targets are not yet measurable.
- API 24/29 and physical-device Perfetto/LeakCanary runs remain open.

The next benchmark milestone must add deterministic seed fixtures and record median/p95 results, device model, build SHA, thermal state, and build type.
