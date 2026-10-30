# Rumi projects

The app's home: a gallery of projects, each one a directory on disk rather than a
session-scoped workspace.

## What a project is

```text
~/.rumi/workspace/<project-id>/
  project.json   # id, name, session ids, timestamps
  artifacts/     # outputs to keep: STL, slices, images, documents
  source/        # editable source used to regenerate them
  references/    # imported assets and reference material
```

The id is immutable and is the directory name; the name is user-facing and lives in
`project.json`, so renaming never moves files. Opening a project starts or reuses a
DSH session whose working directory is the project root, and records its id in
`project.json`. Internal DSH workspaces retain their unique directory-derived names,
so multiple projects can share a display name.

## Surfaces

- `main` panel `projects` — the gallery. It is empty until the first project.
- `shell.leading` — the window-chrome control: **New** while browsing, the project
  name and **Close** while one is open. The frame only mounts this seat when the
  navigation column is fully hidden, which is why the plugin collapses that column
  at boot.
- Close returns to the gallery with `ctx.layout.selectPanel('projects')`. It never
  ends the session: a running turn or an unsent draft survives.

## Routes

- `GET /api/rumi-projects` — every readable project, most recently updated first.
- `POST /api/rumi-projects` — create one (`{ name }`).
- `POST /api/rumi-projects/session` — record the session a project now uses
  (`{ projectId, sessionId }`).

## Boundaries

The host half owns the filesystem and returns each project's absolute `path`; the
browser half owns the DSH session (`ctx.sessions.create({ cwd })`) and the
navigation (`ctx.uiWorkspace.openSession`). Neither half reaches into the other's
concerns, and the gallery renders no session state of its own.

Settings, plugins, and automation lose their sidebar home with the navigation
column. They stay reachable through the app menu and their shortcuts.

## Gallery appearance

The gallery uses neutral board covers, a three-column grid that reduces to two or one column on narrow windows, and a circular New control. Covers are placeholders until project thumbnails are available; they do not depict generated artifacts. Colors follow the active DSH theme. The glass treatment is CSS, not native SwiftUI Liquid Glass.

New projects and their initial sessions share the name `Untitled <number>`. The host reserves numbers exclusively on disk so concurrent creation and app restarts do not reuse them. Existing names are preserved.

The home gallery owns project selection. Rumi shadows `conversation.hero.workspace` with a hidden occupant and hides the conversation hero’s workspace button in its app-owned stylesheet. The conversation does not expose the stock workspace picker.
