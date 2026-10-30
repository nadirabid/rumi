# Live Voice

Full-duplex voice for Rumi: GPT-Live listens and speaks, the harness does the work.

This directory is a vendored copy of `@nmuzaffar/dsh-live-voice` 0.8.0 from
[github.com/nadirabid/dsh-live-voice](https://github.com/nadirabid/dsh-live-voice)
at commit `2cd95fd`. Rumi packs it into its runtime and enables its bundle in
the default profile, so it is available without a plugin install. The upstream
README, tests, design notes, and screenshots stay in that repository.

Only runtime files are copied: `lib/`, `client/`, `locale/`, `cordis.patch.yml`,
`icon.svg`, and `LICENSE`. The package is `private` here because this copy is
never published.

## Updating

Build the upstream package, then replace the runtime files above and bump the
version in `package.json` and in this note. Keep the package name: the bundle
patch, the client module id, and the `plugins.bundle.config` seat are keyed by
it.

The host half imports `ws`; it resolves from the runtime's package tree because
Rumi installs this package beside `dsh` at build time.

## Configuration

Keys are stored in `~/.rumi/live-voice.key` by default. Set one under **Plugins →
Live Voice** in the app, or provide `OPENAI_API_KEY` in the environment.
