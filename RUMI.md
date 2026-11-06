# Rumi

A DeepSeek Harness app built for my kids — somewhere to play, make things, and learn alongside an agent. `apps/rumi` is a copy of `apps/desktop` rebranded as its own product; everything else is upstream, unmodified.

## What differs from upstream

| Thing | Value |
|---|---|
| product name | `Rumi` |
| package | `dsh-rumi` (`apps/rumi`) |
| bundle id | `com.nadirmuzaffar.rumi` |
| URL scheme | `rumi` |
| home | `~/.rumi` (override: `DSH_RUMI_HOME`) |
| profile | `~/.rumi/profiles/rumi` |
| sessions and storages | `~/.rumi/sessions`, `~/.rumi/storages` |
| configuration | `~/.rumi/.credentials.yaml`, plus Rumi’s own `AGENTS.md`, skills, and presets under `~/.rumi` |
| projects | `~/.rumi/workspace` |
| data root | `~/Library/Application Support/dsh-rumi` |
| icon | `apps/rumi/resources/icon*.png` — the word "rumi" |
| window title | `Rumi` (set by `DSH_CLIENT_TITLE` in `scripts/client-build-environment.ts`) |

Both apps run at the same time and share nothing: separate bundle ids, single-instance locks, homes, profiles, Sessions, credentials, instructions, and plugin sets. The Electron main process points `DSH_HOME` at `~/.rumi` before the first path resolves, so the profile, Session and storage roots, credentials, `AGENTS.md`, skills, presets, provisioned runtimes, and every bundled plugin that reads the home all land under Rumi's own directory. Nothing resolves `~/.dsh`, which belongs to DeepSeek Harness.

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

Artifacts land in `apps/rumi/.desktop-build/targets/mac-arm64/unsigned-artifacts/` (`Rumi.app` and a `.dmg`).

Rumi packages the full Blender runtime under `Resources/runtime/blender`; no separate Blender installation is required. `apps/rumi/scripts/blender-runtime.lock.json` pins each binary and the source archive by SHA-256. Preparation downloads verified archives through Blender's mirror service, retains the original license notices and macOS signatures, and includes the Blender source archive. Update the lock together when changing Blender versions. The packaged smoke creates a mesh, saves its editable original, exports GLB, and reopens the original using only bundled paths. The macOS launcher disables Python bytecode writes and user Python paths; the smoke rechecks Blender’s signature after execution.

Distribution builds need a Developer ID certificate and notarization credentials. Rumi's Apple Silicon releases use `RUMI_RELEASE_REPOSITORY=owner/repository` in a private production packaging preset, with `DSH_DESKTOP_APP_ID=com.nadirmuzaffar.rumi` and `DSH_DESKTOP_AUTO_UPDATE_ENV=production`. This selects the public GitHub repository's latest release assets as the update feed and omits the DeepSeek mandatory-update service. The repository must be public; the app carries no GitHub credential. This feed supports only mac-arm64.

Keep the packaging directory outside the checkout. Its `secrets/macos-signing.env` contains `DSH_DESKTOP_MACOS_SIGNING_IDENTITY`, `DSH_DESKTOP_MACOS_TEAM_ID`, `CSC_LINK`, `CSC_KEY_PASSWORD`, and `APPLE_KEYCHAIN_PROFILE`; restrict private files to mode `0600`. `CSC_LINK` points to a local PKCS#12 certificate containing its private key and Developer ID intermediate certificate. Store notarization authentication with `xcrun notarytool store-credentials` and refer to that Keychain profile. Never put signing keys or passwords in the repository.

After the builds above, package a version greater than the installed version. The build version extends the product version, for example `0.2.1-rc.3.20261102.1`; increment its final number for another release that day. The updater uses the inherited `nightly` channel for these prerelease versions, while GitHub marks the selected release as latest.

