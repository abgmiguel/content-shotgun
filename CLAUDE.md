# Repository Contract (Canonical)

This file is the canonical identity and routing contract for contributors and AI agents.
If any other document conflicts with this file, this file wins.

## Identity
- Project: Content Shotgun
- Goal: Local-first workspace/topic content production with deterministic folder contracts.
- Scope for this contract: repository layout, runtime workspace routing, file naming, and canonical source rules.

## Read Order
1. This file: `/CLAUDE.md`
2. Content Machine layered instructions:
   - `/content-machine/instructions/01-global/INSTRUCTIONS.md`
   - `/content-machine/instructions/02-workspace/INSTRUCTIONS.md`
   - `/content-machine/instructions/03-topic/INSTRUCTIONS.md`
3. Runtime global instructions: `<workspace-parent>/instructions.md`
4. Workspace brief: `<workspace-parent>/workspaces/<workspace-slug>/knowledge/workspace.md`
5. Topic contract files:
   - `<workspace-parent>/workspaces/<workspace-slug>/inbox/<topic-slug>/master.md`
   - `<workspace-parent>/workspaces/<workspace-slug>/inbox/<topic-slug>/topic.json`
   - `<workspace-parent>/workspaces/<workspace-slug>/inbox/<topic-slug>/assets/`

## Routing Map
- Repository root contract:
  - `/CLAUDE.md` (canonical)
  - `/AGENTS.md` (compatibility pointer only)
  - `/content-machine/instructions/`
  - `/skills/openclaw/SKILL.md` (single OpenClaw bridge skill)
- Runtime workspace parent:
  - `<workspace-parent>/instructions.md`
  - `<workspace-parent>/workspaces/`
- Workspace root:
  - `workspace.json`
  - `knowledge/workspace.md`
  - `inbox/`
  - `projects/`
  - `exports/`
  - `data/app.db`
- Topic root:
  - `master.md` (required, exact name)
  - `topic.json` (required, exact name)
  - `assets/` (required folder, exact name)

## Canonical vs Reference-Only
Canonical:
- `/CLAUDE.md`
- `/AGENTS.md` (pointer only)
- `/content-machine/instructions/**`
- `/skills/openclaw/SKILL.md`
- Runtime files created by scaffold/bootstrap under `<workspace-parent>/...`
- Contract templates and scripts under `/contracts` and `/scripts`

Reference-only:
- `/README.md`
- `/CONTRIBUTING.md`
- `/docs/**`

Reference-only docs may explain behavior but must not redefine canonical contract rules.

## Naming Conventions
- Workspace folder: `<workspace-slug>` (kebab-case)
- Topic folder: `<topic-slug>` (kebab-case)
- Required topic contract names are exact and case-sensitive:
  - `master.md`
  - `topic.json`
  - `assets/`

## Safety Rules
- Do not rename or delete required topic contract files/folders via generic file operations.
- Use dedicated master update flows for `master.md`.
- Treat `topic.json` as metadata contract state, not a free-form content file.
