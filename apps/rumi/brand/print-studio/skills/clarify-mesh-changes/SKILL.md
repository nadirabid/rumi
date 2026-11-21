---
name: clarify-mesh-changes
description: Establish which region of a 3D model a person means and what change they want. Use visual references when words such as this part, around the eyes, bigger, or rounder leave materially different edits possible.
---

# Clarify mesh changes

Use ordinary language and the visible model to establish a shared reference. Use a highlight to visually ground region-specific edits and named parts. Follow clear requests, including undo and selections from choices you offered. Ask for clarification when the intended region or action is ambiguous; do not require a special confirmation phrase.

## Name the whole model for hover

Inspect the actual current USD geometry and its source. Save `model.regions.json` beside `model.usda`, using the file's SHA-256 as `sourceHash`. Set `remainder` to the name of the main surface left after distinguishing the meaningful features. Set `regions` to an ordered array of objects with lowercase hyphenated `id`, short `name`, and `boxes`. Each box is `[minX, minY, minZ, maxX, maxY, maxZ]` in saved model-local millimetres before viewer placement. Use up to 96 regions and up to 16 boxes per region. The first region whose box contains the visible surface point supplies the label. Place small details before their larger features and use several boxes when a feature curves or changes direction. Verify that neighboring features receive their own names from multiple views. Update the region map when you publish a changed mesh.

Hover shows the saved feature name immediately. Clicking the surface pins its name, and activating the pinned label attaches it to the next request. Names should be familiar enough to reuse, with specific terms such as “tail base” and “inner bend” where the geometry supports them.

## Identify the region

For a continuous planar cut, use the guide provided by `viewer_controls` with operation `cut` as the visual reference. It traces the actual live cut across the selected parts and moves with the controls. Do not arrange separate patches around the rim. Opening cut controls clears previous overlays; resolve the cut before highlighting a different region. A `rendered` control result confirms the cut guide.

For each new request about a mark, use the cursor capture attached to that utterance or call `viewer_cursor_snapshot` again. Check the captured model identity against the currently displayed revision. Use `region.modelLocalPoint` for geometry, along with the part, hit triangle and selection scope. Movement can change the pictured pose and `worldPoint`; the model-local point remains on the saved surface. When confirming a face, check that the saved point lies on the seed triangle before expanding across that surface. When a capture fails or is stale, explain the issue and ask for a fresh pin. Do not choose a substitute region or use an earlier capture.

Read the current `meshState` context and inspect the selected model's source before choosing coordinates. Whenever you refer to a part such as a chin, jaw, cheek, eye, rim, or crease, first show that part with `viewer_highlight`, except when the continuous cut-line guide already shows the requested cut. Explain it as the teal highlighted area with a simple positional description. Do not assume the person knows anatomical or modelling terms. For several distinct parts, highlight and discuss one at a time; a combined highlight is appropriate only when the person is choosing the combined edit region. Named parts can help identify a region, but one mesh may contain many meaningful features. Describe left and right from the person's current view or use an unambiguous feature; do not silently switch between the wearer's and viewer's perspective.

For an editable model loaded with `viewer_load`, call `viewer_highlight` with `design.path` or `selectedModel` and the exact `design.revision` and `design.url` from the current `meshState` context. Give the region a short descriptive label. Write a surface overlay as ASCII or binary STL in the project, for example `artifacts/highlights/region.stl`, outside the watched model directory. Supply its project-relative `meshPath`. Use model-local millimetres, Z up, with part transforms applied before viewer placement.

When the geometry supports a useful feature name, supply `regionName` and give the overlay a fresh filename. Use the person's language and choose words they can reuse, such as “tail tip” or “inner corner of the tail.” Match the name to exactly what the overlay covers. If the person asks what they pointed at, capture the point, inspect the source and show the named region before answering. Leave the name unset when the geometry only supports an unnamed patch. An attached chat reference appears as `regionAtAdmission` alongside the message ID in `modelFocus.requests`.

Copy evaluated triangles from the source for exact parts. For steering-wheel spokes and wheel axles, put just those disconnected patches in one STL. For a band on a curved body, clip copies of the body faces to the band and export the resulting surface. The viewer draws the submitted triangles directly. A closed cutting volume would display its own faces. For Blender sources authored in metres, transform evaluated triangle vertices by the object world matrix and multiply by 1000 once. Keep the editable original intact.