```sh
export DSH_PACKAGING_CONFIG_DIR="$HOME/.config/rumi-release"
export DSH_PACKAGING_PRESET=production
export npm_execpath="$PWD/node_modules/pnpm/bin/pnpm.mjs"
node node_modules/tsx/dist/cli.mjs apps/rumi/scripts/package-target.ts mac-arm64 --build-version 0.2.1-rc.3.20261102.1
node apps/rumi/scripts/publish-github.mjs
node apps/rumi/scripts/publish-github.mjs --publish
```

The publisher validates the completed release record, ZIP checksum and size, Apple signatures and notarization, and public repository access. It uploads the DMG, ZIP, blockmap, and update feed into a draft before publishing it as latest. Binary URLs in the feed identify an immutable version tag. A failed upload can leave a draft; inspect it before retrying, and never replace assets of an already published version. While Rumi is running, it checks at startup and about every ten minutes and downloads newer releases automatically. Failed checks or downloads retry with capped backoff. Installation still requires confirmation through **Rumi → Check for Updates**; active work is not restarted automatically.

Before macOS code signing, Rumi scopes the copied Electron app and helper build UUIDs to their application identities. This keeps local-network permissions distinct from other installed Electron apps; see [Apple TN3178](https://developer.apple.com/documentation/technotes/tn3178-checking-for-and-resolving-build-uuid-problems). The packaging hook supports the separate arm64 and x64 targets and rejects unsupported executable formats. Executable debug symbols, if distributed, must carry the rewritten UUID too.

### Automatic GitHub releases

The `Release Rumi` workflow builds Apple Silicon releases on pushes to `main` in `nadirabid/rumi`; it can also be run manually on that branch. GitHub-hosted macOS runners install locked dependencies, run focused Rumi tests, package with a macOS 15 SDK, sign with Developer ID, notarize with Apple, and publish the verified update feed. Releases run serially, use a version greater than the latest published build, and tag the exact source commit. Failed builds leave the existing update feed intact. After Apple accepts an artifact, ticket-server failures during stapling and ticket validation retry three times with bounded delays; other failures stop publication. If publication leaves a draft, inspect and remove that incomplete draft before retrying; never overwrite a published release.

Configure these repository Actions secrets before enabling release builds: `RUMI_CERTIFICATE_BASE64` (base64-encoded Developer ID `.p12` containing its private key), `RUMI_CERTIFICATE_PASSWORD`, `RUMI_SIGNING_IDENTITY`, `RUMI_APPLE_TEAM_ID`, `RUMI_APPLE_ID`, and `RUMI_APPLE_APP_PASSWORD` (an Apple app-specific password for notarization). Signing configuration is written outside the checkout with private file permissions and removed at job completion. GitHub's job token publishes releases; no personal access token is needed. These credentials allow trusted code on `main` to sign releases, so restrict who can push to that branch. Clients use the download and installation behavior described above.

## Install and run

```sh
cp -R apps/rumi/.desktop-build/targets/mac-arm64/unsigned-artifacts/mac-arm64/Rumi.app /Applications/
open -a /Applications/Rumi.app
```

Launch from Finder. If you launch from inside a DSH shell, unset `ELECTRON_RUN_AS_NODE` first — the harness sets it for its own children, and Electron then runs as plain Node and exits silently.

First launch opens Projects without signing in or entering a key. Configure the DeepSeek API key in **Rumi → Settings → Models**; new conversations default to DeepSeek Flash (`deepseek-flash`). Rumi's DeepSeek providers default to `low` reasoning effort, including resumed conversations that inherit the provider default. Keys stay in local credentials and are not included in the installer.

## Moving an earlier install

Builds before Rumi owned `~/.rumi` kept their profile and state under `~/.dsh`, beside DeepSeek Harness. Move that data once before launching a newer build, or the app opens empty:

```sh
node node_modules/tsx/dist/cli.mjs apps/rumi/scripts/migrate-rumi-home.ts
```

It moves the profile, Sessions, storages, and Print Studio state, copies the credentials and the Live Voice key, and repoints the profile's Session and storage roots. Each path moves only when Rumi's home does not already hold it, so rerunning is safe. The shared Python and Node runtimes are not copied; the app provisions them under `~/.rumi/dsh-runtimes` the first time a task asks for them.

## Bundled plugins

Rumi derives its standard, PTC, and Cordis presets from the shipped definitions with the questionnaire tool removed. Clarification stays in the conversation for text and voice. The question-card UI is disabled; the underlying question service remains available for compatibility with other consumers.

Rumi's active presets compact at 30% of the routed model's context window, subject to the harness's lower input-budget safety limit. Configure `compactionThresholdRatio` on the `rumi-presets` row; the stock `preset-standard`, `preset-ptc`, and `preset-cordis` rows are disabled and do not control resumed Rumi sessions.

`apps/rumi/brand/` holds the packages Rumi carries inside its own runtime and enables in every new profile. `@rumi/brand` draws the wordmark and owns the Live Voice key page; `@rumi/settings` exposes the stock settings dialog and Plugins page through Rumi → Settings… (⌘,) and Rumi → Plugins…. `@rumi/live-voice` adds full-duplex voice and contributes the project's instructions through `ctx.liveVoice`. Packaging installs these bundles beside `dsh` and declares them in the bundled installation manifest, so the profile resolves them without a package manager. See [native settings integration](apps/rumi/brand/settings/README.md) for the menu wiring.

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

## Conversation scope

Rumi is a robot tool restricted to the current project type and directly related setup, learning, and safety. It must not explore feelings or personal matters, offer counseling, build relationships, or answer unrelated questions. Personal concerns receive a brief referral to a parent or trusted adult; immediate danger receives a brief direction to obtain adult or emergency help. Other off-topic requests receive a short redirect to the project. Project frustration is handled through concrete edits, undo, clarification, or pausing.

The projects plugin supplies the current `AGENTS_TEMPLATE.md` to the backend system prompt for existing and new conversations and writes it into new projects. Live Voice includes the same mandatory scope in every `session.start`, including custom instruction configurations. Restart Rumi after installing an updated build and start a new voice connection to load these instructions. Prompt configuration does not by itself establish that every model response complies; behavioral evaluation remains necessary.

Print Studio supplies live mesh state before each backend model request and retires superseded runtime snapshots from model-visible history; the full log retains them. Viewer selection stays independent of the agent's work target. See [live model context](apps/rumi/brand/print-studio/README.md#live-model-context).

## Print Studio

`apps/rumi/brand/print-studio/` is the 3D-print setup slice. It detects Bambu Studio, the H2D profiles, and discovers the printer over SSDP; the **Plugins → Print Studio** card adopts the printer automatically and signs in once with a Bambu account to fetch the configured printer’s access code. A different account-bound printer never supplies a fallback code for a known serial. The bundled `print-studio-setup` skill guides setup. The access code lives in the credential store, never in the profile patch.

The setup status checks MQTT authentication, not authorization to start a print. H2D firmware can allow telemetry while rejecting control commands. The test-print flow slices a tile with Bambu Studio and hands it to Bambu Connect for confirmation; progress is read from the printer. Never describe an authenticated connection or a successfully sliced file as a confirmed print.

### Mesh preview

Document tabs use rounded glass controls, with separate space for the title and close button. Tabs size to their contents up to 280px; longer titles fade only at the clipped edge, and an overflowing tab strip scrolls horizontally.

The **3D preview** tab shows a scene the agent builds for the current conversation. Open it from the right sidebar’s new-tab guide, ask Rumi for it, or open an STL file link. Coordinates are millimetres and the model is Z up. The right pane defaults to 60% of the window, with an adjustable divider and the conversation’s minimum width preserved on smaller windows. The scene fills the pane over the same subtle dot pattern as project covers, with drag-to-orbit and scroll-to-zoom. Model selector buttons float over the canvas on a transparent row; the space between buttons remains available for camera gestures. Geometry checks remain available to the agent through the injected `meshState` context. Only an agent adds objects; there is no file picker, so the person asks Rumi.

The scene works like a Blender file. A mesh datablock is the geometry; an object places it with a scale, a rotation, and a position; opening the same file twice places a second object that shares the same geometry. `mesh_open` adds the first object (and the build volume, when given), `mesh_transform` places one, `mesh_remove` takes one out, and the injected `meshState` context describes the scene. Scaling and turning happen around the object’s centre and the position says where its bottom centre sits, so a part that grows or turns upward keeps its base on the plate. Placement is a command, not an edit: turning or resizing never rewrites the mesh or the file, undo is the earlier scene, and the panel updates in place with the camera left where the person put it.

Because the person will eventually drag objects themselves, placement belongs to the scene and not to the file. The projection onto files is one function: baking produces one mesh per visible object with its placement applied. Export and slicing consume that, so what is printed and what was measured are the same geometry. Nothing is destructive until that point, and the source STL is never overwritten.

Pass a build volume when the scene is headed for a printer: the panel then draws the plate and the checks add fit, a suggested scale, whether a rotation would fit, and an explicit pending slicer check. The conservative H2D two-nozzle envelope is 300 × 320 × 320 mm. Checks cover fit, flat or degenerate geometry, duplicate faces, open or non-manifold edges, inconsistent winding, disconnected shells, and possible overhangs. The exact printer profile, material, plate, nozzle clearances, thin walls, self-intersections, and actual slicability still require slicer verification. Geometry checks never grant print readiness.

Mesh creation and editing use background Blender scripts; Three.js displays versioned GLB exports and retains cursor/highlight interactions. See [Blender editing](apps/rumi/brand/print-studio/README.md#blender-editing-and-glb-previews). JavaScript designs support labeled controls bound to declared parameters, including one parameter driving multiple features; see [interactive controls](apps/rumi/brand/print-studio/skills/interactive-controls/SKILL.md). They load through `viewer_load`; see the [model interface](apps/rumi/brand/print-studio/README.md#editable-threejs-models). STL imports retain a 20 MiB file limit and 200,000-triangle cap. For STL imports, the host publishes canonical binary STL and measures geometry once per command. Editable Three.js models are built and measured in the renderer. Scenes are session-scoped, held in memory for up to eight conversations, and cleared when the plugin unloads. Three.js is bundled privately by the plugin’s client build; no shared DSH package changes are needed. Rebuild that bundle after renderer edits (`pnpm --filter dsh-rumi run build:print-studio-client`); Rumi’s build and packaging preparation run it automatically.

## Plugin UI requirements

Every Rumi plugin follows the stock plugin-settings surface; a bespoke form is a regression even when it works. These rules apply to every plugin under `apps/rumi/brand/**`.

- Register the settings page as `plugins.item` in the client half. The page's `view === 'summary'` returns one plain sentence; `view === 'page'` returns the form. The card title comes from the registration label.
- Build the page from the shared primitives: `SettingsForm`, `SettingsValueField`, `SettingsSecretField`, `Switch`, `Button`, and `Tag` from `@deepseek-ai/dsh-client-ui-primitives`. Do not hand-roll inputs, buttons, save bars, labels, or status tags.
- Use `SettingsForm`'s `state`, `labels`, `onSave`, and `onDiscard` for staging and saving. The form's footer is the only save control.
- Use theme tokens (`var(--dsw-alias-…)`) or shared component styles, never literal colors and ad-hoc spacing.
- Put every visible string in a `ctx.locale` dictionary with `en` and `zh`; never inline copy in the component.
- Prefer automatic discovery and app-owned state over a setup form. Ask only for a fact that cannot be discovered, and keep secrets in `ctx.credentials`, never in the profile patch or a settings response.

## Build constraints

Environment traps, all of them real:

- **macOS 27 SDK** — the native addon fails to link; pin `MacOSX15.sdk`.
- **`npm_execpath`** — `package-target` spawns `node $npm_execpath`, and a standalone pnpm binary is not a JS file. Point it at `node_modules/pnpm/bin/pnpm.mjs`.
- **`ELECTRON_RUN_AS_NODE=1`** — every DSH shell sets it. Launch with `env -u ELECTRON_RUN_AS_NODE open -a …`, or Electron runs as plain Node and exits 0 in silence. This costs an hour if forgotten.
- **Commit hooks** — upstream lefthook checks translation pairing and fails on a fork. `git commit --no-verify` is expected here.

## Verifying UI changes

Screen recording is denied to the agent shell, so `screencapture` fails. Verify the rendered DOM instead:

```sh
env -u ELECTRON_RUN_AS_NODE "/Applications/Rumi.app/Contents/MacOS/Rumi" \
  --remote-debugging-port=9222 &
curl -s http://127.0.0.1:9222/json/list   # webSocketDebuggerUrl
```

Then drive `Runtime.evaluate` over that socket (`ws` lives in `node_modules/.pnpm/ws@*/node_modules/ws`) and read `document.querySelector…`. This is how the sidebar layout was confirmed: the More button's ancestry ends in `footArea`, no `nav` renders, and its menu reads "Plugins | Automation tasks".

Two traps that produced false confidence here:

- `pkill -f "MacOS/Rumi$"` does not match an instance launched with extra argv. Kill with `pkill -9 -f "Rumi.app/Contents"` and confirm `pgrep` is empty, or you will keep looking at the old build.
- The packaged app bundles `apps/rumi/lib` and the workspace packages as sealed tarballs. Editing `apps/rumi/src/preload-app.ts` or any `packages/client/*` source requires `pnpm --filter dsh-rumi run build` and `pnpm run build:official` respectively before packaging; the root `pnpm build` rebuilds neither. The mesh viewer's browser half is the same story: `apps/rumi/brand/print-studio/viewer/` is bundled into `lib/client.js` by `pnpm --filter dsh-rumi run build`, not served as source.

## Verify before claiming done

1. `Rumi.app` is in `/Applications` and `codesign -v` passes.
2. It launches and stays running (`pgrep -f "MacOS/Rumi$"`).
3. `~/Library/Application Support/dsh-rumi` and `~/.rumi/profiles/rumi` exist, and the profile patch carries the Rumi policy block.
4. `~/.rumi/sessions` grows when Rumi runs, and no Rumi process has a path under `~/.dsh`: `lsof -p $(pgrep -f "MacOS/Rumi$") | grep -c '\.dsh/'` is zero.
5. The stock app still builds: `pnpm --filter @deepseek-ai/dsh-desktop run build`.

## Repository layout reference

```
vendor/      Vendored Cordis (vendor/README.md)
packages/    @deepseek-ai/dsh-<pkg> workspaces at packages/<group>/<pkg>/
  core/                 agent/session API
  api/                  remote BFF
  typert/               type graphs
  llm/                  model providers
  shell/                command execution
  subprocess/           child-process management
  ssh/                  SSH execution providers
  terminal/             persistent terminals
  ptc-runtime/          PTC execution
  sandbox/              process confinement
  deliverables/         turn deliverables
  fs/                   filesystem access
  lsp/                  language servers
  skill/                skill loading
  web/                  search/fetch tools
  computer-use/         computer interaction
  browser-use/          browser interaction
  compaction/           context compaction
  context/              request context
  subagent/             delegated agents
  jobs/                 background jobs
  bundle/               profile bundles
  workflow/             workflow execution
  todo/                 todo_write tool
  plan/                 logged planning
  goal/                 session goals
  schedule/             scheduled follow-ups
  preset/               agent composition
  guard/                loop/tool guards
  extensions/           runtime self-modification
  session/              durable sessions
  session-query/        browsing/search/export
  attachment/           binary attachments
  spill/                output spill
  storage/              non-session storage
  workspace/            workspace entities
  feedback/             human feedback
  identity/             anonymous identity
  settings/             user settings
  credentials/          credentials/authorization
  acp/                  automation-only ACP
  interaction/          human interaction
  boot/                 application boot
  sdk/                  JSON-RPC SDK
  host/                 GUI host
  client/               GUI client
  mcp/                  external tools
  experimental/         evaluated capabilities without a product-support commitment
  test-support/         test infrastructure
  util/                 zero-dependency utilities
python/      Python SDK/runtime (python/README.md)
native/      @deepseek-ai/node-addon-system source (native/README.md)
benchmarks/  performance gates
.agents/     Agent workflows/notes
docs/        Documentation (docs/AGENTS.md)
scripts/     gates and generators
website/     VitePress documentation projection
```

Package groups: [packages/README.md](packages/README.md). Classification requirements remain in [AGENTS.md](AGENTS.md#repository-layout).

## Shared development commands

```sh
pnpm install            # pnpm workspaces, node ^22.19 || >=24
pnpm run clean           # remove build outputs and safe residue from deleted packages
pnpm run test           # unit tests
pnpm run test:coverage  # CI coverage gate: per-file 100% on packages/*/*/src
pnpm run test:e2e       # real-API tests; self-skip without DEEPSEEK_API_KEY
pnpm run test:expected  # owner-local process expectations
pnpm run test:snapshot  # keyless recorded-session replay through shipped profiles; filter: -t <name>
pnpm run test:snapshot:record  # re-record expected outputs (needs key)
pnpm run typecheck
pnpm run lint
pnpm run duplication    # cross-file TypeScript clone detection
pnpm run build          # build:artifacts + build:check, concurrently
pnpm run build:artifacts # artifacts: tsc emits lib/types, tsdown bundles runtime, Web
pnpm run build:check    # typecheck aggregate tests/scripts against current build:artifacts output
pnpm run hygiene        # publint + workspace/package/dependency checks + NodeNext consumer check
pnpm run check:windows-wine  # ONLY when diagnosing a known Windows failure (needs wine); CI owns this signal
pnpm run doc-sync       # documentation gates (scripts/run-gates.ts)
pnpm run test:docs      # quick documentation checks (no build; doc-quick aggregate)
pnpm run website:build  # VitePress build (doubles as dead-link check)
pnpm dsh --profile headless "task"  # run one task from source (needs DEEPSEEK_API_KEY)
pnpm run demo:ptc -- "task"  # headless PTC mode run (needs key)
pnpm run dev:web | dev:desktop  # build:artifacts, then launch; Web also rebuilds client bundles on edits. start:web | start:desktop skip the build
make web|dev-web|desktop|dev-desktop|build  # the same commands; ARGS='--no-open' forwards options
```

## Prose requirements

Comments and docs state complete contracts and context, not reasoning transcripts. Use direct, concrete terms. Do not use metaphors. Before writing `contract`, `boundary`, or `shape`, ask whether a more exact term names the subject: write `response fields`, `JSON validation`, or `ESM exports` instead of `response shape`, `validation boundary`, or `module shape`. Keep `contract` for preconditions, postconditions, invariants, compatibility promises, and other obligations that callers, callees, implementers, providers, producers, or consumers rely on. Keep a literal process, wire, security, transaction, or lifecycle boundary. Do not narrate control flow or tests, preserve review history, or restate code. Keep behavior, failure, timing, ownership, and safe-use facts; link the rationale. Use [dsh-prose-standard](.agents/skills/dsh-prose-standard/SKILL.md) for decisions. Wire mechanically checkable invariants into an executed top-level gate and prove each changed acceptance path rejects an invalid case. Use narrow, justified exceptions instead of disabling a rule globally.
