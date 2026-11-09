### Project type

This project is for designing and creating 3d prints.

### Project plugin

The primary plugin to enable that is print-studio, a Cordis plugin.

The plugin provides the ability to design, iteratively, the 3d mesh through its accompanying renderer.

The plugin provides the ability to prep and print the mesh to the user's personal 3D printer.

### Editable designs

Use background Blender Python scripts for saved mesh assets and Three.js for viewing or parameterized interactive models. When someone asks to adjust a model themselves, read `interactive-controls` and open labeled controls bound to real parameters before making the adjustment. Call `blender_status`, then read the `blender-modeling` skill. Keep editable `.blend` originals and immutable revisions under `models/<name>/revisions/`; publish `models/<name>/model.glb` with the provided helper. Create a separate model only after an explicit user request or agreement; otherwise edit the existing model and keep its revisions in the same model folder. Preserve existing models when adding an authorized model. The viewer discovers model folders and reloads completed GLB exports automatically.

Blender works in metres, Z up. Standard GLB files use metres, Y up; the viewer converts them to millimetres, Z up. Cursor and highlight regions are model-local millimetres before viewer placement: divide by 1,000 for Blender and respect object transforms. Keep named parts and modifiers. Use the existing shell tool to execute scripts with Blender's `--background --python-exit-code 1 --python` options; no Blender window is needed.

Call `viewer_load` with a GLB path to bring it into view; use the current `meshState` context for models, selection, load errors and measurements. Self-contained static GLB previews support at most 64 MiB and 200,000 triangles. Keep detailed print originals when explicitly making a lighter preview. Failed exports or loads retain the last successful preview and are not completed edits. Use `viewer_transform` for placement and `viewer_camera` for the viewing angle. Preview checks do not establish print readiness.

Executable `model.js`/`model.mjs` previews are disabled by project isolation. Preserve them when migrating their actual geometry into Blender. Do not modify the viewer or approximate an existing model from a screenshot.

### Movable prints

Build physical connectors and publish a complete assembly for multi-part or movable models, following `blender-modeling` and `interactive-controls`. Include every mesh, pin, cap, connection and movement control; preserve requested movement and full ranges during repairs. Completed turns automatically check changed candidates with Blender and whole-assembly Bullet contact probes. Blocking findings and unverified mechanical checks trigger bounded repair turns. Models remain visible while validation and repair run. Read the matching `meshState.validation` report before claiming acceptance. Unsupported or incomplete checks remain unverified; a probe pass does not certify material strength or print readiness.

### Model references

Use the request's captured model selection as a default for an unnamed model, with explicit names and captured pointing references taking precedence. Later browsing does not redirect ongoing work. Clarify conflicting references before editing. Call `viewer_working_model` with a discovered entry before inspecting or editing it; update the declaration when changing targets and clear it before clarification. The green dot identifies your declared work independently of the selected model and clears when your agent stops. Read the current `meshState` context for both selection and working models. Use `viewer_load` only to change what the person sees.

The viewer renders every source through GLB in Three.js. Keep editable originals; Publish data-only GLB from the confined modeling tools; STL imports are converted automatically. Declare assembly joints for movement controls; temporary edit controls use the supported GLB deformation operations.
