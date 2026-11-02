# Live Voice

English | [中文](README.zh.md)

Full-duplex voice for Rumi: GPT-Live listens and speaks, and the harness does the work it delegates.

The package is Rumi's own, at `@rumi/live-voice`. `src/` owns the OpenAI connection and harness delegation; `client/` owns microphone capture, playback, and the composer control. Rumi includes the bundle in its default profile.

## Configuration

Set a key under **Plugins → Live Voice**. The host saves it through `ctx.credentials`; settings responses contain only presence, a masked hint, and the storage location. Credential-service resolution takes precedence over explicit configuration and the configured legacy key file (`~/.rumi/live-voice.key` in the bundled profile). The launch environment is the final fallback. Saving a replacement does not rewrite legacy files.

## Session lifetime

The voice control stays beside Send while the microphone mute control appears to its left. Active voice reverses the icon’s foreground and background colors; animation also indicates activity.

While connecting, the control shows a dashed loading ring and remains cancellable. The enabled colors and mute control appear after the host reports readiness and local audio setup finishes.

Closing voice discards queued delegations and stops local capture immediately. Work already submitted to the harness may finish; plugin disposal waits for its session flush and transport shutdown. Pending starts cannot publish a session after disposal, and overlapping starts for the same conversation are rejected.

Delegations preserve the buffered request, including single-word and Chinese commands. The transcript buffer retains up to 4,000 characters. Duplicate delegation IDs are ignored; repeating the same words in a new delegation is allowed.

## Context

The composer supplies its session ID. Before connecting, the host resolves that session and includes its canonical conversation: user text, assistant text, and retained compaction summaries. `contextMaxCharacters` limits this history to its most recent 16,000 characters by default (configurable from 1 to 64,000); omitted earlier text is marked. System prompts, reasoning blocks, tool payloads, and non-text attachments are excluded. The source text remains reconstructable from the session log.

New committed messages from that same session are forwarded as silent context, including messages received during the connection handshake. Updates from other sessions are ignored. Switching the composer to another session stops voice and resets its controls. Voice cannot inspect the viewer or project files directly; it delegates those questions to the harness.

The host owns delegation IDs and channel selection. Other plugins contribute startup instructions through `ctx.liveVoice`:

```js
ctx.inject(['liveVoice'], (scoped) => {
  scoped.effect(() => scoped.liveVoice.register({
    id: 'project',
    instructions: sessionId => readProjectInstructions(sessionId),
  }), 'context')
})
```

Contributions are composed in `order` at session startup. A contributor that throws is logged and skipped. `@rumi/projects` supplies the project's `AGENTS.md` this way. Edits to that file take effect in the next voice session.

During a harness turn, the host follows session events and sends quiet `thinking` notes, at most one every few seconds. The completed result is returned as commentary for the corresponding delegation.

## Verification

Run `pnpm exec vitest run --config apps/rumi/vitest.voice.config.ts`. This configuration resolves directly shipped JavaScript imports to workspace source. Tests use a local WebSocket server and controlled browser audio promises; they do not contact OpenAI or capture microphone audio.
