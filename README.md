# Content Shotgun

Content Shotgun is a local-first Tauri + React app for workspace/topic content production with deterministic folder contracts.

## Canonical Contract
Layer 1 (repo identity/routing):
- `CLAUDE.md` (canonical)
- `AGENTS.md` (compatibility pointer)

Layer 2 (runtime workspace contract):
- `<workspace-parent>/instructions.md`
- `<workspace-parent>/workspaces/<workspace-slug>/knowledge/workspace.md`
- `<workspace-parent>/workspaces/<workspace-slug>/inbox/<topic-slug>/master.md`
- `<workspace-parent>/workspaces/<workspace-slug>/inbox/<topic-slug>/topic.json`
- `<workspace-parent>/workspaces/<workspace-slug>/inbox/<topic-slug>/assets/`

Layer 3 (Content Machine layered collaboration instructions):
- `content-machine/instructions/01-global/INSTRUCTIONS.md`
- `content-machine/instructions/02-workspace/INSTRUCTIONS.md`
- `content-machine/instructions/03-topic/INSTRUCTIONS.md`

OpenClaw skill boundary:
- `skills/openclaw/SKILL.md` (single bridge skill only)

## Quick Start
Prerequisites:
- Node 20+
- Rust toolchain (`rustup`)

Install dependencies:
```bash
npm ci
```

Scaffold a workspace parent + workspace contract:
```bash
npm run scaffold:workspace -- --parent ./workspace --workspace "Content Shotgun"
```

Run the app:
```bash
npm run tauri:dev
```

## Commands
- `npm run scaffold:workspace`
  - Creates canonical workspace parent/workspace structure.
- `npm run validate:workspace-contract`
  - Validates Layer 1 + Layer 2 with deterministic error codes.
- `npm run build`
  - TypeScript + Vite build.
- `npm run test:editor-content`
  - Frontend contract/unit tests.
- `npm run test:workspace-contract`
  - Workspace scaffold/validator test suite.
- `cd src-tauri && cargo test --locked`
  - Rust tests.

## CI Gates
PR CI runs:
- Frontend build
- Frontend/unit tests
- Workspace contract test suite
- Rust tests (`cargo test --locked`)

## Architecture Notes
- Workspace creation/bootstrap materializes required contract files and folders.
- Topic creation always establishes `master.md`, `topic.json`, and `assets/`.
- Protected contract files are blocked from unsafe rename/delete/replace flows.

## Contributor Workflow
See `CONTRIBUTING.md` for setup, branch/PR workflow, and troubleshooting.
