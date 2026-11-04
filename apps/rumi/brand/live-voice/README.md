# Live Voice

English | [中文](README.zh.md)

Full-duplex voice for Rumi: GPT-Live listens and speaks, and the harness does the work it delegates.

The package is Rumi's own, at `@rumi/live-voice`. `src/` owns the OpenAI connection and harness delegation; `client/` owns microphone capture, playback, and the composer control. Rumi includes the bundle in its default profile.

## Configuration

Set a key under **Plugins → Live Voice**. The host saves it through `ctx.credentials`; settings responses contain only presence, a masked hint, and the storage location. Credential-service resolution takes precedence over explicit configuration and the configured legacy key file (`~/.rumi/live-voice.key` in the bundled profile). The launch environment is the final fallback. Saving a replacement does not rewrite legacy files.

## Session lifetime

The voice control stays beside Send while the microphone mute control appears to its left. The microphone control displays its current state: a normal microphone when on, or a crossed-out microphone when muted; its tooltip describes the action. Active voice reverses the icon’s foreground and background colors; animation also indicates activity.

While connecting, the control shows a dashed loading ring and remains cancellable. The enabled colors and mute control appear after the host reports readiness and local audio setup finishes.

Closing voice discards unsubmitted delegations and stops local capture immediately. Work already submitted to the harness may finish; plugin disposal waits for its session flush and transport shutdown. Pending starts cannot publish a session after disposal, and overlapping starts for the same conversation are rejected.

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

Contributions are composed in `order` at session startup. A contributor that throws is logged and skipped. `@rumi/projects` supplies the project's `AGENTS.md` this way. Edits to that file take effect in the next voice session. Contributors may also implement `captureRequest({sessionId, requestedAt, signal})`, returning content blocks for a separate logged `rumi-voice-reference` context message. The reference records the spoken message ID and enters the same next-step inbox immediately before the user message; the voice bubble contains only the transcribed words. The standard context UI keeps the reference separate, and voice conversation context excludes it. Capture begins at the first nonempty transcript chunk since the previous delegation; the timestamped result is retained until that delegation. Print Studio supplies a cursor image and region this way. Capture failures are logged as explicit unavailable visual context, never replaced by an older capture. Closing voice aborts outstanding captures.

During a harness turn, the host follows session events and sends quiet `thinking` notes, at most one every few seconds. New delegations steer the active agent at its next step instead of waiting for another turn. Ordered submissions share one running interval; its final result is returned against the latest delegation, not attributed separately to each correction. A command already executing is not interrupted.

Voice instructions require visual highlights for referenced model parts and plain-language explanations. Clear requests, undo requests, and offered choices are handled in context; ambiguous intent needs clarification. Short replies and corrections must be delegated to the harness. No special confirmation phrase is required.

## Handoff evidence

The default frontend prompt uses GPT-Live’s explicit `Generate <|SpawnThinking|>` instruction for backend requests, short answers to task questions, and corrections. Custom `instructions` replace that policy and must retain the delegation instruction; see the [OpenAI prompting guide](https://developers.openai.com/api/docs/guides/live-prompting#delegation). Prompt instructions guide model behavior; only a received delegation and host acceptance establish that work was submitted.

On delegation, the host immediately sends a silent thinking update to suppress the pending automatic acknowledgment. `acknowledgementDelayMs` defaults to 800 ms. This does not stop speech already generated or independent model speech. Voice instructions prohibit claiming acceptance before the host reports it and prohibit claiming a visible highlight before a `rendered` tool result.

An early delegation waits up to `transcriptWaitMs` (default 5,000 ms) for nonempty transcript text instead of being discarded. Duplicate IDs do not submit twice. Transcript fragments are not guaranteed to be complete utterances; ambiguous instructions still need clarification. A missing transcript reports failure. The host allows `handoffTimeoutMs` (default 10,000 ms) for agent resolution and reference capture; work that resolves after timeout cannot be submitted. Closing voice cancels pending transcript waits and prevents unsubmitted work from starting.

The voice controls distinguish no action sent, sending, accepted, and failed. Acceptance means admission to the modeling agent’s inbox, not completed work. These labels follow host events independently of spoken promises. Failure asks the person to repeat the request; there is no automatic retry that could duplicate an edit.

`diagnosticsDirectory` defaults to `~/.rumi/voice-logs`. Each live connection writes a private JSONL file named by its live ID, with conversation and connection IDs, timestamps, input/output transcript fragments, delegation metadata, host updates, acceptance/failure transitions, and close reason. Audio and credentials are not recorded. These diagnostic journals are separate from chat messages, persist across app restarts, and remain until deleted. A journal setup failure prevents startup; a write failure stops voice and reports the failure. The normal conversation log still owns modeling-agent input, tools, and highlight-render results.

## Verification

Run `pnpm exec vitest run --config apps/rumi/vitest.voice.config.ts`. This configuration resolves directly shipped JavaScript imports to workspace source. Tests use a local WebSocket server and controlled browser audio promises; they do not contact OpenAI or capture microphone audio.

Contributors may implement `refineRequest({sessionId, text, content, signal})` to refine captured content from accumulated transcript chunks before delegation. The hook returns the replacement content blocks, runs in order after capture, and shares voice cancellation. Print Studio uses it for non-destructive cursor selection phrases without another model request. The final reference remains logged separately from the user’s words; refinement failures add explicit unavailable context.
