# Live Voice

Full-duplex voice for Rumi: GPT-Live listens and speaks, and the harness does the
work it asks for.

The package is Rumi's own, at `@rumi/live-voice`. `lib/` is the host half — the
OpenAI key, the Live protocol, the bridge from a delegation to one harness turn.
`client/` is the browser half — microphone capture, playback, and the control
beside the composer. Rumi packs it into its runtime and enables its bundle in the
default profile, so it is available without a plugin install.

## Context

The host owns the wire: delegation ids, the 500-token cap on an append, and when
each channel is written. Other plugins contribute content through `ctx.liveVoice`:

```js
ctx.inject(['liveVoice'], (scoped) => {
  scoped.effect(() => scoped.liveVoice.register({
    id: 'project',
    instructions: sessionId => readProjectInstructions(sessionId),
  }), 'context')
})
```

Contributions are composed in `order` and become part of the startup
`instructions`, which GPT-Live freezes when the session starts. A contributor
that throws is logged and skipped. `@rumi/projects` supplies the project's
`AGENTS.md` this way.

Progress during a turn is not contributed: the host follows the Session's own
events and sends quiet `thinking` notes, at most one every few seconds.

## Configuration

Keys are stored in `~/.rumi/live-voice.key` by default. Set one under **Plugins →
Live Voice** in the app, or provide `OPENAI_API_KEY` in the environment.

The host half imports `ws`; it resolves from the runtime's package tree because
Rumi installs this package beside `dsh` at build time.
