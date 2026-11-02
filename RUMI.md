# Rumi

A DeepSeek Harness app built for my kids — somewhere to play, make things, and learn
alongside an agent. `apps/rumi` is a copy of `apps/desktop` rebranded as its own
product; everything else is upstream, unmodified.

## What differs from upstream

| Thing | Value |
|---|---|
| product name | `Rumi` |
| bundle id | `com.nadirmuzaffar.rumi` |
| URL scheme | `rumi` |
| home | `~/.rumi` (override: `DSH_RUMI_HOME`) |
| profile | `~/.rumi/profiles/rumi` |
| sessions and storages | `~/.rumi/sessions`, `~/.rumi/storages` |
| projects | `~/.rumi/workspace` |
| data root | `~/Library/Application Support/dsh-rumi` |
| icon | `apps/rumi/resources/icon*.png` — the word "rumi" |
| window title | `Rumi` (set by `DSH_CLIENT_TITLE` in `scripts/client-build-environment.ts`) |

Both apps run at the same time and share nothing: separate bundle ids, single-instance
locks, homes, profiles, Sessions, credentials, instructions, and plugin sets. The
Electron main process points `DSH_HOME` at `~/.rumi` before the first path resolves, so
the profile, Session and storage roots, credentials, `AGENTS.md`, skills, presets,
provisioned runtimes, and every bundled plugin that reads the home all land under
Rumi's own directory. Nothing resolves `~/.dsh`, which belongs to DeepSeek Harness.

## Build

```sh
# Toolchain: this machine's CLT ships a macOS 27 SDK whose libSystem.tbd the
# bundled clang cannot link; pin an older SDK for the native addon.
export SDKROOT=/Library/Developer/CommandLineTools/SDKs/MacOSX15.sdk

pnpm install --no-frozen-lockfile
pnpm build
pnpm --filter dsh-rumi run build
```

## Package

The unsigned path is ad-hoc signed and needs no Apple credentials:

```sh
export DSH_DESKTOP_APP_ID=com.nadirmuzaffar.rumi
# package-target spawns `node $npm_execpath`; a standalone pnpm binary breaks
# that, so point it at the JS entry.
export npm_execpath="$PWD/node_modules/pnpm/bin/pnpm.mjs"

node node_modules/tsx/dist/cli.mjs apps/rumi/scripts/package-target.ts mac-arm64 --unsigned
```

Artifacts land in `apps/rumi/.desktop-build/targets/mac-arm64/unsigned-artifacts/`
(`Rumi.app` and a `.dmg`).

Distribution builds need a Developer ID plus notarization credentials and drop
`--unsigned`; that path is upstream's and unchanged.

