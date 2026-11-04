---
name: blender-modeling
description: Create, import, or edit Rumi meshes using background Blender Python scripts, then inspect and iterate in the Three.js viewer. Use for model creation and geometry edits.
---

# Blender modeling

Call `blender_status` for the executable and helper paths. Run Blender through the ordinary shell tool, using its permissions and cancellation; do not build a separate execution service. If Blender is unavailable, report the setup action returned by the tool.

## Edit and publish

1. Read `mesh_state` and the existing project files. Preserve existing models. For an existing Blender model, find its latest successful revision report under `models/<name>/revisions/` and open that report's `blend` path. Use the selected revision when the user asks to revert. For a GLB or STL import, use the helper's `import_mesh`. Legacy JavaScript models remain viewable; migrate their actual geometry rather than approximating it from screenshots. Do not overwrite their source.
2. Write a reproducible Python script under `source/`. Run `"<executable>" --background --factory-startup --python-exit-code 1 --python "<script>"`. This runs a full Blender process without a window; ordinary system Python cannot import `bpy`.
3. Work in **metres, Z up** in Blender. Rumi's viewer, measurements and Gaussian regions use **millimetres, Z up**. Divide model-local cursor/highlight coordinates and radii by 1,000 before using them in Blender; account for object transforms when selecting vertices. Standard GLB export/import handles Y-up conversion. Do not apply viewer placement to an editing selection twice.
4. Use Blender's modifiers and mesh operations. For symmetric objects construct one half and mirror it about an explicit plane; measure symmetry after evaluated modifiers. Keep planar faces planar, bevel widths consistent, sharp boundaries deliberate, and smooth normals confined to intended smooth surfaces. More subdivisions or smooth shading alone do not correct a lumpy silhouette. Inspect front, side and three-quarter views. Distinguish topology checks from visual/reference fidelity.
5. Load the helper returned by `blender_status` with `helper = runpy.run_path(helper_path)`, then call `helper["publish"]("models/<name>")`. Use `runpy` so importing the helper does not write bytecode into the installed application. It saves an immutable `.blend` and GLB revision, prints the paths, and atomically updates `model.glb`. Keep named parts and modifiers in the editable original. Preview limits are 200,000 triangles and 64 MiB; preserve detailed assets separately if a lighter preview is required. Do not silently simplify the print deliverable.
6. Call `viewer_load` on `models/<name>/model.glb`; read `mesh_state` after the viewer measures it. Subsequent completed exports reload automatically. Use `viewer_camera`, `viewer_cursor_snapshot`, and `viewer_highlight` for iteration. A failed script/export/load is not a completed edit. Retain the previous revision, report the failure, and fix it.

## Pointed regions and printing

Use `printer-awareness` before supplying a build volume or making printer-specific fit, nozzle or filament claims.

Use the cursor snapshot associated with the request and visually ground named regions through `viewer_highlight`, following `clarify-mesh-changes`. Check the model revision before editing; a Gaussian region is a soft reference, not an exact vertex selection or semantic part boundary. Changes to topology invalidate old triangle indices.

Keep `.blend` files as editable originals and GLB as viewing artifacts. Export print meshes separately from the intended evaluated solids and verify units, wall thickness, manifoldness, fit, supports and slicer output using `fdm-design`. Blender operations and viewer checks do not certify print readiness. Whole-model placement still uses `viewer_transform`; it does not rewrite the Blender original.
