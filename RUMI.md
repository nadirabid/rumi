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

The setup status checks MQTT authentication, not authorization to start a print. H2D firmware can allow telemetry while rejecting control commands. The internal `slicing.js` helper resolves inherited Bambu Studio presets and included start/end G-code, and requires an explicit build plate; Studio’s CLI spelling for Cool Plate SuperTack is `Supertack Plate`. This helper is not yet registered as an agent tool. Sending and progress monitoring are not implemented in the installed plugin. Never describe an authenticated connection or a successfully sliced file as a confirmed print.
