### Project type

This project is for designing and creating 3d prints.

### Project plugin

The primary plugin to enable that is print-studio, a Cordis plugin.

The plugin provides the ability to design, iteratively, the 3d mesh through its accompanying renderer.

The plugin provides the ability to prep and print the mesh to the user's personal 3D printer.

### Editable designs

Create and organize independent models in `models/<name>/model.js`, with each model's helpers beside it. The viewer automatically discovers these folders and shows model-selection controls. Call `viewer_load` with a model's path to bring it into view; use `mesh_state` to see the available models and current selection. Keep existing models when adding another.

Each entry exports synchronous `build(THREE)` returning a fresh Mesh or Group. Use millimetres and Z up. Edits to `.js` and `.mjs` files under the entry directory reload automatically while the preview is open. Relative imports need file extensions; pass THREE into helpers instead of importing a package. Keep named parts and adjustable dimensions in source. Do not modify the viewer or create cameras, lights, controls, DOM elements, timers, or background work in the model.

Use `viewer_transform` for whole-design placement and `viewer_camera` for the viewing angle. Read `mesh_state` for build errors and measurements. A failed edit keeps the last successful preview; fix the source to recover. Preview checks do not establish print readiness.
