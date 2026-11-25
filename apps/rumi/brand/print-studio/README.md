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

Open **Badges** beside **Plugins** to see the six mechanical badges. Expand an earned badge to see the projects that earned it and the design feature the reviewer recognized. Each project earns a given badge once. A later passing movement check for the same mechanism can add movement evidence.

After a completed project turn changes a saved model, Print Studio reviews its final revision in the background. Chats in a project share one badge review queue. Different projects can run badge reviews concurrently. The reviewer uses the configured DeepSeek API connection independently of the project conversation. It receives part and joint descriptions, construction evidence, relevant project excerpts, and available movement checks. It can request local cross-sections to inspect custom mechanisms. The badge describes a feature in the design. Physical print performance requires its own test.

For a removable dovetail saved in its locked pose, Print Studio can compare both mating profiles on a shared grid across the declared removal direction. Matching flared geometry can earn **Dovetail slide** before a movement check passes.

Rumi stores awards, pending reviews, and a private record of evaluator requests in `~/.rumi/print-studio/badges.sqlite`. The database follows `DSH_RUMI_HOME`. Failed reviews can be retried from **Badges** after reconnecting the provider. The [Print Studio configuration](index.js) exposes `badgeReview` and `badgeDatabase`.

## Skill reminders

Baseten Bison independently reviews completed steps while the primary agent continues working. It can remind the agent to update the region map for the revision it will leave saved at the end of the turn, or to shorten a reply. The primary agent owns the edit and the response to the user. Chats in a project share a reminder queue that runs independently of its badge reviews and other projects. Print Studio combines queued steps from the same turn and delivers each kind of reminder at most once per turn. At turn end it waits briefly, then discards any unfinished review for that turn.

Reviews use the configured Baseten credential with any primary model. Bison receives bounded excerpts of the request and visible reply, the task plan, recent tool actions and outcomes, and the region-map status when a model or its map changes. Shell commands, raw tool output, attachments and model files stay local. The [reviewer](skill-reminders.js) owns the questions and delivery rules. The [plugin configuration](index.js) defines the credential, cadence, threshold, timeout and limits under `skillReminders`.

## Build and test

After editing the viewer, rebuild its browser bundle with `pnpm --filter dsh-rumi run build:print-studio-client`. Package behavior tests live in [tests/](tests/). For changes that affect the installed app, follow [Rumi’s build instructions](../../../../RUMI.md#build) and [installed validation checks](../../tests/README.md#validation-tool-qualification).

The [Blender badge fixture](tests/blender-badge-revisions.py) checks six construction receipts and rejects a stale receipt after a geometry edit. Pass `-- /absolute/scratch-directory` to retain the designs. Running `node apps/rumi/brand/print-studio/tests/qualify-badges.mjs /absolute/scratch-directory` from the repository root then tests the live DeepSeek reviewer on those designs, including an untagged fold and a shallow groove given the same request. This uses the configured DeepSeek API account.
