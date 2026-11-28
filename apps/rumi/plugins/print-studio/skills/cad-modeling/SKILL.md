---
name: cad-modeling
description: "Create, import, revise, or restore B-Rep CAD models with build123d Python. Publish and validate STEP and editable USD revisions."
---

# CAD modeling

Call `cad_status` for the bundled `build123d` Python executable, export helper, and joints kit paths. Run scripts through the ordinary shell tool (`"<executable>" "<script>"`), using its permissions and cancellation; do not build a separate execution service. If the CAD runtime is unavailable, report the setup action returned by the tool.

## Use checks at each stage

- **Explore drafts.** Keep testing alternatives while draft findings are open. Fix a defect immediately when it prevents the next experiment. Compare drafts against the requested silhouette, details and dimensions, and keep the best draft for comparison.
- **Refine the fit.** Once the parts have the intended shape, check exact surface clearances and per-part print orientation findings in `RUMI_CHECKS`. After each repair, verify that shape, wall thickness, and fit still meet the request. If an error count goes down but the design gets worse, return to the better draft and try a different construction.
- **Validate the chosen revision.** Resolve blocking geometry and fit errors before calling `validation_mechanics` or `validation_accept`. A draft with open findings can still be used for visual review.

## Start from the joints kit

For any model with more than one part, or with a wheel, hinge, slider, snap, bayonet, fastener, or gear, read [printable-joints](../printable-joints/SKILL.md) first and build with its kit (`joints` path from `cad_status`). It supplies millimetre `build123d` primitives, clean Boolean helpers, separate-print joint recipes, disassembly actions, and `K.publish`, which writes the STEP, B-Rep, and USD assembly in one call. Design moving parts for [separate printing and assembly](../printable-joints/SKILL.md#separate-printing-for-moving-parts); this is required, not a choice.

## Solid construction defaults

Use these defaults from the first modeling operation, including edits to existing models. They produce valid OpenCASCADE B-Rep solids and reduce print defects, though they do not certify print readiness.

- Work directly in **millimetres, Z up** using `build123d` (`Box`, `Cylinder`, `Sphere`, `Cone`, `extrude`, `revolve`, `loft`, `sweep`, and 2D sketches). Cursor snapshots, measurements, and highlight regions use the exact same model-local millimetre Z-up coordinates.
- Give every physical part a unique `.label` (its part name) and an optional `.color` (`(r, g, b)` tuple in `0..1` or `build123d.Color`). Each part must be a single closed `Solid` (not disconnected shells in one part).
- Fuse material with exact B-Rep Boolean union (`a + b`) and cut holes with Boolean difference (`a - cutter`). Give fused pieces meaningful overlap (at least 0.5 mm) and extend through-hole cutters past both outer faces. Keep separate mechanical parts and their clearances distinct.
- Build the primary solid before adding `fillet` or `chamfer` edges. Keep fillet and chamfer radii strictly smaller than adjacent wall thicknesses and edge lengths, and check `BRepCheck` status in `RUMI_CHECKS`.
- For symmetric objects, construct one half and mirror it cleanly (`mirror(part, Plane.YZ)` or `K.mirror`). Keep mating surfaces, bores, and resting faces analytically flat or cylindrical for accurate printing and clean print-bed orientation.
- Design each separate part with a flat resting face when practical so it prints cleanly without unnecessary supports. Inspect `printOrientations` in `RUMI_CHECKS` and `report.json` to check each part's bed-contact area and overhangs in its optimal print orientation rather than its assembled pose.

## Edit and publish

1. Read the current `meshState` context and the existing project files. Create another model folder only when the user explicitly requests or agrees to a separate model; clarify ambiguous intent before writing files. For edits and fixes, revise the script in `source/` and publish new revisions in the existing model folder. Preserve existing models. For an imported STEP or B-Rep asset, use `helper["import_step"](path)` or `helper["import_brep"](path)`. Legacy JavaScript previews are disabled by project isolation; migrate their actual geometry into `build123d` rather than approximating it from screenshots.
2. Write a reproducible Python script under `source/` (for example `source/build_car.py`). Run `"<executable>" "source/build_car.py"` through the shell tool.
3. Load the helper returned by `cad_status` with `helper = runpy.run_path(helper_path)` so importing never writes bytecode into the installed application. Call `helper["publish"]("models/<name>", parts, assembly=...)` (or `K.publish(...)` from the joints kit).
4. `publish` tessellates each B-Rep solid cleanly (<= 200,000 triangles and <= 64 MiB), saves an immutable revision under `models/<name>/revisions/<uuid>/` containing `model.step`, `parts/<name>.brep`, `assembly.json`, `model.usda`, and `report.json`, atomically updates `models/<name>/model.usda`, prints `RUMI_MODEL <json>`, and spawns `cad/validate.py` to print `RUMI_CHECKS <json>`.
5. Call `viewer_load` on `models/<name>/model.usda`. Saved models display independently of validation. Inspect `RUMI_CHECKS` (exact `BRepExtrema` part clearances, solid validity, and per-part print-orientation overhangs/bed contact) and `meshState.validation`. Use `viewer_camera`, `viewer_cursor_snapshot`, and `viewer_highlight` for visual inspection.
6. Before ending the turn, follow [Name Model Regions](../name-model-regions/SKILL.md) for the final revision you leave saved.

## Undo and revision restore

To revert to an earlier saved revision, call `helper["restore_revision"]("models/<name>", "<revision-directory-name>")` instead of rebuilding it. Identify the intended revision from its `report.json` and preview; do not guess from directory ordering. Restoration atomically restores the exact saved `model.usda`, retains all revisions, and returns the matching `step` and `brep` paths. Call `viewer_load` on `models/<name>/model.usda` afterward. Restoration leaves validation pending; run explicit validation before claiming acceptance.

## Translate frozen visual edit controls to B-Rep

When the person uses `viewer_controls` to explore a shape or planar cut visually on the USD preview and accepts their adjustment:

1. Freeze the controls with `viewer_controls` (`action: freeze`) to write the recipe JSON under `artifacts/shape-controls/`.
2. Load the recipe in your `build123d` script with `recipe = helper["load_control_recipe"](recipe_path)` and inspect `summary = helper["summarize_control_recipe"](recipe)`.
3. Apply the frozen input cleanly in exact B-Rep:
   - **Planar cut (`operation == "cut"`):** call `part = helper["cut_solid"](part, recipe)` on each target solid to perform an exact B-Rep half-space cut with planar capping and preserved cavity openings.
   - **Deformations (`bulge`, `bend`, `twist`, `taper`, `surface`, `fields`):** read the frozen values, target planes, profile station shifts, or displacement summary from `summary`, then update your parametric `build123d` dimensions, sketch points, lofts, sweeps, or fillets to realize that exact shape in clean B-Rep while preserving wall thickness, mating faces, and joint clearances.
4. Publish the updated B-Rep model, reload with `viewer_load`, and confirm `RUMI_CHECKS` and `meshState` before reporting the saved edit.

## Declare physical movement

Every multi-part or movable model requires a complete assembly description. Give each physical piece a unique part name and include retaining pins, caps, and axles. Disconnected solids cannot become one rigid piece by grouping them. Preserve requested features, connectors, names, controls, and movement ranges through repairs.

Use [Printable Joints](../printable-joints/SKILL.md) for kit-built assemblies. For custom assembly authoring, follow [USD assembly declarations](references/usd-assembly.md) for joint frames, retainers, disassembly actions, limits, and metadata.

## Movement controls

Use [control-widgets](../control-widgets/SKILL.md) to choose widgets and labels. Publish control layout changes in a model revision. Operating those controls afterward changes only the local preview pose, not saved geometry or validation input; pose changes need no freeze or save. Keep physical joint declarations and connectors intact when editing the UI.

Without UI declarations, revolute and prismatic joints generate sliders labeled by `rumi:control` or the child mesh name. To choose widgets, pass `controls` to `K.publish` (or set `assembly["controls"]` / `rumi:motionControls`). Each item has `kind`, `label`, and `axes`; each axis references an absolute joint prim path and may set `step`:

```python
controls = [dict(kind="pad", label="Aim", axes=[
    dict(joint="/Model/Joints/Pan", step=1),
    dict(joint="/Model/Joints/Tilt", step=1),
])]
K.publish("models/turret", root=base, joints=joints, mode="separate",
          steps=steps, controls=controls)
```

A slider or curve references one movable joint; a pad references two independent movements, horizontal then vertical. Joint limits supply axis ranges; reset returns to the saved pose at zero. Steps use degrees for rotation and millimetres for translation; defaults are 1 degree or 0.1 mm, capped to the range width. UI declarations cannot override limits or reset. Unspecified movements retain automatic sliders.

Joints sharing `rumi:control` share one value and must use matching units and overlapping limits. Reference that group once through any member joint. Repeated bindings, missing or fixed joints, unsupported widgets, and invalid steps withhold movement controls with a viewer diagnostic; geometry stays visible. The preview supports trees with up to 12 independent movements and preserves fixed descendants. Closed loops remain unsupported.

After publishing, inspect `viewer_load` feedback under `design.motion` and exercise each axis and reset. Invalid UI metadata does not change the physical validation result. Preview movement does not establish mechanical feasibility. Temporary mesh edits disable movement controls while keeping the panel visible. Reset the pose before source-bound cursor edits.

## Clearances and retention

Keep at least 0.3 mm between separate moving parts everywhere in the saved pose: radial gaps in bores, end-play, and door-to-frame gaps. `RUMI_CHECKS` measures exact B-Rep surface-to-surface clearance (`BRepExtrema_DistShapeShape`) and reports `insufficient_clearance` as an error below 0.2 mm, listing the pairs and exact gaps. Parts joined by a `fixed` joint may touch flush without error, while overlapping fixed volumes still fail.

Play is expected. Retention passes when the connector stops the part; the pivot may travel up to 2 mm and tilt up to 15°. Never tighten clearances to reduce drift.

Repair `unretained_part` and `unstable_at_rest` by adding or enlarging the capturing feature: a bayonet cap, snap flange, collar wider than the bore, or removable pin with locking cap. Do not tighten the fit. Repair `insufficient_clearance` by widening the listed gaps while keeping the capturing feature.

## Pointing and print export

Follow [Clarify Mesh Changes](../clarify-mesh-changes/SKILL.md) for captured pointing references. Recompute selections after a geometry change. Gaussian regions describe soft influence around a point.

Follow [FDM Design](../fdm-design/SKILL.md) for printability constraints and [Prepare Print Job](../prepare-print-job/SKILL.md) for plate arrangement and Bambu Studio handoff.

## Validate a finished revision

Every `publish` checks the new revision in a clean CAD Python subprocess and prints `RUMI_CHECKS <json>` with B-Rep solid validity, mesh/overhang findings (evaluated per part in its optimal print orientation), exact part-to-part clearance, any assembly declaration error, `printOrientations`, and `dimensionsMm`. Only findings with a nonzero count appear. Read the report after each publish and judge warnings against the intended design. If the status is `unavailable`, call `cad_status` once in this project and publish again.

The open viewer refreshes check status for the selected saved revision without accepting revisions or starting repair turns. Explicit tools reuse completed stages. When the design is ready and `RUMI_CHECKS` has no blocking errors, call `validation_mechanics` once with the model `path`. The host runs any missing assembly, geometry, and fit checks for that revision first and stops with their findings if one blocks. Otherwise it runs Bullet (up to ten minutes), testing whole-assembly contacts, retention, sampled movement, declared sequences, and disassembly `actions` / `path` steps with only the root held. Do not weaken settings, omit parts, narrow movement, or substitute a reduced assembly to obtain a pass; incomplete coverage remains unverified. Then call `validation_accept` with the `path` and `fingerprint` it returned. For moving assemblies, declare disassembly steps for every nonroot part; missing steps produce `assembly_path_required` and block acceptance while retaining motion findings. Only an `accepted` result supports an acceptance claim, and it does not certify slicing, deformation, strength, assembly accessibility, or print readiness. A printer volume that was never configured means printer fit is unchecked.

After any repair or placement change, publish again and repeat for the new revision; never report a previous revision's results as current. Validation never starts follow-up turns, so finish repairs in this turn. Preserve requested features, connectors, controls, and full movement ranges. If checks fail or cannot be resolved safely, report the remaining limitation briefly instead of claiming acceptance.
