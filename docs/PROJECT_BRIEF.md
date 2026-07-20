# Project Brief

## What Aethon Is
Aethon is a new product foundation built from the upstream Aethon codebase.

## Upstream Base
- Base repository: Aethon
- Purpose in Phase 0: establish a clean fork foundation without changing application behavior

## Current Mission
Keep the desktop Aethon line stable while documenting progress clearly and shipping bounded desktop improvements on top of that baseline.

## Long-Term Direction
Aethon is manga-first in the near term, with room to explore other media formats later once the desktop foundation is stable.

## Current Reality
- The repo/documentation foundation is established.
- The safe Aethon rebrand and desktop stabilization baseline are already in place.
- Active work is still desktop-first and includes library/detail continuity, reader fallback paths, setup-state refresh flow, tracking ergonomics, and backup/restore hardening.
- Aethon Mobile is a separate Flutter/Sorayomi product and is not implemented or packaged from this repository.
- This desktop app may host the shared Suwayomi and Aethon Syncd services consumed by mobile, while mobile UI and platform code remain isolated in its own workspace.

## Repository Boundary
This repository does not contain Android/iOS UI, mobile packaging, or a Tauri mobile shell. Mobile work belongs exclusively to the separate Aethon Mobile workspace. PC-hosted Core services, shared protocol contracts, pairing, and secure LAN access remain valid desktop responsibilities.
