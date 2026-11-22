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

## Skill reminders

Baseten Bison independently reviews completed steps while the primary agent continues working. It can remind the agent to update the region map for the revision it will leave saved at the end of the turn, or to shorten a reply. The primary agent owns the edit and the response to the user. Print Studio runs one review at a time across active turns and combines queued steps. It delivers each kind of reminder at most once per turn. At turn end it waits briefly, then discards any unfinished review.

Reviews use the configured Baseten credential with any primary model. Bison receives bounded excerpts of the request and visible reply, the task plan, recent tool actions and outcomes, and the region-map status of changed models. Shell commands, raw tool output, attachments and model files stay local. The [reviewer](skill-reminders.js) owns the questions and delivery rules. The [plugin configuration](index.js) defines the credential, cadence, threshold, timeout and limits under `skillReminders`.

## Build and test

After editing the viewer, rebuild its browser bundle with `pnpm --filter dsh-rumi run build:print-studio-client`. Package behavior tests live in [tests/](tests/). For changes that affect the installed app, follow [Rumi’s build instructions](../../../../RUMI.md#build) and [installed validation checks](../../tests/README.md#validation-tool-qualification).
