# Live Voice

English | [中文](README.zh.md)

Rumi uses GPT-Live-1.1 for full-duplex voice. WebRTC sends microphone audio directly to OpenAI and plays the response. The local host holds the API key and handles transcripts and project-agent handoffs on a control WebSocket.

The package is Rumi's own, at `@rumi/live-voice`. `src/` owns the OpenAI connection and harness delegation; `client/` owns microphone capture, playback, and the composer control. Rumi includes the bundle in its default profile.

Every voice session includes the mandatory conversation scope and quiet listening instructions, including when custom instructions are configured. Rumi directs GPT-Live to stay quiet at startup and while waiting or listening, and to avoid filler acknowledgments and responses to background noise or its own audio. GPT-Live can answer project requests and speak results requested by the host. Restart voice to load updated instructions. [Rumi conversation scope](../../../../RUMI.md#conversation-scope)

## Configuration

Set a key under **Plugins → Live Voice**. The host saves it through `ctx.credentials`; settings responses contain only presence, a masked hint, and the storage location. Credential-service resolution takes precedence over explicit configuration and the configured legacy key file (`~/.rumi/live-voice.key` in the bundled profile). The launch environment is the final fallback. Saving a replacement does not rewrite legacy files.

Standard profiles upgrade when the next voice session starts. If the profile overrides `endpoint`, point it at a GPT-Live provider that accepts WebRTC session creation and offers a sideband WebSocket. Remove the override to use OpenAI. An explicit `model` override still selects that model.

## Session lifetime

The voice control stays beside Send while the microphone mute control appears to its left. The microphone control displays its current state: a normal microphone when on, or a crossed-out microphone when muted; its tooltip describes the action. Active voice reverses the icon’s foreground and background colors; animation also indicates activity.

While connecting, the control shows a dashed loading ring and remains cancellable. The enabled colors and mute control appear after OpenAI confirms that the WebRTC session is ready. Mute disables the outgoing microphone track.

Rumi allows one Live Voice connection at a time across all projects, conversations, and windows. If a connection is starting, active, or closing, stop it or wait for it to close before trying again.

GPT-Live waits for microphone speech before starting inference. After the first wake, inference stays available so the project agent's results can be spoken when they arrive. [GPT-Live speech wake policy](https://developers.openai.com/api/docs/guides/live-conversations#managing-idle-sessions)

Voice closes automatically after five minutes without recognized speech or a sent chat message in the current conversation, including while muted. Agent work and pending voice handoffs defer closure until they settle. A pending or playing voice reply gets a short grace period. Click the voice control to start again. `idleTimeoutMinutes` sets the period of user inactivity from 1 to 60 minutes. The `maxSessionMinutes` hard cap still applies.

Closing voice discards unsubmitted delegations and stops local capture immediately. The host releases the voice connection after transport shutdown. Submitted harness work can finish independently, and plugin disposal waits for that work to flush to the conversation.

Delegations preserve the buffered request, including single-word and Chinese commands. The transcript buffer retains up to 4,000 characters. Duplicate delegation IDs are ignored; repeating the same words in a new delegation is allowed.

## Context

The composer supplies its session ID. Before connecting, the host resolves that session and includes its canonical conversation: user text, assistant text, and retained compaction summaries. `contextMaxCharacters` limits this history to its most recent 16,000 characters by default (configurable from 1 to 64,000); omitted earlier text is marked. System prompts, reasoning blocks, tool payloads, and non-text attachments are excluded. The source text remains reconstructable from the session log.

New committed messages from that same session are forwarded as silent context, including messages received during the connection handshake. Updates from other sessions are ignored. Switching the composer to another session stops voice and resets its controls. Voice cannot inspect the viewer or project files directly; it delegates those questions to the harness.

An active connection can also receive quiet [badge notifications](../print-studio/README.md#mechanical-badges) from its project. The voice journal records the exact note sent to the model.

The host owns delegation IDs and channel selection. Other plugins contribute startup instructions through `ctx.liveVoice`:

```js
ctx.inject(['liveVoice'], (scoped) => {
  scoped.effect(() => scoped.liveVoice.register({
    id: 'project',
    instructions: sessionId => readProjectInstructions(sessionId),
  }), 'context')
})
```

Contributions are composed in `order` at session startup. A contributor that throws is logged and skipped. `@rumi/projects` supplies the project's `AGENTS.md` this way. Edits to that file take effect in the next voice session. Contributors may also implement `captureRequest({sessionId, requestedAt, signal})`, returning content blocks for a separate logged `rumi-voice-reference` context message. The reference records the spoken message ID and enters the same next-step inbox immediately before the user message; the voice bubble contains only the transcribed words. The standard context UI keeps the reference separate, and voice conversation context excludes it. Capture begins at the first nonempty transcript chunk since the previous delegation; the timestamped result is retained until that delegation. Print Studio supplies a cursor image and region in geometry cursor modes. In Named regions mode, the spoken name identifies the feature. Capture failures are logged as explicit unavailable visual context, never replaced by an older capture. Closing voice aborts outstanding captures.

During a delegated harness turn, the host stays quiet after confirming acceptance and sends the final result as commentary when the turn settles; tool calls and in-flight turn messages are not forwarded as `thinking` notes. New delegations steer the active agent at its next step instead of waiting for another turn. Ordered submissions share one running interval; its final result is returned against the latest delegation, not attributed separately to each correction. A command already executing is not interrupted.

Voice delegates model highlights and edits to the modeling agent, which handles any needed clarification and reports when a highlight renders. Voice also delegates undo requests, answers to task questions, and corrections. Plain-language requests and responses work without a confirmation phrase.

## Handoff evidence

The default GPT-Live-1.1 prompt describes when to delegate backend requests, short answers to task questions, and corrections in plain language. Custom `instructions` must describe the requests that need delegation. Rumi adapts the previous delegation marker in existing custom prompts. A task is submitted when the host receives a delegation and the project agent accepts it. See the [OpenAI prompting guide](https://developers.openai.com/api/docs/guides/live-prompting#delegation).

On delegation, the host immediately sends a silent thinking update to suppress the pending automatic acknowledgment. `acknowledgementDelayMs` defaults to 800 ms. This does not stop speech already generated or independent model speech. Voice instructions prohibit claiming acceptance before the host reports it and prohibit claiming a visible highlight before a `rendered` tool result.

An early delegation waits up to `transcriptWaitMs` (default 5,000 ms) for nonempty transcript text instead of being discarded. Duplicate IDs do not submit twice. Transcript fragments are not guaranteed to be complete utterances; ambiguous instructions still need clarification. A missing transcript reports failure. The host allows `handoffTimeoutMs` (default 10,000 ms) for agent resolution and reference capture; work that resolves after timeout cannot be submitted. Closing voice cancels pending transcript waits and prevents unsubmitted work from starting.

The voice controls distinguish no action sent, sending, accepted, and failed. Acceptance means admission to the modeling agent’s inbox, not completed work. These labels follow host events independently of spoken promises. Failure asks the person to repeat the request; there is no automatic retry that could duplicate an edit.

`diagnosticsDirectory` defaults to `~/.rumi/voice-logs`. Each live connection writes a private JSONL file named by its live ID, with conversation and connection IDs, timestamps, input/output transcript fragments, delegation metadata, host updates, acceptance/failure transitions, and close reason. Audio and credentials are not recorded. These diagnostic journals are separate from chat messages, persist across app restarts, and remain until deleted. A journal setup failure prevents startup; a write failure stops voice and reports the failure. The normal conversation log still owns modeling-agent input, tools, and highlight-render results.

## Verification

Run `pnpm exec vitest run --config apps/rumi/vitest.voice.config.ts`. This configuration resolves directly shipped JavaScript imports to workspace source. Tests use a local HTTP and control WebSocket fixture plus simulated renderer WebRTC tracks. A real-provider smoke verifies audio and delegation separately.
