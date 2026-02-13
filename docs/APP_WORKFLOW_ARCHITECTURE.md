# App Workflow Architecture (Human + AI Agent)

## High-Level Model
The app is local-first and topic-centric.

Each topic is a folder under:

- `workspace/inbox/<topic-slug>/`

The app scans filesystem state and renders three panes:

1. Left: Topics list + filters
2. Center: Topic relationship tree
3. Right: Edit / Review checklist / Deploy log

## Topic Structure
Recommended topic layout:

- `master.md` or `master.html`
- `assets/` for shared assets
- Derivatives (`blog-*`, `email-*`, `social-*`, etc.)
- `topic.json` (review/deploy metadata per derivative)

## Relationship Semantics
- **Master**: strategy/source document for the topic.
- **Assets**: belong to topic and are shared by master + derivatives.
- **Derivatives**: publishable outputs grouped by type.

## Status Logic
### Per derivative
- `New`: created by agent, not yet reviewed
- `Review`: human opened/manually set review state
- `Ready`: approved by human
- `Deployed`: at least one deployment log entry exists

### Per topic (computed)
- `Needs Review`: any derivative is `New` or `Review`
- `Ready`: all derivatives are `Ready` or `Deployed`
- `Deployed`: all derivatives are `Deployed`

## Human Workflow
1. Agent writes/updates files in topic folder.
2. Human opens topic in app.
3. Human reviews master and derivatives in `Edit` tab.
4. Human sets checklist state in `Review checklist` tab.
5. Human logs destination/date/url in `Deploy log` tab.

## Deployment Rules
- Deployment is tracked **per derivative**, not per topic.
- One derivative can have multiple deployments.

## Built-In Task Views
Global filters provide task management:

- All derivatives needing review
- Ready but not deployed
- Deployed to Klaviyo in last 30 days

## UX Principles
- Files are real local files, never hidden in opaque storage.
- File path is always visible in editor.
- Open in Finder/external editor is first-class.
