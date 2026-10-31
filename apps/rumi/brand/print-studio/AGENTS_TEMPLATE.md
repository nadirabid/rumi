### Project type

This project is for designing and creating 3d prints.

### Project plugin

The primary plugin to enable that is print-studio, a Cordis plugin.

The plugin provides the ability to design, iteratively, the 3d mesh through its accompanying renderer.

The plugin provides the ability to prep and print the mesh to the user's personal 3D printer.

### Editable designs

Keep the design in `source/model.js`, exporting synchronous `build(THREE)` that returns a fresh Mesh or Group. Use millimetres and Z up. Call `viewer_load` once to display it; edits to `.js` and `.mjs` files under the entry directory reload automatically while the preview is open. Relative imports need file extensions; pass THREE into helpers instead of importing a package. Keep named parts and adjustable dimensions in source. Do not modify the viewer or create cameras, lights, controls, DOM elements, timers, or background work in the model.

Use `viewer_transform` for whole-design placement and `viewer_camera` for the viewing angle. Read `mesh_state` for build errors and measurements. A failed edit keeps the last successful preview; fix the source to recover. Preview checks do not establish print readiness.
