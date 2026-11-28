---
name: control-widgets
description: "Choose and declare sliders, two-axis pads, and scalar curve widgets for mesh edits or joint motion."
---

# Control widgets

Choose a widget after identifying what the person should be able to vary. Use [mesh-edit-controls](../mesh-edit-controls/SKILL.md) to design geometric edits and [cad-modeling](../cad-modeling/SKILL.md#movement-controls) to bind joint movement.

## Choose the widget

- `slider`: one independent numeric value.
- `pad`: two related spatial directions; the first axis is horizontal and the second vertical.
- `curve`: one numeric value adjusted by dragging the curve’s centered handle up or down. It does not provide draggable profile points or change the underlying mapping.

Prefer a slider unless the other gesture helps express the task. Name controls after their visible effect, using the person’s language. Expose implementation settings only when they help the person make the intended change. Labels do not create bindings. Do not promise numeric entry or units the widget and binding do not support.

## Declarations

A control has `kind`, `label`, and `axes`. Labels are nonempty and at most 80 characters. A slider or curve has one axis; a pad has two. A panel supports 1–12 controls. Bind each numeric value at most once.

The renderer’s axes have `key`, `min`, `max`, `step`, and `reset`. Values and ranges must be finite, `min < max`, and `0 < step <= max - min`. Initial and reset values must lie in range. Choose a useful range and a step small enough for deliberate adjustment. Reset restores the meaningful starting value.

Mesh-edit tools receive these axes directly. USD movement declarations instead reference joints; the viewer derives keys, limits, and reset values from those joints. Follow the relevant skill for the declaration format, delivery feedback, and save behavior.

Controls support keyboard input and per-control reset. Verify that each axis changes the intended feature and that reset restores its starting state. A rendered acknowledgment confirms delivery, not the quality of the interaction.
