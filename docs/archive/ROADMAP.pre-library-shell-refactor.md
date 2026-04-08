# Roadmap

## Current Macro Status
- Phase 0: complete
- Phase 1: complete
- Phase 2: baseline achieved; desktop stabilization is now continuing through focused desktop polish and recovery work
- Phase 3: blocked and isolated in `android-spike-blocked` until the Android shell is fully validated
- Phase 4: not started as a macro shell phase
- Phase 5: not started as the novel-access macro phase
- Phase 6: not started

## Phase 0: Repo Foundation + Docs
- Objective: clone the upstream project, inspect structure, and establish the initial documentation baseline.
- Out of scope: feature work, rebrands in code, refactors, dependency changes.
- Success condition: repo is cloned, docs scaffold exists, and Phase 0 checkpoints are recorded.

## Phase 1: Safe Rebrand
- Objective: apply a careful product rebrand in approved surface areas without destabilizing behavior.
- Out of scope: new features, architecture changes, reader refactors.
- Success condition: approved branding surfaces reflect Aethon while core behavior remains unchanged.

## Phase 2: Desktop Stabilization
- Objective: improve confidence in the desktop baseline through targeted fixes and verification.
- Out of scope: Android support, multi-media expansion, major subsystem rewrites.
- Success condition: desktop build and core flows are stable enough for continued iteration.
- Status: the stable desktop line exists and is the active implementation track; current work is still landing here as smaller desktop-focused hardening/polish phases.

## Phase 3: Android Bootstrap
- Objective: investigate and begin the minimum viable Android project bootstrap when explicitly scheduled.
- Out of scope: broad mobile feature parity, unrelated desktop rewrites.
- Success condition: Android work has a validated starting point and clear implementation boundaries.
- Status: blocked on shell/runtime validation and isolated outside `main`.

## Phase 4: Product Shell For Manga / Novels / Books
- Objective: design the high-level product shell that can eventually host multiple media types.
- Out of scope: full reader implementations for every medium.
- Success condition: a clear shell strategy exists without destabilizing the manga-first experience.
- Status: not started as a dedicated macro phase.

## Phase 5: Novel Access Strategy
- Objective: define how novel access should work from a product and technical standpoint.
- Out of scope: complete novel reading implementation.
- Success condition: the access strategy is documented, constrained, and ready for phased execution.
- Status: not started. Current Phase 5A references in `STATUS.md` are desktop cleanup labels, not this roadmap macro phase.

## Phase 6: EPUB/PDF Investigation
- Objective: investigate EPUB and PDF support feasibility, constraints, and integration options.
- Out of scope: shipping EPUB/PDF features by default.
- Success condition: findings and recommendations are documented for a later decision.
- Status: not started.
