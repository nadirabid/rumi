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
| profile | `$DSH_HOME/profiles/rumi` |
| data root | `~/Library/Application Support/dsh-rumi` |
| icon | `apps/rumi/resources/icon*.png` — the word "rumi" |
| window title | `Rumi` (set by `DSH_CLIENT_TITLE` in `scripts/client-build-environment.ts`) |

Both apps run at the same time: separate bundle ids, separate single-instance locks,
separate profiles, ephemeral ports. They share `$DSH_HOME` (sessions, credentials,
settings) but not their plugin sets.

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

## Bundled plugins

`apps/rumi/brand/` holds the packages Rumi carries inside its own runtime and enables in every new profile. `@rumi/brand` draws the wordmark and owns the Live Voice key page; `@nmuzaffar/dsh-live-voice` adds full-duplex voice. Packaging installs both beside `dsh` and declares them in the bundled installation manifest, so the profile resolves them without a package manager. The key page appears as a built-in card on the Plugins page (Plugins → Live Voice) and writes the key file the voice plugin reads (`~/.dsh/live-voice.key`). `apps/rumi/brand/live-voice/README.md` records the vendored version and the update steps.

## Next

The UI is still stock Harness. Custom UI packages that are not shipped this way go in `~/.dsh/profiles/rumi/package.json`.

## Print Studio

`apps/rumi/brand/print-studio/` is the 3D-print setup slice. It detects Bambu Studio, the H2D profiles, and discovers the printer over SSDP; the **Plugins → Print Studio** card adopts the printer automatically and signs in once with a Bambu account to fetch the configured printer’s access code. A different account-bound printer never supplies a fallback code for a known serial. The bundled `print-studio-setup` skill guides setup. The access code lives in the credential store, never in the profile patch.

The setup status checks MQTT authentication, not authorization to start a print. H2D firmware can allow telemetry while rejecting control commands. The test-print flow slices a tile with Bambu Studio and hands it to Bambu Connect for confirmation; progress is read from the printer. Never describe an authenticated connection or a successfully sliced file as a confirmed print.

### Mesh preview

The **3D preview** tab shows a scene the agent builds for the current conversation. Open it from the right sidebar’s new-tab guide, ask Rumi for it, or open an STL file link. Coordinates are millimetres and the model is Z up. The scene fills the pane, with drag-to-orbit and scroll-to-zoom; a small pill appears only when the checks found something. Only an agent adds objects; there is no file picker, so the person asks Rumi.

The scene works like a Blender file. A mesh datablock is the geometry; an object places it with a scale, a rotation, and a position; opening the same file twice places a second object that shares the same geometry. `mesh_open` adds the first object (and the build volume, when given), `mesh_transform` places one, `mesh_remove` takes one out, and `mesh_state` reads the scene back. Scaling and turning happen around the object’s centre and the position says where its bottom centre sits, so a part that grows or turns upward keeps its base on the plate. Placement is a command, not an edit: turning or resizing never rewrites the mesh or the file, undo is the earlier scene, and the panel updates in place with the camera left where the person put it.

Because the person will eventually drag objects themselves, placement belongs to the scene and not to the file. The projection onto files is one function: baking produces one mesh per visible object with its placement applied. Export and slicing consume that, so what is printed and what was measured are the same geometry. Nothing is destructive until that point, and the source STL is never overwritten.

Pass a build volume when the scene is headed for a printer: the panel then draws the plate and the checks add fit, a suggested scale, whether a rotation would fit, and an explicit pending slicer check. The conservative H2D two-nozzle envelope is 300 × 320 × 320 mm. Checks cover fit, flat or degenerate geometry, duplicate faces, open or non-manifold edges, inconsistent winding, disconnected shells, and possible overhangs. The exact printer profile, material, plate, nozzle clearances, thin walls, self-intersections, and actual slicability still require slicer verification. Geometry checks never grant print readiness.

The first pass accepts STL only, with a 20 MiB file limit and 200,000-triangle cap. The host publishes canonical binary STL, so the browser never depends on how a file was exported, and all measurement happens host-side once per command. Scenes are session-scoped, held in memory for up to eight conversations, and cleared when the plugin unloads. Three.js is bundled privately by the plugin’s client build; no shared DSH package changes are needed. Rebuild that bundle after renderer edits (`pnpm --filter dsh-rumi run build:print-studio-client`); Rumi’s build and packaging preparation run it automatically.
