---
name: interactive-controls
description: Open labeled sliders, two-axis pads, and curves when someone wants to adjust a model themselves, such as changing a width, an angle, or a position, exploring a bulge, or positioning a cut. Structure the model so control values drive how the geometry is built, and preserve the user's latest preview when saving.
---

# Interactive model controls

“Let me adjust/tilt/change it”, “give me a slider”, and “can I try different shapes?” request controls, not an edit made on the person's behalf. Read the current `meshState` and the model source, identify the intended model, and declare work with `viewer_working_model`. Direct instructions such as “make it 20 mm wide” do not require opening controls unless the person also asks to explore.

Use `viewer_controls` with explicit `controls`, `values`, and the current design's exact `path`, `revision`, and `url`. Choose short labels in the person's language. Initial values must reproduce the current model; `reset` is the meaningful neutral or saved starting value. The tool returns `rendered` only after the visible viewer acknowledges the preview. Do not say controls are ready after `not_rendered` or a failed build. A `viewer_hidden` reason means the window must be brought forward; the viewer retries the same controls when visible. A `render_failed` reason includes the actual binding or model error. A timeout alone does not establish that parameter controls are unsupported; do not replace requested controls with static alternatives on that evidence.

## Persistent movement controls

Doors, wheels, hinges, and other movable features use model-owned movement controls instead of a temporary `viewer_controls` edit. Preserve the USD assembly declarations and their bindings when repairing the model. Remove a declaration only when its movable feature is removed. Include every separate axle, pin and retaining cap, with real connector geometry. Read [physical movement declarations](../blender-modeling/SKILL.md#declare-physical-movement) for the assembly contract. Executable JavaScript previews and `operation: parameters` are unavailable under project isolation.

Movement changes only the local preview pose, never saved parameters or validation input, and needs no freeze/save/close. Controls remain visible but disabled while a temporary edit owns the preview. Compatible pose values survive revisions and switching between recent models while the viewer is mounted; reopening starts from saved values. Reset movement before requesting source-bound cursor edits. `viewer_load` feedback exposes rendered declarations under `design.motion`; inspect this feedback before claiming controls are visible. Validation tests the saved physical assembly through Blender and Bullet. Animation and simulation do not certify material strength or print readiness.

Publish USD Physics joints with the Isaac robot annotations described in `blender-modeling`; the viewer generates sliders from revolute and prismatic joints. Use the joint’s `rumi:control` string for a short label in the person’s language, or omit it to use the child mesh name. Author local joint frames in metres/Z up, with rotation limits in degrees. The viewer moves descendants with their parents and preserves fixed attachments. It supports trees with up to 12 independent controls; unsupported bindings remain visible as geometry with a diagnostic in the viewer report. Do not create a separate JavaScript model just to animate a USD. These sliders preview declared motion, not verified physical feasibility.

## Declare controls

Each declaration has `kind`, `label`, and `axes`. A slider or curve has one axis; a pad has horizontal and vertical axes. Each axis has `key`, `min`, `max`, `step`, and `reset`. Keys bind entries in `values`. Labels are presentation, not behavior. A curve adjusts one bounded scalar with a curve-shaped gesture; it is not arbitrary curve geometry unless the model binds that scalar to its geometry.

Use the supported USD operations below. Before opening controls, check the lowest, reset, and highest values: the intended feature changes and unrelated features stay intact. Keep the editable Blender original. If an operation cannot represent the requested edit, explain that limitation and make the edit in Blender; do not create executable preview code.

## Bind existing USD operations

Read `analog-shaping` for frame, region, part selection, highlighting, and Blender save rules. These operations still execute their existing geometry math; their UI is supplied by the declarations. Their six `values` are normalized 0..1, with neutral values .5. All declared axes must use min 0 and max 1.

Examples:

- **“Let me move the bottom cut up and tilt it.”** Use `operation: cut`; declare sliders “Cut height” → `amount`, “Front-to-back tilt” → `angle`, and “Side tilt” → `spread`, each step .001 and reset .5. The automatic cut guide replaces Gaussian highlights. Do not cut first.
- **“Let me change how round the back is.”** Highlight the region and use `operation: bulge`; declare “Roundness” → `amount`, “Area” → `spread`, a pad “Position” → `peakX`/`peakY`, and a curve “Softness” → `falloff`. Add direction tilt → `angle` only when useful. Supply all six initial values even when some are not exposed.

## Finish, save, or cancel

Keep the controls open while the person explores. Satisfaction or moving to another task resolves the latest visible edit first; no special confirmation phrase is required. Do not rebuild from the initial tool arguments: release feedback and freeze capture the user's newer values.

1. Call `viewer_controls` with `action: freeze` and the current control `id`. This captures the visible values, locks the controls, and returns a source-bound recipe. A failed freeze is not permission to save stale values.
2. Apply the frozen USD recipe with the Blender helper described in `analog-shaping`, publish, and `viewer_load` the result. Preserve unrelated features and verify the new preview before reporting it saved.
3. Explicit cancel/revert uses `action: close` with the current `id`. It restores the saved preview. Source changes invalidate controls; re-read state and reopen rather than reusing an old id.

Report build/save failures plainly. Failed previews preserve the last successful geometry and values. Never claim an edit is saved while controls remain unresolved.
