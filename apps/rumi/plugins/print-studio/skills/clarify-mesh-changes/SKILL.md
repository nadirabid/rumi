---
name: clarify-mesh-changes
description: "Identify and highlight a feature from pointing or chat. Use the selected geometry to edit a feature or fit another part to it."
---

# Clarify mesh changes

Use ordinary language and the visible model to establish a shared reference. Use a highlight to visually ground region-specific edits and named parts. Follow clear requests, including undo and selections from choices you offered. Ask for clarification when the intended region or action is ambiguous; do not require a special confirmation phrase.

## Identify the region

For a planar cut, use the [live cut guide](../built-in-mesh-operations/SKILL.md#planar-cuts) as the visual reference.

When the person says or types a saved feature name or alias, pass it as `viewer_highlight.region`. Use the feature's stored location for the edit or explanation. When a name is unknown or ambiguous, ask which feature the person means. Use [name-model-regions](../name-model-regions/SKILL.md) to identify and explain useful features on the model.

For a new mark, use the cursor capture attached to that utterance or call `viewer_cursor_snapshot`. Check `identity.design` against the currently displayed model. Pass the returned `mesh.path` unchanged as `viewer_highlight.meshPath`. The STL contains the selected triangles in the saved model's coordinates, including during Movement. If the reason is `named_regions`, ask the person to say or type the feature name. If capture fails, becomes stale, or returns `meshUnavailable`, explain the issue and ask for a fresh pin on an editable model. For an empty Edge selection, ask them to pin nearer a boundary or switch to Surface.

## Use the selection for the edit

Whenever the requested edit depends on a selected region, identify its geometry before the first CAD edit. Read the STL at the captured or highlighted mesh path and use its triangles to drive the edit. If the reference is a saved surface name, resolve its triangles on the current model. Carry the same selection through follow-ups while it remains the intended target. Resolve it again if the model revision changes. The hit point identifies where the person clicked. The full selection determines the region’s extent.

When another part must fit the selection, derive its mating geometry from the selected surface or the 3D edge it shares with adjacent faces. Check clearance and overlap across the full interface, including edges and corners, before reporting the fit.

## Show the region

Read the current `meshState` context and inspect the selected model's source before choosing coordinates. Whenever you refer to a part such as a chin, jaw, cheek, eye, rim, or crease, first show that part with `viewer_highlight`, except when the continuous cut-line guide already shows the requested cut. Explain it as the teal highlighted area with a simple positional description. Do not assume the person knows anatomical or modelling terms. For several distinct parts, highlight and discuss one at a time; a combined highlight is appropriate only when the person is choosing the combined edit region. Named parts can help identify a region, but one mesh may contain many meaningful features. Describe left and right from the person's current view or use an unambiguous feature; do not silently switch between the wearer's and viewer's perspective.

For an editable model loaded with `viewer_load`, call `viewer_highlight` with `design.path` or `selectedModel` and the exact `design.revision` and `design.url` from the current `meshState` context. Give the region a short descriptive label. If you choose the geometry for a proposed region, write its surface overlay as ASCII or binary STL in the project outside the watched model directory, for example `artifacts/highlights/region.stl`. Supply its project-relative `meshPath`. Use model-local millimetres, Z up, with part transforms applied before viewer placement.

When the geometry supports a useful feature name, supply `regionName` and use a fresh path for each distinct overlay. Use the person's language and choose words they can reuse, such as “tail tip” or “inner corner of the tail.” Match the name to the triangles the overlay covers. If the person asks what they pointed at, show the captured selection before answering. Leave the name unset when the geometry only supports an unnamed patch.

Copy evaluated triangles from the source for exact parts. For steering-wheel spokes and wheel axles, put just those disconnected patches in one STL. For a band on a curved body, clip copies of the body faces to the band and export the resulting surface. The viewer draws the submitted triangles directly. A closed cutting volume would display its own faces. `build123d` parts are already in model-local millimetres, Z up; keep the editable source intact.

The tool waits for a matching receipt from the visible viewer. Only `rendered` confirms rendering; `not_rendered` or `superseded` does not. On failure, explain that the highlight is not confirmed, ask the person to open the preview, and retry. Never say “I have highlighted it” before a `rendered` result. Rendering still does not establish that the person saw or approved it. Use their reply in context, including corrections or a choice you offered. On `stale_model`, read the state again and resolve build errors. Ask for a fresh pin for a person's selection or recompute a proposed region against the new source. Highlights are temporary and clear when the source revision changes or another model loads. Imported STL objects do not support this tool.

## Establish the change

Ask one short question in the conversation about the uncertainty that matters, then wait for a spoken or typed reply. Do not use a questionnaire or require clicking an option. For an eye region, distinguish enlarging the openings from widening the surrounding material. Establish whether bigger means wider, taller, thicker, or more raised when the context does not settle it. Do not infer exact edit boundaries from the soft highlight.

When the person corrects the region, stop work based on the previous region, replace the overlay mesh, and clarify any remaining ambiguity. Keep their requested change in context. Do not make unrelated improvements while waiting. Hiding the highlight is a viewing preference, not approval. Confirmation of a region is not authorization for an unrelated change or a print.

When the requested change is clear, follow `mesh-edit-controls` if the person wants to adjust it themselves; prepare a faithful live binding without applying their edit first. For a direct edit, change the model source and inspect the resulting preview and measurements. Clear an obsolete reference with `meshPath: ""`, using the current model identity and an empty label. Explain changes using the person's feature names rather than coordinates or triangle indices. Only refer to labels or viewer controls that actually exist; do not invent hover labels.

Surface selection follows geometric boundaries such as creases and material seams. Check the captured mesh before naming an anatomical feature. For bilateral changes, inspect the model’s actual symmetry and highlight both intended regions; do not assume its symmetry axis or silently treat one side as both. Selection phrases change presentation only and never authorize an unrelated geometry edit.

## Example

For “make the eyes bigger,” highlight both eyes if both are intended. If the geometry leaves two plausible edits, ask whether to enlarge the openings or widen the surrounding material. If the requested effect is clear, proceed.
