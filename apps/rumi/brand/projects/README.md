# Rumi projects

English | [中文](README.zh.md)

The app's home: a gallery of projects, each one a directory on disk rather than a session-scoped workspace.

The current project template is also registered in the backend system prompt, so existing projects receive the mandatory [conversation scope](../../../../RUMI.md#conversation-scope) without rewriting their files.

## What a project is

```text
~/.rumi/workspace/<project-id>/
  project.json   # id, name, session ids, timestamps
  artifacts/     # outputs to keep: STL, slices, images, documents
  source/        # editable source used to regenerate them
  references/    # imported assets and reference material
```

The id is immutable and is the directory name; the name is user-facing and lives in `project.json`, so renaming never moves files. Opening a project starts or reuses a DSH session whose working directory is the project root, and records its id in `project.json`. Internal DSH workspaces retain their unique directory-derived names, so multiple projects can share a display name.

## Surfaces

- `main` panel `projects` — the gallery. It is empty until the first project.
- `shell.leading` — the window-chrome control: **New** while browsing, the project name and **Close** while one is open. The frame only mounts this seat when the navigation column is fully hidden, which is why the plugin collapses that column at boot.
- Creating or opening a project opens its **3D preview** tab alongside the conversation, even before a model exists.
- Close returns to the gallery with `ctx.layout.selectPanel('projects')`. It never ends the session: a running turn or an unsent draft survives.

## Routes

- `GET /api/rumi-projects` — every readable project, most recently updated first.
- `POST /api/rumi-projects` — create one (`{ name }`).
- `DELETE /api/rumi-projects?projectId=<id>` — delete a project and its directory; `204` on success, `404` when no such project exists.
- `POST /api/rumi-projects/session` — record the session a project now uses (`{ projectId, sessionId }`).

## Boundaries

The host half owns the filesystem and returns each project's absolute `path`; the browser half owns the DSH session (`ctx.sessions.create({ cwd })`) and the navigation (`ctx.uiWorkspace.openSession`). Neither half reaches into the other's concerns, and the gallery renders no session state of its own.

Settings, plugins, and automation lose their sidebar home with the navigation column. They stay reachable through the app menu and their shortcuts.

## Project isolation

Agent file operations are limited to the directory registered for their session in `project.json`. Canonical path checks cover reads and writes, including absolute paths, parent traversal and existing symlinks. Shell and search subprocesses run under macOS Seatbelt with the same limits inherited by child processes. Saved full-access modes and escalation requests cannot widen access. Denials are recorded as tool results in the session.

Installed application resources, system executables and the shared dependency runtime are read-only exceptions; they are not project storage. The `rumi-project-scope` provider accepts absolute `workspaceRoot` and `runtimeRoots` configuration. Runtime grants must contain only trusted runtime files. Project instructions come only from the owning root `AGENTS.md`, through logged runtime context; ancestor, global and nested instruction discovery is disabled. `instructionMaxBytes` defaults to 65,536 and accepts 1–1,048,576 bytes; oversized instructions fail instead of truncating. The gallery and session persistence remain trusted application operations outside the agent tool scope. The two explicit Print Studio validation tools, `validation_mechanics` and `validation_accept`, are admitted for registered project sessions; model path arguments remain restricted to the owning project. Validators use immutable project snapshots and application-owned temporary and acceptance storage. This policy does not sandbox Codex or other applications running outside Rumi.

Commands use project-local `.rumi/tmp` scratch storage and the project as `HOME`. They may reach the network, so an image can be downloaded into `references/` with `curl`; Apple events, hard-link creation, symlink creation and directory removal or renaming are denied. The model-facing `web_search` and `web_fetch` tools are admitted for registered project sessions: they leave the project sandbox's host network alone and reach only public HTTP(S) endpoints through the web service, and `web_fetch` still rejects binary and image content. These restrictions prevent subprocesses from using another service or replacing directory identities to evade host path checks. Files inside the project can still be created, edited and removed. The `todo_write` tool records task progress in the calling project session. Tools without an audited project-access implementation fail closed. This provider requires macOS; unsupported platforms fail at load.

On upgrade, Rumi migrates its seeded profile policy to `workspace-write` while preserving unrelated custom profile entries. Existing project files and session logs need no migration. Import required assets into the current project's `references/` directory before asking the agent to use them; references to another project's paths are denied. Executable JavaScript model previews are disabled; export GLB using the confined modeling tools. Custom tools must be reviewed and added to the admission list before they can execute.

## Gallery appearance

The gallery uses neutral board covers, a three-column grid that reduces to two or one column on narrow windows, and a circular New control. Covers show the last successfully previewed model as a fitted 480 × 320 PNG, saved as `.preview.png` in the project directory. The open 3D viewport captures after scene changes settle, reusing its loaded geometry and renderer. The gallery loads images lazily and never builds meshes or creates WebGL contexts. Projects without a saved preview show a neutral placeholder until their model is opened. Failed model builds retain the last successful cover; source changes made without opening the preview are not reflected. Colors follow the active DSH theme. The glass treatment is CSS, not native SwiftUI Liquid Glass.

New projects and their initial sessions share the name `Untitled <number>`. The host reserves numbers exclusively on disk so concurrent creation and app restarts do not reuse them. Existing names are preserved.

The home gallery owns project selection. Rumi shadows `conversation.hero.workspace` with a hidden occupant and hides the conversation hero’s workspace button in its app-owned stylesheet. The conversation does not expose the stock workspace picker.

The app header has a separate tinted surface and a single divider; the underlying conversation header’s border is transparent. It shows Projects on home, the active project name beside Back in a conversation, and New at the trailing edge.

The right sidebar starts below the project header so its preview tabs and Close controls remain visible.

The top bar keeps Full/Regular view and Open/Close sidebar controls immediately before New. Closing the sidebar preserves its tabs; Open restores them. The size control is disabled while closed. Sidebar Split controls are hidden.

Right-clicking a project opens a glass menu with Open and Delete. Delete asks first, in an alert that shows the project's cover and name and says it cannot be undone; Cancel is the default. Confirming removes the project directory from disk. Where the browser's canvas is unavailable, the glass falls back to a plain blur.
