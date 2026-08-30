# Repository Presentation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the Epigraph GitHub landing page into a concise Nocturne product showcase with a direct installation path and complete contributor entry points.

**Architecture:** Keep the repository and documentation structure intact. Replace the README's long feature inventory with a short product narrative, two visual assets, release links, capability groups, and documentation entry points. Add standard GitHub community files without changing application behavior, release artifacts, or legal attribution.

**Tech Stack:** GitHub Markdown, repository-local PNG/WebP assets, GitHub community templates, existing pnpm/Tauri commands.

**Spec:** `README.md`, `AGENTS.md`, `docs/desktop-features.md`, and the repository presentation audit from 2026-08-30.

## Global Constraints

- Preserve the Epigraph name, droplet mark, Apache-2.0 license, branch names, and existing documentation URLs.
- Use the Nocturne dark palette with one restrained lavender accent.
- Use at most two prominent images in the README.
- Do not add claims that cannot be verified from the repository.
- Keep the release `v0.0.1` unchanged.
- Do not alter application source code or runtime behavior.

---

### Task 1: Nocturne repository cover

**Files:**
- Create: `docs/assets/epigraph-readme-cover.webp`

**Interfaces:**
- Consumes: `src-tauri/icons/icon.png` as the canonical droplet reference.
- Produces: one 16:9 cover referenced by the root README.

- [x] Generate a dark, minimal cover with exact Epigraph wordmark text and no product-feature clutter.
- [x] Convert the selected output to WebP without changing its aspect ratio.
- [x] Inspect the final asset at full size and at README scale.

### Task 2: Root README redesign

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: `docs/assets/epigraph-readme-cover.webp`, the existing product screenshot, release URL, and documentation paths.
- Produces: the repository's primary product and onboarding page.

- [x] Replace the opening with the project name, one concrete value statement, the Nocturne cover, and at most three useful badges.
- [x] Put the Windows download and build-from-source paths before detailed architecture.
- [x] Condense capabilities into Comics, Books, and Core without repeating the full feature catalog.
- [x] Preserve links to desktop features, screenshots, roadmap, mobile branch, license, and attribution.
- [x] Scan visible copy for unsupported claims, broken grammar, and em-dash characters.

### Task 3: GitHub community surface

**Files:**
- Create: `.github/CONTRIBUTING.md`
- Create: `.github/SECURITY.md`
- Create: `.github/CODE_OF_CONDUCT.md`
- Create: `.github/ISSUE_TEMPLATE/bug_report.yml`
- Create: `.github/ISSUE_TEMPLATE/feature_request.yml`
- Create: `.github/ISSUE_TEMPLATE/config.yml`
- Create: `.github/pull_request_template.md`

**Interfaces:**
- Consumes: existing project commands and repository branches.
- Produces: GitHub contribution, disclosure, issue, and pull-request entry points.

- [x] Add contribution instructions using the repository's actual pnpm, Vitest, Rust, and release commands.
- [x] Add a private-first security disclosure policy without inventing an email address.
- [x] Add a concise Contributor Covenant-compatible conduct policy.
- [x] Add structured issue forms and a reviewable pull-request checklist.

### Task 4: Verification and publication

**Files:**
- Verify: `README.md`, `.github/**`, `docs/assets/epigraph-readme-cover.webp`

**Interfaces:**
- Consumes: all preceding deliverables.
- Produces: one documentation-only commit on `main`.

- [x] Validate Markdown links and local asset targets.
- [x] Validate YAML issue forms.
- [x] Run `git diff --check` and scan the staged diff for secrets.
- [x] Inspect the final README rendering and both visual assets.
- [x] Commit as one documentation change, push the working branch, then fast-forward `main` without force.
