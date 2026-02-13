# Local AI Draft Workspace

Local-first Tauri + React app for AI-assisted marketing draft workflows.

## Features
- 3-pane topic UI:
  - Left: search + topic list + filters
  - Center: topic relationship tree (master/assets/derivatives)
  - Right: edit/review/deploy tabs
- Topic source of truth from local folders: `workspace/inbox/<topic_slug>/`
- Topic status and derivative review/deploy state stored in `topic.json` per topic
- HTML editing with preview, path visibility, and external-open actions
- Deployment log per derivative (destination/date/url/notes)
- SQLite event log and legacy ingestion/export services remain available

## Agent Inbox Contract
Drop files into:

```text
workspace/inbox/<project_slug>/
```

Supported:
- `*.html` (canonical)
- optional `*.md`, `*.txt`
- optional `master.md` or `master.html`
- optional `assets/` or `images/` folder
- optional `task.json`
- optional `topic.json` (app creates/updates this for review/deployment metadata)

Example `task.json`:

```json
{
  "title": "Launch email v1",
  "type": "email",
  "priority": "high",
  "due_date": "2026-02-15",
  "tags": ["launch", "email"],
  "notes": "Focus on conversion CTA"
}
```

## Run
Prereqs:
- Node 20+
- Rust toolchain (`rustup`) for Tauri

```bash
npm install
npm run tauri:dev
```

Path note:
- You can initialize with `./workspace`, `./workspace/inbox`, or a specific topic folder under `inbox`; the app normalizes to workspace root automatically.

## Tests
Rust tests (after Rust installation):

```bash
cd src-tauri
cargo test
```

## Current Limitations
- No cloud sync or direct publish integrations
- Editor is HTML text + preview (block-like workflow via formatting conventions)
- Rust toolchain must be installed to run desktop shell
