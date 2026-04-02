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
