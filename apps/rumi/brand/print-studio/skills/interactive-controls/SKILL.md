---
name: interactive-controls
description: Open labeled sliders, two-axis pads, and curves when someone wants to adjust a model themselves, such as changing a width, an angle, or a position, exploring a bulge, or positioning a cut. Structure the model so control values drive how the geometry is built, and preserve the user's latest preview when saving.
---

# Interactive model controls

“Let me adjust/tilt/change it”, “give me a slider”, and “can I try different shapes?” request controls, not an edit made on the person's behalf. Read the current `meshState` and the model source, identify the intended model, and declare work with `viewer_working_model`. Direct instructions such as “make it 20 mm wide” do not require opening controls unless the person also asks to explore.

Use `viewer_controls` with explicit `controls`, `values`, and the current design's exact `path`, `revision`, and `url`. Choose short labels in the person's language. Initial values must reproduce the current model; `reset` is the meaningful neutral or saved starting value. The tool returns `rendered` only after the visible viewer acknowledges the preview. Do not say controls are ready after `not_rendered` or a failed build. A `viewer_hidden` reason means the window must be brought forward; the viewer retries the same controls when visible. A `render_failed` reason includes the actual binding or model error. A timeout alone does not establish that parameter controls are unsupported; do not replace requested controls with static alternatives on that evidence.

## Persistent movement controls

Doors, wheels, hinges, and other movable features use model-owned movement controls instead of a temporary `viewer_controls` edit. Export `motionControls` from the JavaScript model using the same labeled slider/pad/curve declarations below, bound to numeric entries in `parameters`. The viewer discovers these declarations on load and keeps them at the bottom-right as long as the loaded model declares them. Preserve the declarations and their bindings when repairing or replacing the model; remove a declaration only when its movable feature is removed. Do not infer motion from parameter names.

```js
export const parameters = { wheelSpin: 0, doorAngle: 0 }
export const motionControls = [
  { kind: 'slider', label: 'Wheels', axes: [
    { key: 'wheelSpin', min: -360, max: 360, step: 1, reset: 0 },
  ] },
  { kind: 'slider', label: 'Doors', axes: [
    { key: 'doorAngle', min: 0, max: 100, step: 1, reset: 0 },
  ] },
]
```

Movement changes only the local preview pose, never the saved parameters or validation input, and needs no freeze/save/close. The panel remains visible but disabled while a temporary edit owns the preview; the movement pose returns after that edit ends. Compatible pose values survive model revisions and switching between recent models while the viewer is mounted; reopening the viewer starts from saved values. A posed preview cannot supply a source-bound cursor edit: reset the movement controls to the saved pose first. `viewer_load` feedback exposes the discovered declarations under `design.motion`. GLB does not yet expose these JavaScript parameter bindings. Animation does not establish printable joint mechanics.

## Declare controls

Each declaration has `kind`, `label`, and `axes`. A slider or curve has one axis; a pad has horizontal and vertical axes. Each axis has `key`, `min`, `max`, `step`, and `reset`. Keys bind entries in `values`. Labels are presentation, not behavior. A curve adjusts one bounded scalar with a curve-shaped gesture; it is not arbitrary curve geometry unless the model binds that scalar to its geometry.

A parameter slider:

```json
{
  "action": "open",
  "operation": "parameters",
  "label": "Eyes",
  "values": {"eyeTilt": 10},
  "controls": [{"kind": "slider", "label": "Eye tilt", "axes": [
    {"key": "eyeTilt", "min": -25, "max": 25, "step": 0.5, "reset": 10}
  ]}]
}
```

Add the current `path`, `revision`, and `url` to this example. One `eyeTilt` parameter can drive both eyes with mirrored signs in the model builder. Do not expose two unrelated sliders when the person asks to move both together.

## Make the edit controllable

Parameter controls drive a JavaScript model that exports a numeric `parameters` dictionary and a synchronous `build(THREE, parameters)` function; use `operation: parameters`. Control keys must be declared in that dictionary and used by the builder. The viewer reruns `build()` on every control change without calling you or running a shell command. `build()` has Three.js only: it can transform and generate geometry, but cannot perform 3D Boolean operations, remesh, or run Blender. Models use millimetres and Z up, return fresh meshes and materials, build quickly, and share a 2 MiB limit across the model folder's `.js` and `.mjs` files.

