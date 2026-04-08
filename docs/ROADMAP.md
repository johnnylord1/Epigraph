# Roadmap

## Current Macro Status
- Shared Library shell refactor: complete
- Shared Library / Settings pass: materially complete on the active path
- Books reader/runtime stabilization: complete and merge-ready
- Splash jank and startup sequencing pass: complete
- Authenticated media sidecar: complete
- Scanlator preference / reader ordering pass: implemented
- FlareSolverr assist + local management pass: implemented and functionally validated
- Local server ownership / corruption-hardening pass: active-path complete for `TEST :4667`
- Profile-selection runtime model + next-launch Settings flow: implemented for built-in `TEST` / `MAIN` profiles

## Closed In This Milestone
- The following streams are now treated as closed unless new evidence appears:
  - Books reader/runtime stabilization
  - splash/runtime boot stabilization
  - authenticated media path
  - scanlator preference flow
  - FlareSolverr local management and real Cloudflare validation on `4667`
  - local server ownership/profile hardening
  - built-in profile selection with restart-based semantics

## Active Next Step
- Recover the lost library state in a sandbox after the runtime hardening + profile-selection pass
- Keep the isolated monitor 3 audit harness available for future runtime checks

## Near-Term Follow-Up
- Optionally add a small FlareSolverr install/update flow if it can stay predictable and compact
- Keep refining the shared desktop polish without widening scope into server bundling or runtime redesign
- If Books gets revisited later, keep it to small non-blocking polish such as very-large-EPUB progress labels; do not reopen runtime/protocol work without new evidence
- Do not widen profile selection into live hot-switching; keep the shipped path as next-launch only
- If profile selection grows later, prefer startup-time flows before any runtime server handoff ideas

## Deferred / Research Tracks
- Sync / Suwayomi multi-device architecture is still a research track and has not been merged into the runtime plan
- Docker-managed FlareSolverr is still optional and should remain secondary to the local/external flow
- Bundling FlareSolverr inside Aethon is explicitly deferred

## Reference
- Shared Library shell implementation record: [`docs/LIBRARY_SHARED_SHELL_REFACTOR.md`](docs/LIBRARY_SHARED_SHELL_REFACTOR.md)
