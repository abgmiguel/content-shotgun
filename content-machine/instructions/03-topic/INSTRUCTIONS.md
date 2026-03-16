# Layer 3: Topic Contract

## Scope
Topic-level content generation and derivative execution rules.

## Required Inputs
- `<workspace-parent>/workspaces/<workspace-slug>/inbox/<topic-slug>/master.md`
- `<workspace-parent>/workspaces/<workspace-slug>/inbox/<topic-slug>/topic.json`
- `<workspace-parent>/workspaces/<workspace-slug>/inbox/<topic-slug>/assets/`

## Execution Rules
1. Treat `master.md` deliverables as the output contract.
2. Respect `required_filename` when present.
3. If `required_filename` is blank, use `<channel>-<topic-slug>.md`.
4. If no active topic is provided, request the topic slug/path before drafting.
5. Create only non-executed derivatives by default:
   - Create required derivatives that are missing.
   - Optionally create explicitly pending derivatives when metadata marks them pending.
   - Do not overwrite existing completed derivatives unless explicitly requested.
6. If the user explicitly requests a redraft of a specific derivative, update that derivative.
7. Do not write inside `assets/`.
8. Include sources for externally verifiable claims.
