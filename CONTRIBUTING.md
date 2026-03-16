# Contributing

## Local Setup
1. Install Node 20+ and Rust (`rustup`).
2. Install deps:
```bash
npm ci
```
3. Scaffold workspace parent/workspace structure (once per fresh clone):
```bash
npm run scaffold:workspace -- --parent ./workspace --workspace "Content Shotgun"
```
4. Start app:
```bash
npm run tauri:dev
```

## Architecture Checklist
Before changing behavior, verify your change keeps these contract layers intact:
1. Layer 1: `CLAUDE.md` + `AGENTS.md`
2. Layer 2: workspace/topic folder contract and required file names
3. Layer 3: `content-machine/instructions/**` layered collaboration contract
4. OpenClaw boundary: `skills/openclaw/SKILL.md` is the single bridge skill file

Required topic names are exact:
- `master.md`
- `topic.json`
- `assets/`

## Run and Test
Frontend + contract checks:
```bash
npm run build
npm run test:editor-content
npm run test:workspace-contract
npm run validate:workspace-contract
```

Rust tests:
```bash
cd src-tauri
cargo test --locked
```

## Branching and PR Workflow
1. Create a branch from `main`.
2. Keep PRs focused on one behavior area.
3. Include tests for contract or behavior changes.
4. Run local checks before opening PR.
5. In PR description, include:
   - What changed
   - Why
   - Test evidence
   - Any migration/compatibility notes

## Troubleshooting
- `workspace contract validation failed`:
  - Run `npm run validate:workspace-contract -- --json` and fix listed codes/paths.
- `master article (.md) is required` during topic creation:
  - Select a markdown master source file.
- `protected contract metadata` errors:
  - Use dedicated workspace/topic metadata commands instead of generic file writes.
- Rust build issues on first run:
  - Update toolchain with `rustup update` and retry `cargo test --locked`.
