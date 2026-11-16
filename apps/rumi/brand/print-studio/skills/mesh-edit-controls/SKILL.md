---
name: mesh-edit-controls
description: Turn a request to adjust a mesh into useful live controls. Choose the editable features, construct their deformations, verify the preview, and save or cancel the edit.
---

# Mesh edit controls

Use this skill when someone wants to adjust a shape themselves. A direct instruction such as “make it 20 mm wide” can be a source edit; a request to explore needs controls before applying the change. For existing joint movement, follow [blender-modeling](../blender-modeling/SKILL.md#movement-controls).

## Understand the edit

Read the current `meshState`, identify the intended model, and call `viewer_working_model`. Inspect the displayed revision’s source, dimensions, part positions, and construction. A named feature may be a region within one mesh or span several parts. Use [clarify-mesh-changes](../clarify-mesh-changes/SKILL.md) to ground the request visually. Ask one concrete question only when materially different interpretations remain.

Identify what should vary and what must stay fixed: openings, mating surfaces, wall surfaces, symmetry, connectors, and adjacent parts. Distinguish a profile change from local inflation and geometry edits from moving an existing part.

Choose a small set of useful adjustments. For each, define its geometric effect, affected region, neutral value, range, and protected features. Derive these choices from the request and current geometry; do not require prepared files, subject presets, or specific control names from the person. Source parameters help explain construction but are not automatically live bindings.

## Implement the adjustments

- Use a built-in operation only when its actual deformation matches the intended edit. Read [analog-shaping](../analog-shaping/SKILL.md) for bindings and regions.
- For custom variations that preserve mesh connectivity, author [displacement fields](references/fields.md). Derive the mapping from the current construction, measured profile, or cross-sections. Evaluate source parameter changes on temporary copies when useful. Keep the generator in the project so it can be revised.
- New holes, count changes, and other unsupported live reconstruction need a specific explanation and an agreed alternative. Do not silently replace requested controls with static variants or a completed edit.

Check existing field files against the current revision and request before reusing them. Preserve the editable Blender original. Executable JavaScript previews and `operation: parameters` are unavailable.

## Verify and present

State the expected geometric effect and preserved features for each axis. Prepare the controls through `viewer_controls`; preparation stages them without changing the person's preview. Validate the prepared controls to generate actual-mesh endpoint and combination comparisons. Inspect every before/after image, displacement overlay, and measurement against the expected effects. Check useful movement, direction, continuity, pinching, intersections, part fit, and both sides of shells. A completed render is evidence, not a quality pass.

Record an assessment for each axis and the combinations. Revise ineffective, redundant, or disruptive bindings, then prepare and validate again. Present controls only after accepting the current evidence. The tool tracks pending work and invalidates evidence when the model or bindings change; do not substitute formula samples or self-authored tests for its comparisons.

Read [interactive-controls](../interactive-controls/SKILL.md) to choose widgets and labels. Field values start at zero. For built-in deformations, amount .5 leaves the geometry unchanged; choose the other starting values as described in `analog-shaping`. Briefly explain what changes and what stays fixed.

Only `rendered` confirms visibility. For `viewer_hidden`, bring the window forward; the viewer retries. For `render_failed`, fix the reported binding or model error. A timeout does not establish that the requested edit is unsupported.

## Revise unsuitable controls

When the person says controls are wrong or ineffective, reread this skill and inspect the binding. Distinguish delivery failure, a bad region or range, and an unsuitable deformation. Revise the adjustments or representation; relabeling the same operation does not fix it.

Preserve wanted unsaved adjustments; ask if keeping them is unclear. Close an explicitly rejected preview without baking it. Keep the saved revision intact while preparing replacement controls. Dissatisfaction does not authorize a static edit or saving.

## Save or cancel

Keep controls open during exploration. Satisfaction or moving to another task resolves the latest visible edit first. Do not use the original opening values in place of the person’s adjustments.

1. Freeze with `viewer_controls`, `action: freeze`, and the current control `id`. A failed freeze does not authorize saving stale values.
2. Call `blender_status`, open the original `.blend` matching the selected USD, and load the returned helper with `runpy`. Call `helper["apply_shape_controls"](recipePath)`, then `helper["publish"]` and `viewer_load` the new revision. The helper checks the source USD hash and applies the frozen deformation; do not approximate it with another operator. It bakes evaluated modifiers on affected parts, so retain the original revision and modifier stack. Verify the published preview and that `meshState` has cleared the temporary edit and highlight before reporting a save.
3. For explicit cancel or revert, close the current `id` to restore the saved preview. If the source changes, reread state and reopen controls.

Failed previews preserve the last successful geometry and values. Failed execution leaves the original untouched on disk; report the error and allow reopening with the saved values. Unresolved controls are not a saved edit. A saved shape is not certified print-ready.
