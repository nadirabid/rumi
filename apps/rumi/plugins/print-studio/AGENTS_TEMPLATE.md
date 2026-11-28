### Project type

This project is for designing and creating 3d prints.

### Project plugin

The primary plugin to enable that is print-studio, a Cordis plugin.

The plugin provides the ability to design, iteratively, the 3d model through its accompanying renderer.

The plugin provides the ability to prep and print the model to the user's personal 3D printer.

### Editable designs

Use `build123d` B-Rep CAD Python scripts for saved 3D models and Three.js for viewing. When someone asks to adjust a model themselves, read `mesh-edit-controls`, infer the desired geometric variation and preserved features, and choose or construct faithful bindings before exposing controls. Generate model-specific fields when appropriate; do not depend on prepared presets or silently substitute a completed edit. Call `cad_status`, then read the `cad-modeling` skill. Keep reproducible `build123d` scripts under `source/` and immutable STEP, B-Rep, and USD revisions under `models/<name>/revisions/`; publish `models/<name>/model.usda` with the provided helper. Create a separate model only after an explicit user request or agreement; otherwise edit the existing model and keep its revisions in the same model folder. Preserve existing models when adding an authorized model. The viewer discovers model folders and reloads completed USD exports automatically.

`build123d` works directly in **millimetres, Z up** — matching the viewer, measurements, cursor snapshots, and highlight regions with no unit scaling. Standard exported USD files use metres, Z up; the helper and viewer handle that conversion automatically. Keep named parts and parametric construction in your source scripts. Use the existing shell tool to run scripts with the `cad_status` Python executable (`"<executable>" "<script>"`); no GUI window is needed.

Call `viewer_load` with a USD path to bring it into view; use the current `meshState` context for models, selection, load errors and measurements. Self-contained static USD previews support at most 64 MiB and 200,000 triangles. Keep detailed STEP/B-Rep originals when explicitly making a lighter preview. Failed exports or loads retain the last successful preview and are not completed edits. Use `viewer_transform` for placement and `viewer_camera` for the viewing angle. Preview checks do not establish print readiness.

Executable `model.js`/`model.mjs` previews are disabled by project isolation. Preserve them when migrating their actual geometry into `build123d`. Do not modify the viewer or approximate an existing model from a screenshot.

### Movable prints

Build physical connectors and publish a complete assembly for multi-part or movable models, following `cad-modeling`, `printable-joints` and `control-widgets`. All moving physical parts must print separately and assemble afterward; follow the separate-printing requirement in `printable-joints` before designing connectors. Preserve rotation and sliding after assembly. Do not offer print-in-place, silently relabel captive geometry, or fix moving joints to bypass this requirement. Use a compatible `printable-joints` recipe for each wheel, hinge, slider, bayonet, snap, or gear before designing one by hand. Include every mesh, pin, cap, axle, connection, disassembly step, and movement control; preserve requested movement and full ranges during repairs. Keep at least 0.3 mm between separate moving parts and capture parts with assembled retainer geometry rather than tight fits; see `cad-modeling`. Use findings from each publish (`RUMI_CHECKS`) to guide iteration. When the design is ready, resolve blocking findings and follow the finished-revision workflow in `cad-modeling`. The open viewer refreshes checks for the selected saved revision automatically; explicit validation tools reuse completed stages. No automatic repair turns run. Models remain visible while validation and repair run. Read the matching `meshState.validation` report before claiming acceptance. Unsupported or incomplete checks remain unverified; a probe pass does not certify material strength or print readiness.

### Model references

Use the request's captured model selection as a default for an unnamed model, with explicit names and captured pointing references taking precedence. Later browsing does not redirect ongoing work. Clarify conflicting references before editing. Call `viewer_working_model` with a discovered entry before inspecting or editing it; update the declaration when changing targets and clear it before clarification. The green dot identifies your declared work independently of the selected model and clears when your agent stops. Read the current `meshState` context for both selection and working models. Use `viewer_load` only to change what the person sees.

The viewer renders every source through USD in Three.js. Keep editable `build123d` source scripts and STEP/B-Rep revisions; publish data-only USD from the confined modeling tools; STL imports are converted automatically. Declare assembly joints for movement controls; temporary edit controls use the supported USD preview deformation operations and freeze a recipe JSON that you translate back into exact B-Rep CAD edits.
