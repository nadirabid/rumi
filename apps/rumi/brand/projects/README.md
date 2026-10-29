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
`project.json`.

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