Before editing, work out what the result should look like across the control's range and what must stay exactly as it is. Then decide what structure the model needs so `build()` can produce that result at any value, and what one-time Blender change, if any, gets the current mesh there. The value should be an input to how the affected geometry is built, not a movement applied to finished geometry. Keep a recoverable copy, and preserve unrelated parts, earlier edits, and dimensions.

Tell the person the intended result in one plain sentence; if it is unclear, ask what it should look like. Before opening controls, check the lowest, reset, and highest values: the requested feature changes as described and nothing else moves, bends, or separates. If no structure achieves this, say so before editing.

If JavaScript is a temporary preview of an edit to an existing model, preserve its original Blender or mesh source and prepare a semantic edit recipe that maps each parameter to the intended Blender operation and identifies features to preserve. Before opening controls, including when a preview is already loaded, write `.rumi-preview.json` beside its entry with `{"original":"models/example/original.blend","edit":"Describe how the parameters change the original and what stays fixed"}`. The original path is project-relative. Open with `finish: blender`, `original` set to the preserved source path, and `edit` set to the same recipe. The marker makes the viewer retain Blender finishing even if the tool call omits it. Do not treat the preview mesh as the final result. For a genuinely final JavaScript model, omit `finish` or use `finish: parameters`.

Expose only the parameters requested, or a small useful set; keep other declared parameters and their defaults. Use a step of 1 for integer parameters.

## Bind existing GLB operations

Read `analog-shaping` for frame, region, part selection, highlighting, and Blender save rules. These operations still execute their existing geometry math; their UI is supplied by the declarations. Their six `values` are normalized 0..1, with neutral values .5. All declared axes must use min 0 and max 1.

Examples:

- **“Let me move the bottom cut up and tilt it.”** Use `operation: cut`; declare sliders “Cut height” → `amount`, “Front-to-back tilt” → `angle`, and “Side tilt” → `spread`, each step .001 and reset .5. The automatic cut guide replaces Gaussian highlights. Do not cut first.
- **“Let me change how round the back is.”** Highlight the region and use `operation: bulge`; declare “Roundness” → `amount`, “Area” → `spread`, a pad “Position” → `peakX`/`peakY`, and a curve “Softness” → `falloff`. Add direction tilt → `angle` only when useful. Supply all six initial values even when some are not exposed.
- **“Let me make the table wider.”** For a parameterized table, use `operation: parameters` and a slider bound to `width`, using the model's actual millimetre range and current width. Do not select a bulge or taper merely because it has existing controls.
- **“Move the feature left/right and up/down.”** Bind a pad to the model's two placement parameters with their real ranges. Its axes need not be normalized for parameter models.

## Finish, save, or cancel

Keep the controls open while the person explores. Satisfaction or moving to another task resolves the latest visible edit first; no special confirmation phrase is required. Do not rebuild from the initial tool arguments: release feedback and freeze capture the user's newer values.

1. Call `viewer_controls` with `action: freeze` and the current control `id`. This captures the visible values, locks the controls, and returns a source-bound recipe. A failed freeze is not permission to save stale values.
2. For a final JavaScript model (`finish: parameters`), call `viewer_controls` with `action: save` and the frozen `id`. This atomically persists values in `.rumi-parameters.json` beside the model, reloads it, and closes controls. Do not edit that file or the model source while controls are open. Wait for `saved` and check the viewer.
3. For a temporary parameter preview (`finish: blender`), read the frozen recipe and its latest values, verify the preserved original still matches `originalHash` (SHA-256), reopen the preserved original in Blender, apply the semantic edit at those values, preserve unrelated features, inspect the result against the preview, check printability, save the editable source and export, then `viewer_load` the result. If the edit cannot be reproduced or verified, report the limitation and keep the frozen recipe; do not save the preview as final.
4. For GLB operations, apply the frozen recipe with the Blender helper described in `analog-shaping`, publish, and `viewer_load` the result.
5. Explicit cancel/revert uses `action: close` with the current `id`. It restores the saved preview and does not write parameter values. Source changes invalidate controls; re-read state and reopen rather than reusing an old id.

Report build/save failures plainly. Failed parameter previews preserve the last successful geometry and values. Never claim an edit is saved while controls remain unresolved.
