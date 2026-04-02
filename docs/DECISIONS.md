# Decisions

## Template
| Date | Decision | Rationale | Status |
| --- | --- | --- | --- |
| YYYY-MM-DD | Short decision | Why this choice was made | Active |

## Log
| Date | Decision | Rationale | Status |
| --- | --- | --- | --- |
| 2026-04-01 | Upstream base is Moku | Aethon starts from the existing Moku repository to preserve a working baseline. | Active |
| 2026-04-01 | Work will happen in small phases | Small milestones reduce risk and keep scope controlled. | Active |
| 2026-04-01 | No feature expansion in Phase 0 | Phase 0 is limited to repository setup and documentation scaffolding. | Active |
| 2026-04-01 | No code refactor before the documentation baseline exists | The team needs a shared foundation before changing stable systems. | Active |
| 2026-04-01 | Phase 1 rebrand is limited to low-risk display surfaces | Product naming can change in visible UI and metadata while risky identifiers, integrations, and behavior stay intact. | Active |
| 2026-04-01 | Phase 2 uses `npm exec pnpm` as the validated fallback desktop path | The current machine has `node` and `npm` but not global `pnpm`, and the fallback successfully installed dependencies and built the frontend without changing repo behavior. | Active |
| 2026-04-01 | Native desktop validation remains blocked by missing Windows toolchain prerequisites | WebView2 is installed in the current environment, but Rust via `rustup` and Visual Studio Build Tools with MSVC + Windows SDK are still required before `tauri dev` can be validated end-to-end. | Active |
| 2026-04-01 | Phase 3A prioritizes two audit-confirmed runtime fixes before broader onboarding work | The Settings overlay persistence and leftover native window title are both reproducible, low-risk defects that can be fixed without changing product behavior or expanding scope. | Active |
| 2026-04-01 | Phase 3B prioritizes safe technical identity cleanup before onboarding | Runtime identity still leaked `Moku` through the Rust binary name and Discord activity text, so the safest remaining identity surfaces were cleaned before broader onboarding or distribution work. | Active |
| 2026-04-02 | Phase 3C prioritizes only safe Discord and distribution identity cleanup before onboarding | The remaining low-risk leaks are descriptive packaging metadata, while Discord application identity, updater wiring, app ids, and data paths still depend on external ownership or higher-risk distribution changes. | Active |
| 2026-04-02 | Roadmap numbering was updated to separate cleanup subphases from macro product phases | Phase 3 had become ambiguous because `3A-3D` were active desktop cleanup steps while the old roadmap also reserved `Phase 3` for Android. The roadmap now preserves Phase 3D as deferred and promotes Phase 4 onboarding/setup UX as the next active product phase ahead of riskier identity/distribution work. | Active |
| 2026-04-02 | Phase 4A focuses on setup-state clarity before any automatic repo seeding | Fresh profiles currently feel broken even when the app and server are healthy, so the first onboarding step is to detect missing setup states and explain the next action clearly before introducing any repo auto-configuration. | Active |
| 2026-04-02 | Phase 4B adds explicit recommended and manual repo setup instead of silent auto-seeding | The first actionable onboarding step should reduce friction without mutating server configuration behind the user's back, so Aethon now offers a one-click recommended repo path plus a visible manual repo-manager path. | Active |
| 2026-04-02 | Phase 4C focuses on extension onboarding after repo setup | Once a repository exists, the next user confusion is the gap between “repo configured” and “content extension installed,” so this phase clarifies that distinction and points users toward installing a usable extension before deeper search/source polish. | Active |
