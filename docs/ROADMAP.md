# Roadmap

## Completed Phases

### Phase 0: Repository Foundation
- Objective: clone the upstream project, inspect structure, and establish the initial documentation baseline.
- Out of scope: feature work, code rebrands, refactors, dependency changes.
- Success condition: repo is cloned, docs scaffold exists, and Phase 0 checkpoints are recorded.

### Phase 1: Safe Visible Rebrand
- Objective: apply a careful product rebrand in approved visible surfaces without destabilizing behavior.
- Out of scope: new features, architecture changes, reader refactors, risky identifier changes.
- Success condition: approved display-level branding surfaces reflect Aethon while core behavior remains unchanged.

### Phase 2: Desktop Validation Baseline
- Objective: improve confidence in the desktop baseline through targeted validation and workflow documentation.
- Out of scope: Android support, media expansion, major subsystem rewrites.
- Success condition: desktop build expectations and local developer workflow are documented and validated.

### Phase 3A: Audit Low-Risk Fixes
- Objective: fix the two clear audit-confirmed runtime issues with minimal blast radius.
- Out of scope: broad UI cleanup, feature work, architecture changes.
- Success condition: Settings closes on route navigation and the native window title resolves to Aethon.

### Phase 3B: Runtime Identity Cleanup
- Objective: align the desktop runtime identity with Aethon in safe binary/runtime surfaces.
- Out of scope: updater changes, packaging rewrites, platform identifier migration.
- Success condition: the desktop runtime launches as `aethon.exe` and safe runtime identity text is updated.

### Phase 3C: Safe Metadata Identity Cleanup
- Objective: clean the remaining low-risk descriptive identity metadata in safe distribution surfaces.
- Out of scope: Discord app registration changes, updater wiring, app ids, install paths, app-data migration.
- Success condition: descriptive Linux/AppStream metadata reflects Aethon without changing launch-critical distribution wiring.

## Deferred Phase

### Phase 3D: Risky Identity Audit
- Objective: audit the remaining risky identity surfaces tied to updater behavior, platform identifiers, and app-data paths.
- Out of scope: implementation of those risky changes, onboarding UX, Android work.
- Success condition: the risky identity surfaces are documented clearly enough for a later distribution/release phase decision.
- Status: deferred for later distribution/release work and not the next active implementation phase.

## Next Active Phase

### Phase 4: Onboarding / Setup UX
- Objective: improve first-run onboarding and setup guidance so the desktop product is easier to configure successfully.
- Out of scope: Android bootstrap, risky packaging cleanup, reader refactors, media expansion.
- Success condition: a scoped onboarding/setup UX phase is defined and implemented without changing stable reader or backend behavior.
- Status: next active product phase.

## Later Macro Phases

### Phase 5: Android Bootstrap
- Objective: investigate and begin the minimum viable Android project bootstrap when explicitly scheduled.
- Out of scope: broad mobile feature parity, unrelated desktop rewrites.
- Success condition: Android work has a validated starting point and clear implementation boundaries.

### Phase 6: Product Shell For Manga / Novels / Books
- Objective: design the high-level product shell that can eventually host multiple media types.
- Out of scope: full reader implementations for every medium.
- Success condition: a clear shell strategy exists without destabilizing the manga-first experience.

### Phase 7: Novel Access Strategy
- Objective: define how novel access should work from a product and technical standpoint.
- Out of scope: complete novel reading implementation.
- Success condition: the access strategy is documented, constrained, and ready for phased execution.

### Phase 8: EPUB / PDF Investigation
- Objective: investigate EPUB and PDF support feasibility, constraints, and integration options.
- Out of scope: shipping EPUB/PDF features by default.
- Success condition: findings and recommendations are documented for a later decision.
