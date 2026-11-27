# Print Studio

English | [中文](README.zh.md)

Print Studio is Rumi’s built-in plugin for 3D printing projects. It connects the modeling agent, Blender, the Three.js preview and Bambu Studio. The agent edits a model in Blender, the viewer displays the saved revision, and the user can arrange its parts on plates for slicing in Bambu Studio.

## Where to make a change

| Area | Implementation | Maintainer reference |
|---|---|---|
| Model creation, publishing and undo | [Blender helpers](blender/) | [Model files and revisions](docs/models/README.md) |
| Preview, pointing, hover labels and the agent’s work target | [Viewer](viewer/) | [Mesh preview and selection](docs/viewer/README.md) |
| Joint movement and interactive mesh edits | [Edit controls](viewer/analog/) and [movement controls](viewer/movement-controls.js) | [Movement and mesh edit controls](docs/controls/README.md) |
| Geometry, clearances and mechanical acceptance | [Blender checks](blender/validate.py) and [Bullet checks](bullet/) | [Model validation](docs/validation/README.md) |
| Printer setup, monitoring and slicer handoff | [Host](index.js), [settings card](client.js) and [native sign-in](desktop/) | [Printers and print layout](docs/printing/README.md) |

To change what the modeling agent knows, start with the [print project instructions](AGENTS_TEMPLATE.md). The [skills directory](skills/) holds task-specific guidance, including [Blender modeling](skills/blender-modeling/SKILL.md) and [naming model regions](skills/name-model-regions/SKILL.md).

## Mechanical badges

Open **Badges** beside **Plugins** to see the six mechanical badges and the three repeatable maker habit badges (**Language**, **Patience**, and **Persistence**). Earned badges appear together at the top in chronological order, while unearned badges sit in smaller, muted category groups (**Mechanical** and **Maker habits**) below. Each mechanical badge groups all projects that earned it under one portrait Liquid Glass tile (with a later passing movement check adding movement evidence). Each earned **Language**, **Patience**, or **Persistence** demonstration or improvement appears as its own portrait tile—marked **Improved** when earned through within-project growth—so the collection grows with every new demonstration. Non-overlapping turn watermarks ensure the same streak or message is never double-awarded.

When a project earns a new badge, a portrait glass tile spins into the center of the Rumi window, lands, and fades. It shows the badge and project name. With Reduce Motion on, the tile appears without the spin or stamp. If Live Voice is active in that project, it receives a short note about the badge that it can mention the next time it speaks. New awards stay in the collection if their reveal is missed.

After a completed project turn changes a saved model, Print Studio reviews its final revision in the background. Completed project turns also run deterministic pre-checks for unearned **Language**, **Patience**, and **Persistence** badges—evaluating strong direct practice or within-project growth across turns—and dispatch an independent background DeepSeek review only when a dimension passes its deterministic eligibility gate. Chats in a project share one badge review queue. Different projects can run badge reviews concurrently. The reviewer prefers the configured DeepSeek API connection independently of the project conversation, and falls back automatically to DeepSeek via Baseten or the session's active model route when direct DeepSeek API credentials are not configured. Mechanical reviews receive part and joint descriptions, construction evidence, relevant project excerpts, and available movement checks, and can request local cross-sections to inspect custom mechanisms. Mechanical badges describe a feature in the design; physical print performance requires its own test.

For a removable dovetail saved in its locked pose, Print Studio can compare both mating profiles on a shared grid across the declared removal direction. Matching flared geometry can earn **Dovetail slide** before a movement check passes.

For a custom living hinge, Print Studio samples additional cross-sections when the first cuts miss a short flexing web. Matching cuts through the web and its thicker sides help distinguish a hinge from a gap or a shallow groove.

Rumi stores awards, pending reviews, and a private record of evaluator requests in `~/.rumi/print-studio/badges.sqlite`. The database follows `DSH_RUMI_HOME`. Failed reviews can be retried from **Badges** after reconnecting the provider. The [Print Studio configuration](index.js) exposes `badgeReview` and `badgeDatabase`.

## Skill reminders

Baseten Bison reviews completed steps on each eligible user turn while the primary agent continues working. It can remind the agent to update the region map for the final saved revision or to shorten a reply. Chats in a project share a review queue. Print Studio combines queued steps from the same turn and sends each kind of reminder at most once per turn. A finishing turn waits for its first review to start and allows a bounded time for unfinished review work.

Reviews use the configured Baseten credential with any primary model. Bison receives bounded excerpts of the request and visible reply, the task plan, recent tool actions and outcomes, and the region-map status when a model or its map changes. Shell commands, raw tool output, attachments and model files stay local. The [reviewer](skill-reminders.js) owns the questions and delivery rules. The [plugin configuration](index.js) defines the credential, cadence, threshold, timeout and limits under `skillReminders`.

Each print project stores one JSON diagnostic per session turn in its `.rumi-diagnostics/skill-reviews/` directory, so a project folder copy includes the records for every session. The record identifies a skip reason or counts attempts, completed decisions, and failures. It lists the reminder kinds sent and the last failure stage when applicable. The first turn for a project imports its earlier Cordis storage records and preserves any project-local copy. The standard `/export` ZIP includes delivered reminders in the session log.

## Build and test

After editing the viewer, rebuild its browser bundle with `pnpm --filter dsh-rumi run build:print-studio-client`. Package behavior tests live in [tests/](tests/). For changes that affect the installed app, follow [Rumi’s build instructions](../../../../RUMI.md#build) and [installed validation checks](../../tests/README.md#validation-tool-qualification).

The [Blender badge fixture](tests/blender-badge-revisions.py) checks six construction receipts and rejects a stale receipt after a geometry edit. Pass `-- /absolute/scratch-directory` to retain the designs. Running `node apps/rumi/brand/print-studio/tests/qualify-badges.mjs /absolute/scratch-directory` from the repository root then tests the live DeepSeek reviewer on those designs, including an untagged fold and a shallow groove given the same request. This uses the configured DeepSeek API account.