The tool waits for a matching receipt from the visible viewer. Only `rendered` confirms rendering; `not_rendered` or `superseded` does not. On failure, explain that the highlight is not confirmed, ask the person to open the preview, and retry. Never say “I have highlighted it” before a `rendered` result. Rendering still does not establish that the person saw or approved it. Use their reply in context, including corrections or a choice you offered. On `stale_model`, read the state again and recompute against the new source; resolve build errors first. Highlights are temporary and clear when the source revision changes or another model loads. Imported STL objects do not support this tool.

## Establish the change

Ask one short question in the conversation about the uncertainty that matters, then wait for a spoken or typed reply. Do not use a questionnaire or require clicking an option. For an eye region, distinguish enlarging the openings from widening the surrounding material. Establish whether bigger means wider, taller, thicker, or more raised when the context does not settle it. Do not infer exact edit boundaries from the soft highlight.

When the person corrects the region, stop work based on the previous region, replace the overlay mesh, and clarify any remaining ambiguity. Keep their requested change in context. Do not make unrelated improvements while waiting. Hiding the highlight is a viewing preference, not approval. Confirmation of a region is not authorization for an unrelated change or a print.

When the requested change is clear, follow `mesh-edit-controls` if the person wants to adjust it themselves; prepare a faithful live binding without applying their edit first. For a direct edit, change the model source and inspect the resulting preview and measurements. Clear an obsolete reference with `meshPath: ""`, using the current model identity and an empty label. Explain changes using the person's feature names rather than coordinates or triangle indices. Only refer to labels or viewer controls that actually exist; do not invent hover labels.

Cursor driven mesh highlighting uses local patch, connected surface, whole part, and boundary edge scopes. A captured `region.selection` identifies the exact part path and geometric surface for this source revision; use it to identify source geometry for the teal overlay. Surface boundaries follow creases, material seams, and disconnected pieces, not inferred anatomical names. Short voice phrases such as “whole panel”, “whole part”, “just the edge”, “larger selection”, and “smaller selection” refine the original pointing reference locally. Use the refined attached snapshot; never substitute a later hover. For bilateral changes, inspect the model’s actual symmetry and highlight both intended regions; do not assume its symmetry axis or silently treat one side as both. Selection phrases change presentation only and never authorize an unrelated geometry edit.

## Worked examples

**Clear request, no ambiguity.** "Make the eyes bigger." Region is settled by the model's face; see it, call `viewer_highlight` on both eye regions in one highlight because both are meant, and move on to the edit. Do not ask a question you do not need answered.

**Ambiguous size word.** "Make the eyes bigger." The openings might grow, or the surrounding material might widen. Highlight the openings, describe them as the teal area, and ask one question: "Should the eye openings get larger, or the material around them get wider?" Wait for the reply before computing anything.

**Ambiguous region.** "Make this part rounder", with the cursor over the shoulder. The pointing reference narrows it, but "rounder" has several meanings. Capture with `viewer_cursor_snapshot`, highlight the pointed region, then ask whether they mean the outer contour or the local bulge. One question, not a list.

**Correction.** The person said "the chin", you highlighted the whole jaw, and they say "no, just the chin". Stop work on the jaw region, replace the overlay mesh with a smaller chin-only highlight, and confirm the new region in plain words. Keep the change they want in context; the correction concerns the region, not the request.

**Pointing with nothing captured.** The person points and says "this bit's too thin", but the capture returns `no_hit`. Ask them to keep the pointer over the intended surface and retry. Do not guess a region from the words alone, and do not reuse an earlier capture.

**Authoritative but unrelated.** The person says "yes, that's the right spot" and then "now delete the eyes completely". Confirming the region authorized the highlight, not a geometry deletion. Treat the deletion as a new request with its own ambiguity.

## Asking well

Ask about the uncertainty that changes the edit, not about things you can observe.

- Ask: "Wider or taller?" when both are plausible and produce different geometry.
- Ask: "Which side?" when the model is not symmetric and the request names one feature.
- Do not ask: "Is this the chin?" when a highlight already shows them the chin.
- Do not ask: "Should I proceed?" Confirmation of a region is not a confirmation step; follow the person's clear request when it is clear.
