# Rumi

A DeepSeek Harness app built from this fork. `apps/rumi` is a copy of `apps/desktop`
rebranded as its own product; everything else is upstream, unmodified.

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

## Install and run

```sh
cp -R apps/rumi/.desktop-build/targets/mac-arm64/unsigned-artifacts/mac-arm64/Rumi.app /Applications/
open -a /Applications/Rumi.app
```

Launch from Finder. If you launch from inside a DSH shell, unset
`ELECTRON_RUN_AS_NODE` first — the harness sets it for its own children, and
Electron then runs as plain Node and exits silently.

## Next

The UI is still stock Harness. `~/.dsh/profiles/rumi/package.json` lists the
default `dsh-base` + `dsh-web-app` bundles; custom UI packages go there.
