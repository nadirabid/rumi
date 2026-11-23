---
name: name-model-regions
description: "Name model features from rendered images, model source and mesh measurements."
---

# Name model regions

Read the construction source when available. Use background Blender from `blender_status` to render the saved USD from two useful angles into project scratch storage. Open both PNGs with `read_image`. Render and open a close-up when details are hard to distinguish.

Name the recognizable parts first. On creation or refresh, inspect each broad region for smaller features someone could point to or change independently. Repeat inside those features wherever the geometry supports another distinction. A handle might contain a grip with a thumb rest. A lip, recess or transition can be distinct even on one smooth surface. Keep uniform areas whole unless a landmark, a functional direction such as a vehicle's front, or the person's explicit request distinguishes specific sections. Use short names in the person's language and add familiar aliases.

Call `viewer_analyze_surfaces` with the saved USD `path` for its `sourceHash` and part paths. Pass an exact `partPath` array and `sourceHash` to list a part's connected surfaces. Follow `nextOffset` as needed. Match the images and source to the reported positions, bounds, and normals, then bind physical features to those triangles.

Save `model.regions.json` beside the final `model.usda` with that `sourceHash` and an ordered `regions` array. Give each region a stable lowercase hyphenated `id`, a `name` and a `location`. Keep accurate existing names and replace legacy boxes around physical features with triangle selectors. For overlapping regions without a parent-child relationship, put the more specific region first.

For a `surface`, copy the part path and surface IDs from the tool.

```json
{"id":"foot","name":"Foot","location":{"kind":"surface","parts":[{"partPath":["Cup","Body"],"surfaceIds":[6,9]}]}}
```

Use multiple `parts` for a feature that spans meshes. For a patch within one smooth surface, request `includeMesh: true` and use the viewer-ordered STL at `mesh.path` to choose zero-based `faceRanges` of `[start, endExclusive]`. Omit both selectors for a whole part. Use a captured selection when the person supplied one.

Set each surface detail's `parentId` to its nearest named parent. Select a strict subset of that parent's triangles so zoom reveals a smaller highlight at each level.

For spatial features, use saved model-local millimetres with Z up.

- `curve` takes `points` along a path and `closed: true` for a loop.
- `point` takes a single XYZ `point`, such as a pivot.
- `volume` takes `boxes` of `[minX, minY, minZ, maxX, maxY, maxZ]` for space such as hinge clearance.

## Verify the saved map

After saving, call `viewer_analyze_surfaces` with the model `path` and `coverage: true`. Read the uncovered triangle and area totals. Inspect gaps by passing `partPath` and follow `nextOffset` with the returned `sourceHash` and `regionMapKey`. Copy `surfaceIds` or `faceRanges` from the returned selection. When given `faceRangesPath`, read the ranges from that file. A connected surface can contain already named triangles.

Extend an existing name when it belongs on the omitted geometry, or add a name for a distinct feature. Leave uncertain patches unnamed and tell the person about significant gaps that remain. Rerun the audit after changing the map and use the final results when describing coverage.

Load the saved map with `viewer_load` and repair any reported region errors. Use `viewer_highlight` with a name and the current model identity to check the selection against neighboring features.
