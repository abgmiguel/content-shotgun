# External Local AI Agent Instructions

## Purpose
Generate derivative marketing assets for one topic folder so the human reviewer can quickly review, approve, and deploy in the local app.

## Folder Contract
For each topic, write files under:

- `workspace/inbox/<topic-slug>/`

Inside a topic folder:

- `master.md` or `master.html` (optional but preferred brief/source)
- `assets/` (images and reusable files)
- Derivatives (`*.html`, `*.md`, or `*.txt`)
- `topic.json` is managed by the app (do not overwrite unless instructed)

## Naming Rules
Use explicit derivative names that encode channel/type.

Examples:

- `blog-launch-announcement.html`
- `email-launch-welcome.html`
- `social-linkedin-launch-1.html`
- `social-instagram-launch-1.html`

This allows the app to auto-group by kind (`Blog`, `Email`, `Social`, `General`).

## Content Rules
1. Prefer HTML output for publish-ready drafts.
2. Keep links/assets relative when possible.
3. Reuse shared assets from `assets/`.
4. If master exists, align all derivatives with master goals and tone.
5. Do not delete old derivatives unless explicitly told.

## Asset Linking
When writing markdown:

- `![Alt text](assets/image-name.png)`

When writing HTML:

- `<img src="assets/image-name.png" alt="..." />`

## Suggested Derivative Set
Minimum pass per topic:

1. 1 blog derivative
2. 1 email derivative
3. 2 social derivatives (platform-specific)

## Non-Goals
- Do not set deployment status.
- Do not add fake deployment logs.
- Do not rewrite `topic.json` workflow state unless explicitly requested.

## Completion Signal
After writing files, stop. Human reviewer will use app tabs:

- Edit
- Review checklist
- Deploy log