Before macOS code signing, Rumi scopes the copied Electron app and helper build UUIDs to their application identities. This keeps local-network permissions distinct from other installed Electron apps; see [Apple TN3178](https://developer.apple.com/documentation/technotes/tn3178-checking-for-and-resolving-build-uuid-problems). The packaging hook supports the separate arm64 and x64 targets and rejects unsupported executable formats. Executable debug symbols, if distributed, must carry the rewritten UUID too.

## Install and run

```sh
cp -R apps/rumi/.desktop-build/targets/mac-arm64/unsigned-artifacts/mac-arm64/Rumi.app /Applications/
open -a /Applications/Rumi.app
```

Launch from Finder. If you launch from inside a DSH shell, unset
`ELECTRON_RUN_AS_NODE` first — the harness sets it for its own children, and
Electron then runs as plain Node and exits silently.

## Moving an earlier install

Builds before Rumi owned `~/.rumi` kept their profile and state under `~/.dsh`,
beside DeepSeek Harness. Move that data once before launching a newer build, or the
app opens empty:

```sh
node node_modules/tsx/dist/cli.mjs apps/rumi/scripts/migrate-rumi-home.ts
```

It moves the profile, Sessions, storages, and Print Studio state, copies the
credentials and the Live Voice key, and repoints the profile's Session and storage
roots. Each path moves only when Rumi's home does not already hold it, so rerunning is
safe. The shared Python and Node runtimes are not copied; the app provisions them under
`~/.rumi/dsh-runtimes` the first time a task asks for them.

## Bundled plugins

`apps/rumi/brand/` holds the packages Rumi carries inside its own runtime and enables in every new profile. `@rumi/brand` draws the wordmark and owns the Live Voice key page; `@rumi/live-voice` adds full-duplex voice, and contributes the project's instructions to the voice model through `ctx.liveVoice`. Packaging installs them beside `dsh` and declares them in the bundled installation manifest, so the profile resolves them without a package manager. The key page appears as a built-in card on the Plugins page (Plugins → Live Voice) and writes the key file the voice plugin reads (`~/.rumi/live-voice.key`).

A package that ships skills keeps them at `skills/<name>/SKILL.md` and publishes them by mounting the stock `@deepseek-ai/dsh-skill-filesystem` provider on that directory, so the frontmatter is parsed and the body loads on demand. `@rumi/print-studio` is the reference: `skills/print-studio-setup/` with a `providerName` of its own and `includeDefaultRoots` off.

## Next

Custom UI packages that are not shipped this way go in `~/.rumi/profiles/rumi/package.json`.

## Terms

| Term | Meaning |
|---|---|
| Rumi home | `~/.rumi`, the root of every path the app reads or writes. `DSH_RUMI_HOME` relocates it. |
| Rumi project | One directory at `~/.rumi/workspace/<id>/`. It is the unit the gallery lists and the directory a Session runs in. |
| Project instructions | An `AGENTS.md` directly inside a Rumi project, loaded in that project's Sessions only. DSH scopes project files to the nearest ancestor holding `.git` and falls back to the working directory, which for a Rumi project is the project directory itself. |
| Project type | The workflow a project follows, recorded in `project.json`. A type's plugin contributes the instructions its projects carry. One type today: `print`. |
| User instructions | `~/.rumi/AGENTS.md`. Loaded in every Session. Absent today, so Sessions start with no user instructions. |
| Bundled plugin | A package under `apps/rumi/brand/` that ships inside the signed app and activates in every profile. |

## Projects

The app opens on a project gallery. Each project is a directory of its own, holding `project.json`, `artifacts/`, `source/`, and `references/`; the id is immutable and the name lives in the JSON, so renaming never moves files. `@rumi/projects` owns this: the gallery is a `main` panel, the New/Close control is the window-chrome `shell.leading` seat, and the stock navigation column is collapsed at boot so the gallery owns the window.

Opening a project starts or reuses a DSH session whose working directory is the project root, and records the session id in `project.json`. Close returns to the gallery with `ctx.layout.selectPanel('projects')` and never ends the session, so a running turn or an unsent draft survives. Settings, plugins, and automation lose their sidebar home along with the navigation column; they stay reachable through the app menu and their shortcuts.

The creator writes the project's `AGENTS.md`. `@rumi/projects` contributes the frame — what a project is, and what each folder in it holds — and a project-type plugin contributes what its type adds. Each keeps that text in an `AGENTS_TEMPLATE.md` beside its code. `ctx.rumiProjectTypes` is the seam: a plugin registers its template paths and the creator concatenates them under the project name, so a Session starts knowing what it is for and what it makes.

The first pass has no renaming, deletion, thumbnails, or project switching inside a project. Session logs stay in Rumi's own session storage; only their ids are recorded per project.

## Print Studio

`apps/rumi/brand/print-studio/` is the 3D-print setup slice. It detects Bambu Studio, the H2D profiles, and discovers the printer over SSDP; the **Plugins → Print Studio** card adopts the printer automatically and signs in once with a Bambu account to fetch the configured printer’s access code. A different account-bound printer never supplies a fallback code for a known serial. The bundled `print-studio-setup` skill guides setup. The access code lives in the credential store, never in the profile patch.

The setup status checks MQTT authentication, not authorization to start a print. H2D firmware can allow telemetry while rejecting control commands. The test-print flow slices a tile with Bambu Studio and hands it to Bambu Connect for confirmation; progress is read from the printer. Never describe an authenticated connection or a successfully sliced file as a confirmed print.

### Mesh preview

Document tabs use rounded glass controls, with separate space for the title and close button. Tabs size to their contents up to 280px; longer titles fade only at the clipped edge, and an overflowing tab strip scrolls horizontally.

The **3D preview** tab shows a scene the agent builds for the current conversation. Open it from the right sidebar’s new-tab guide, ask Rumi for it, or open an STL file link. Coordinates are millimetres and the model is Z up. The scene fills the pane, with drag-to-orbit and scroll-to-zoom; a small pill appears only when the checks found something. Only an agent adds objects; there is no file picker, so the person asks Rumi.

The scene works like a Blender file. A mesh datablock is the geometry; an object places it with a scale, a rotation, and a position; opening the same file twice places a second object that shares the same geometry. `mesh_open` adds the first object (and the build volume, when given), `mesh_transform` places one, `mesh_remove` takes one out, and `mesh_state` reads the scene back. Scaling and turning happen around the object’s centre and the position says where its bottom centre sits, so a part that grows or turns upward keeps its base on the plate. Placement is a command, not an edit: turning or resizing never rewrites the mesh or the file, undo is the earlier scene, and the panel updates in place with the camera left where the person put it.

Because the person will eventually drag objects themselves, placement belongs to the scene and not to the file. The projection onto files is one function: baking produces one mesh per visible object with its placement applied. Export and slicing consume that, so what is printed and what was measured are the same geometry. Nothing is destructive until that point, and the source STL is never overwritten.

Pass a build volume when the scene is headed for a printer: the panel then draws the plate and the checks add fit, a suggested scale, whether a rotation would fit, and an explicit pending slicer check. The conservative H2D two-nozzle envelope is 300 × 320 × 320 mm. Checks cover fit, flat or degenerate geometry, duplicate faces, open or non-manifold edges, inconsistent winding, disconnected shells, and possible overhangs. The exact printer profile, material, plate, nozzle clearances, thin walls, self-intersections, and actual slicability still require slicer verification. Geometry checks never grant print readiness.

The viewer accepts editable Three.js models through `viewer_load`; see the [model interface](apps/rumi/brand/print-studio/README.md#editable-threejs-models). STL imports retain a 20 MiB file limit and 200,000-triangle cap. For STL imports, the host publishes canonical binary STL and measures geometry once per command. Editable Three.js models are built and measured in the renderer. Scenes are session-scoped, held in memory for up to eight conversations, and cleared when the plugin unloads. Three.js is bundled privately by the plugin’s client build; no shared DSH package changes are needed. Rebuild that bundle after renderer edits (`pnpm --filter dsh-rumi run build:print-studio-client`); Rumi’s build and packaging preparation run it automatically.
