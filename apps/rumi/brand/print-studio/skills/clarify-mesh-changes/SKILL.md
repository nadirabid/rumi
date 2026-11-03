---
name: clarify-mesh-changes
description: Establish which region of a 3D model a person means and what change they want. Use visual references when words such as this part, around the eyes, bigger, or rounder leave materially different edits possible.
---

# Clarify mesh changes

Use ordinary language and the visible model to establish a shared reference. Clarify uncertainty that affects the edit; do not interrupt an already clear request with a mandatory confirmation sequence.

## Identify the region

Read `mesh_state` and inspect the selected model's source before choosing coordinates. Named parts can help identify a region, but one mesh may contain many meaningful features. Describe left and right from the person's current view or use an unambiguous feature; do not silently switch between the wearer's and viewer's perspective.

For an editable model loaded with `viewer_load`, call `viewer_highlight` with the exact `design.path`, `design.revision`, and `design.url` from `mesh_state`. Give the region a short descriptive label. Supply a few ellipsoidal blobs with `center`, `radii`, and `rotationDegrees`, each a three-number array. Coordinates are millimetres in the model's local frame, after part transforms but before whole-design placement. Rotation uses XYZ Euler degrees. Radii specify nominal extent, not diameter or Gaussian standard deviation. The viewer blends their influence with a fixed soft fade and reveals wireframe within the region.

Start with the smallest collection that covers the intended area. A flattened, tilted blob can cover an eyebrow; two blobs can indicate both eyes without covering the entire forehead. Inspect depth as well as width and height: a blob can also intersect the back of a thin shell. This is an approximate conversational region, not a precise edit mask or a selection of entire connected parts.

A successful request reports `queued`, not that the viewer rendered it or the person saw it. Ask whether the highlighted region matches their intent, allowing them to say it is missing or wrong. On `stale_model`, read the state again and recompute against the new source; resolve build errors first. Highlights are temporary and clear when the source revision changes or another model loads. Imported STL objects do not support this tool.

## Establish the change

Ask one short question in the conversation about the uncertainty that matters, then wait for a spoken or typed reply. Do not use a questionnaire or require clicking an option. For an eye region, distinguish enlarging the openings from widening the surrounding material. Establish whether bigger means wider, taller, thicker, or more raised when the context does not settle it. Do not infer exact edit boundaries from the soft highlight.

When the person corrects the region, replace the complete blob list and keep their requested change in context. Hiding the highlight is a viewing preference, not approval. Confirmation of a region is not authorization for an unrelated change or a print.

Once the request is clear, edit the model source and inspect the resulting preview and measurements. Clear an obsolete reference with `blobs: []`, using the current model identity and an empty label. Explain changes using the person's feature names rather than coordinates or triangle indices. Only refer to labels or viewer controls that actually exist; do not invent hover labels.
