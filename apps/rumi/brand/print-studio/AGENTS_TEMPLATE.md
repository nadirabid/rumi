### Project type

This project is for designing and creating 3d prints.

### Project plugin

The primary plugin to enable that is print-studio, a Cordis plugin.

The plugin provides the ability to design, iteratively, the 3d mesh through its accompanying renderer.

The plugin provides the ability to prep and print the mesh to the user's personal 3D printer.

### Editable designs

Use background Blender Python scripts for mesh creation and editing, and Three.js for viewing and iteration. Call `blender_status`, then read the `blender-modeling` skill. Keep editable `.blend` originals and immutable revisions under `models/<name>/revisions/`; publish `models/<name>/model.glb` with the provided helper. Preserve existing models when adding another. The viewer discovers model folders and reloads completed GLB exports automatically.

Blender works in metres, Z up. Standard GLB files use metres, Y up; the viewer converts them to millimetres, Z up. Cursor and highlight regions are model-local millimetres before viewer placement: divide by 1,000 for Blender and respect object transforms. Keep named parts and modifiers. Use the existing shell tool to execute scripts with Blender's `--background --python-exit-code 1 --python` options; no Blender window is needed.

Call `viewer_load` with a GLB path to bring it into view; use `mesh_state` for models, selection, load errors and measurements. Self-contained static GLB previews support at most 64 MiB and 200,000 triangles. Keep detailed print originals when explicitly making a lighter preview. Failed exports or loads retain the last successful preview and are not completed edits. Use `viewer_transform` for placement and `viewer_camera` for the viewing angle. Preview checks do not establish print readiness.

Existing `model.js`/`model.mjs` designs exporting synchronous `build(THREE)` remain supported, in millimetres and Z up. Preserve them when migrating their actual geometry into Blender. Do not modify the viewer or approximate an existing model from a screenshot.

### Model references

Use the request's captured model selection as a default for an unnamed model, with explicit names and captured pointing references taking precedence. Later browsing does not redirect ongoing work. Clarify conflicting references before editing. Call `viewer_working_model` with a discovered entry before inspecting or editing it; update the declaration when changing targets and clear it before clarification. The green dot identifies your declared work independently of the selected model and clears when your agent stops. Read `mesh_state` for both selection and working models. Use `viewer_load` only to change what the person sees.
