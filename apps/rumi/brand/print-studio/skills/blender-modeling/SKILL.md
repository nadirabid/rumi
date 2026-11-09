---
name: blender-modeling
description: Create, import, or edit Rumi meshes using background Blender Python scripts, then inspect and iterate in the Three.js viewer. Use for model creation and geometry edits.
---

# Blender modeling

Call `blender_status` for the executable and helper paths. Run Blender through the ordinary shell tool, using its permissions and cancellation; do not build a separate execution service. If Blender is unavailable, report the setup action returned by the tool.

## Edit and publish

1. Read the current `meshState` context and the existing project files. Create another model folder only when the user explicitly requests or agrees to a separate model; clarify ambiguous intent before writing files. For edits and fixes, publish revisions in the existing model folder. Preserve existing models. For an existing Blender model, find its latest successful revision report under `models/<name>/revisions/` and open that report's `blend` path. Use the selected revision when the user asks to revert. For a GLB or STL import, use the helper's `import_mesh`. Legacy JavaScript previews are disabled by project isolation; migrate their actual geometry to GLB using confined tools rather than approximating it from screenshots. Do not overwrite their source.
2. Write a reproducible Python script under `source/`. Run `"<executable>" --background --factory-startup --python-exit-code 1 --python "<script>"`. This runs a full Blender process without a window; ordinary system Python cannot import `bpy`.
3. Work in **metres, Z up** in Blender. Rumi's viewer, measurements and Gaussian regions use **millimetres, Z up**. Divide model-local cursor/highlight coordinates and radii by 1,000 before using them in Blender; account for object transforms when selecting vertices. Standard GLB export/import handles Y-up conversion. Do not apply viewer placement to an editing selection twice.
4. Use Blender's modifiers and mesh operations. For symmetric objects construct one half and mirror it about an explicit plane; measure symmetry after evaluated modifiers. Keep planar faces planar, bevel widths consistent, sharp boundaries deliberate, and smooth normals confined to intended smooth surfaces. More subdivisions or smooth shading alone do not correct a lumpy silhouette. Inspect front, side and three-quarter views. Distinguish topology checks from visual/reference fidelity.
5. Load the helper returned by `blender_status` with `helper = runpy.run_path(helper_path)`, then call `helper["publish"]("models/<name>")`. Use `runpy` so importing the helper does not write bytecode into the installed application. It saves an immutable `.blend` and GLB revision, prints the paths, and atomically updates `model.glb`. Keep named parts, modifiers, and movement declarations in the editable original. Preview limits are 200,000 triangles and 64 MiB; preserve detailed assets separately if a lighter preview is required. Do not silently simplify the print deliverable.
6. Call `viewer_load` on `models/<name>/model.glb`. Saved models display independently of validation. Use `meshState.validation` to inspect findings; a visible model is not a printability pass. Use `viewer_camera`, `viewer_cursor_snapshot`, and `viewer_highlight` for iteration.

## Declare physical movement

Every multi-part or movable model requires a complete assembly description. Give each physical piece a unique mesh name and include retaining pins, caps and axles. Disconnected solids cannot become one rigid piece by grouping or joining their mesh objects. Preserve requested features, connectors, names, controls and movement ranges through repairs and conversions.

Pass `assembly` to the export helper:

```python
helper["publish"]("models/<name>", assembly={
    "version": 1, "root": "frame",
    "parts": [{"id": "frame", "mesh": "Frame"}, {"id": "door", "mesh": "Door"}],
    "connections": [{
        "id": "door-hinge", "parent": "frame", "child": "door", "kind": "revolute",
        "axis": [0, 0, 1], "pivot": [0, 0, 12], "range": [0, 90],
    }],
    "manufacturing": {"mode": "print-in-place"},
})
```

This example requires actual captive connector geometry on Frame and Door. Add every separate pin or cap to `parts` and connect it explicitly. Each part maps to exactly one exported mesh object, and every mesh must be mapped. All parts need a connection path to `root`, the physical piece held by the test fixture. Assemblies support at most 128 parts and 128 connections. Each connection names its parent and child and uses `fixed`, `revolute` or `prismatic`. Fixed connections describe expected attachment without creating a simulated weld. Movable connections require a nonzero `axis`, `pivot` and `range`. Axis and pivot describe the saved world pose before viewer placement; pivot and sliding ranges use millimetres, Z up, even though Blender geometry uses metres. Rotational ranges use degrees. Ranges contain the saved pose at zero and stay within [-180, 180] degrees or [-1000, 1000] millimetres.

The helper stores `assembly` in the editable `.blend` and GLB `asset.extras.rumiAssembly`; omitting it on later publishes retains it. `import_mesh` preserves imported assembly metadata. Compose uniquely named parts and explicitly publish a combined assembly instead of discarding existing declarations. Legacy `mechanisms` declarations require an assembly upgrade and cannot receive a mechanical pass. Loading a project does not rewrite its files.

Optional `sequences` contain named movement paths: `[{"id": "fold", "waypoints": [{"door-hinge": 45}, {"door-hinge": 90}]}]`. Values use each connection's declared units and range. These are intended configurations, not instructions to teleport the simulated pieces. Unsupported coupling or incomplete probe coverage remains unverified. Declare `manufacturing.mode` as `print-in-place` or `separate` according to the actual fabrication plan; choosing a mode does not establish fabrication feasibility. For movement controls, read `interactive-controls` and set each assembly connection's `control` label.

## Pointed regions and printing

Use `printer-awareness` before supplying a build volume or making printer-specific fit, nozzle or filament claims.

Use the cursor snapshot associated with the request and visually ground named regions through `viewer_highlight`, following `clarify-mesh-changes`. Check the model revision before editing; a Gaussian region is a soft reference, not an exact vertex selection or semantic part boundary. Changes to topology invalidate old triangle indices.

Keep `.blend` files as editable originals and GLB as viewing artifacts. Export print meshes separately from the intended evaluated solids and verify units, wall thickness, manifoldness, fit, supports and slicer output using `fdm-design`. Blender operations and viewer checks do not certify print readiness. Whole-model placement still uses `viewer_transform`; it does not rewrite the Blender original.

Print Studio automatically runs Blender geometry validation after each agent turn for changed discovered models, then whole-assembly Bullet contact and movement probes when geometry has no blocking findings. Read `meshState.validation` for revision-specific findings, including `report.mechanics`; `previousReport` is historical. Do not claim the current edit passed before its matching result exists. The checker holds only the root fixture and tests actual mesh contacts while every other piece remains dynamic. It does not create ideal joints that supply missing connectors. Unsupported motion, incomplete checks, deformation, strength and slicing require separate evidence.

Blocking geometry or mechanism findings automatically start a repair turn with model paths and checked revisions. Preserve the requested design, moving parts, physical connectors, and declarations while repairing; do not remove requested features or narrow movement controls merely to hide failures. Repairs are checked again after the turn, with a bounded automatic retry budget. Unverified mechanical checks also trigger bounded repair; static geometry warnings and unavailable checks remain visible in the report without starting geometry repairs. If a repair cannot be made safely, report the remaining limitation briefly; never claim printability from geometry checks alone.
