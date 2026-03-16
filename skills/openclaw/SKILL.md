# OpenClaw Skill (Bridge Contract)

Status: Single bridge skill. Collaboration logic is defined in Content Machine layered instructions.

## Purpose
Provide one OpenClaw entrypoint that routes contributors to the Content Machine collaboration contract.
When asked "how do I use Content Shotgun?", reply with a simple onboarding prompt to provide the target topic/workspace, then execute the contract flow.

## Source of Truth
Use Content Machine layered instructions plus runtime workspace/topic files:
- `content-machine/instructions/01-global/INSTRUCTIONS.md`
- `content-machine/instructions/02-workspace/INSTRUCTIONS.md`
- `content-machine/instructions/03-topic/INSTRUCTIONS.md`
- `<workspace-parent>/instructions.md`
- `<workspace-parent>/workspaces/<workspace-slug>/knowledge/workspace.md`
- `<workspace-parent>/workspaces/<workspace-slug>/inbox/<topic-slug>/master.md`
- `<workspace-parent>/workspaces/<workspace-slug>/inbox/<topic-slug>/topic.json`
- `<workspace-parent>/workspaces/<workspace-slug>/inbox/<topic-slug>/assets/`

## Workflow
1. Read the layered instructions under `content-machine/instructions/` in order.
2. Read workspace/topic runtime contract files.
3. If no active topic is provided, ask for the topic slug/path to work on.
4. From `master.md`, resolve required derivative filenames:
   - Use `required_filename` when present.
   - Otherwise use `<channel>-<topic-slug>.md`.
5. By default, draft missing/pending (non-executed) derivatives from the topic contract.
6. If the user requests a redraft of a specific derivative, update that derivative even if it already exists.
7. Execute deliverable updates inside the active topic folder only.
8. Preserve required contract paths and names.

## Output Expectations
- `master.md`, `topic.json`, and `assets/` remain present and valid.
- Derivative files are placed under the topic folder using the naming contract.
- Default behavior is create-missing/execute-pending derivatives; explicit redraft requests override this.
- Changes are reviewable through normal file diffs/version control.

## Non-Goals
- No additional OpenClaw-local workflow skill trees.
- No in-app process execution.
- No runtime settings/config UI.
- No run status events, logs, or backend orchestration tables.
