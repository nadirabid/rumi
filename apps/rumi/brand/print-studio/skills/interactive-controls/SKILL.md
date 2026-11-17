---
name: interactive-controls
description: Choose and describe Rumi’s sliders, two-axis pads, and scalar curve widgets for mesh edits or joint movement.
---

# Interactive controls

Choose a widget after identifying what the person should be able to vary. Use [mesh-edit-controls](../mesh-edit-controls/SKILL.md) to design geometric edits and [blender-modeling](../blender-modeling/SKILL.md#movement-controls) to bind joint movement.

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

## Worked examples

**One value.** "Can I make the snout stick out more?" A single `slider` labelled "Snout length", one axis `{key: 'amount', min: 0, max: 1, step: 0.01, reset: 0.5}`. Amount .5 is the current shape for built-in deformations, so the person starts from what they already see.

**Two directions that belong together.** "I want to move the ears out and up." A `pad`, first axis horizontal for outward, second vertical for upward, both starting at .5 with equal ranges. Do not offer two sliders when the gesture is one spatial movement; the pad expresses the relationship.

**A shape over a range.** "Let me tune the curve of the back." A `curve` per adjustable station, each with its own label naming the station's position ("Back — upper", "Back — middle") rather than "Station 1". The curve handle adjusts one value; it does not expose movement points.

**A request the widget cannot keep.** "Let me type the exact millimetre value." A slider does not accept numeric entry. Say so and offer the closest thing: a fine step on the slider, or a direct source edit for an exact dimension. Do not label a slider with millimetres it cannot promise.

**Too many controls.** A request implies eight independent values across four panels. A panel supports 1–12 controls, but the person cannot reason about twelve at once. Choose the four that match how they described the change, and say which other values you fixed and at what value.

**Bind each value once.** If two controls would both drive the same underlying axis, bind it to one and give the other a different quantity, or drop it. Two controls on one value fight each other and make the preview unpredictable.
