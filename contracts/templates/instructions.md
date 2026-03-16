# Global Instructions

## Purpose
This is the canonical runtime workflow contract for all workspaces under this workspace parent.
It defines execution boundaries, read order, and failure behavior for contributors and AI agents.

## Scope
- Applies to `<workspace-parent>/workspaces/`.
- Canonical collaboration artifacts:
  - `<workspace-parent>/instructions.md`
  - `<workspace-parent>/workspaces/<workspace-slug>/knowledge/workspace.md`
  - `<workspace-parent>/workspaces/<workspace-slug>/inbox/<topic-slug>/master.md`
  - `<workspace-parent>/workspaces/<workspace-slug>/inbox/<topic-slug>/topic.json`
  - `<workspace-parent>/workspaces/<workspace-slug>/inbox/<topic-slug>/assets/`

## Required Read Order
1. Global instructions (`instructions.md`)
2. Workspace brief (`knowledge/workspace.md`)
3. Relevant supporting files in `knowledge/`
4. Topic brief (`master.md`)
5. Topic metadata (`topic.json`)
6. Topic assets (`assets/`)

## Required Workflow
1. Resolve active workspace and topic.
2. Read all required files in the order above.
3. Create only missing or explicitly requested derivatives.
4. Run web research before drafting for external/factual topics.
5. Add citations for externally verifiable claims.
6. Write outputs only inside the active topic folder.

## Mutation Rules
Allowed:
- Create or update derivative files in active topic folder.

Prohibited unless explicitly requested:
- Writing outside active topic folder.
- Deleting, renaming, or moving required topic contract files.
- Editing `assets/` contents as part of derivative generation.
- Mutating `master.status` or `deployedChannels` in `topic.json`.

## Completion Rule
A run is complete when requested deliverables exist in the active topic folder, citations are present when needed, and unrelated files were not modified.
