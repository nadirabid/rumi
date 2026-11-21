---
name: blender-modeling
description: "Create, import, revise, or restore meshes with Blender Python. Publish and validate the editable USD revision."
---

# Blender modeling

Call `blender_status` for the executable and helper paths. Run Blender through the ordinary shell tool, using its permissions and cancellation; do not build a separate execution service. If Blender is unavailable, report the setup action returned by the tool.

## Start from the joints kit

For any model with more than one part, or with a wheel, hinge, slider, snap or gear, read `printable-joints` first and build with its kit. It supplies millimetre primitives, cleaned Boolean operations, joint recipes and `K.publish`, which writes the whole USD assembly, so the script needs no `configure_robot`. Design moving parts for [separate printing and assembly](../printable-joints/SKILL.md#separate-printing-for-moving-parts); this is required, not a choice. Revisions, the viewer and validation below apply unchanged.

## Solid construction defaults

Use these defaults from the first modeling operation, including edits to existing models. They reduce mesh defects but do not establish printability.

- Build each physical part from closed solid primitives or capped extrusions of simple, non-self-intersecting profiles with positive thickness. Prefer these methods over manually assembling vertices and faces; avoid zero-thickness surfaces, duplicate geometry and internal faces.
- Use Boolean union to fuse material and difference to cut holes, with `solver = 'EXACT'`. Give solids intended for union meaningful overlap and extend through-hole cutters beyond both outer surfaces. Avoid tangent-only connections and unnecessarily coincident boundaries; inspect the result even with the Exact solver.
- Joining Blender objects does not fuse their geometry. Union pieces intended to form one solid, while keeping separate mechanical parts and their clearances distinct.
- Establish the main solid before bevels and other finishing operations. Keep bevel widths compatible with nearby features and wall thickness; inspect the evaluated result for collapsed features and self-intersections.
- Reserve voxel remeshing for organic geometry where changes to topology, sharpness and detail are acceptable. Preserve the original, choose a voxel size that resolves the smallest required feature, and recheck dimensions. Do not use it as routine repair for threads, mating surfaces, thin walls or moving-part clearances, or remesh separate moving parts into one solid.
- Inspect evaluated geometry after significant topology changes, before building further features on it. `Mesh.validate()` checks and can repair mesh data; it does not establish manifoldness. Use 3D Print Toolbox findings for geometry diagnosis. Prefer correcting the construction that caused a defect over broad automatic cleanup; inspect any cleanup result for lost features and changed dimensions. Before completion, follow the validation workflow below.

## Edit and publish

1. Read the current `meshState` context and the existing project files. Create another model folder only when the user explicitly requests or agrees to a separate model; clarify ambiguous intent before writing files. For edits and fixes, publish revisions in the existing model folder. Preserve existing models. For an existing Blender model, find its latest successful revision report under `models/<name>/revisions/` and open that report's `blend` path. Use the selected revision when the user asks to revert. For a USD, legacy GLB or STL import, use the helper's `import_mesh`. Legacy JavaScript previews are disabled by project isolation; migrate their actual geometry to USD using confined tools rather than approximating it from screenshots. Do not overwrite their source.
2. Write a reproducible Python script under `source/`. Run `"<executable>" --background --factory-startup --python-exit-code 1 --python "<script>"`. This runs a full Blender process without a window; ordinary system Python cannot import `bpy`.
3. Work in **metres, Z up** in Blender. Rumi's viewer, measurements and Gaussian regions use **millimetres, Z up**. Divide model-local cursor/highlight coordinates and radii by 1,000 before using them in Blender; account for object transforms when selecting vertices. Standard USD export/import handles the USD coordinate frame. Do not apply viewer placement to an editing selection twice.
4. Follow the solid construction defaults above when choosing Blender modifiers and mesh operations. For symmetric objects construct one half and mirror it about an explicit plane; measure symmetry after evaluated modifiers. Keep planar faces planar, bevel widths consistent, sharp boundaries deliberate, and smooth normals confined to intended smooth surfaces. More subdivisions or smooth shading alone do not correct a lumpy silhouette. Inspect front, side and three-quarter views. Distinguish topology checks from visual/reference fidelity.
5. Load the helper returned by `blender_status` with `helper = runpy.run_path(helper_path)`, then call `helper["publish"]("models/<name>")`. Use `runpy` so importing the helper does not write bytecode into the installed application. It saves an immutable `.blend` and USD revision, prints the paths and `RUMI_CHECKS`, and atomically updates `model.usda`. Keep named parts, modifiers, and movement declarations in the editable original. Preview limits are 200,000 triangles and 64 MiB; preserve detailed assets separately if a lighter preview is required. Do not silently simplify the print deliverable.
6. Follow [Name Model Regions](../name-model-regions/SKILL.md) for the published revision. Call `viewer_load` on `models/<name>/model.usda`. Saved models display independently of validation. Use `RUMI_CHECKS` and `meshState.validation` to inspect findings; a visible model is not a printability pass. Use `viewer_camera`, `viewer_cursor_snapshot`, and `viewer_highlight` for iteration.

## Efficient geometry edits

For rim or outline proximity, use the joints kit's `K.outline_distances(points, outlines)` instead of Python loops over every vertex and segment. Pass finite 2D coordinates in one consistent unit; outlines are closed automatically. The returned NumPy array gives exact point-to-segment distances in the same unit, including zero-length segments. For an X/Z rim band in millimetres: `distances = K.outline_distances([(v.co.x * 1000, v.co.z * 1000) for v in bm.verts], outlines_mm)`, then select `[v for v, distance in zip(bm.verts, distances) if distance < band_mm]`. Account for object transforms when the outline is not in mesh-local coordinates. Keep the same smoothing operations, topology and publish checks.

Reuse the editable original of the intended revision when changing only one feature; do not regenerate unrelated geometry. For visual inspection use `viewer_camera` and `viewer_cursor_snapshot` before starting separate Blender renders. Preserve full geometry and clearance checks on each published edit.

To revert to an existing saved revision, call `helper["restore_revision"]("models/<name>", "<revision-directory-name>")` instead of rebuilding it. Identify the intended revision from its report and preview; do not guess from directory ordering. This atomically restores the exact saved USD, retains all revisions and returns the matching `.blend` path. It leaves the current Blender scene unchanged, so open the returned `.blend` before further edits. Call `viewer_load` on the canonical `model.usda` afterward. Restoration leaves validation pending; use the explicit validation tools before claiming acceptance or readiness.

## Declare physical movement

Every multi-part or movable model requires a complete assembly description. Give each physical piece a unique mesh name and include retaining pins, caps and axles. Disconnected solids cannot become one rigid piece by grouping or joining their mesh objects. Preserve requested features, connectors, names, controls and movement ranges through repairs and conversions.

Use [Printable Joints](../printable-joints/SKILL.md) for kit-built assemblies. For a custom USD exporter callback, follow [USD assembly declarations](references/usd-assembly.md) for joint frames, limits, and metadata.

## Movement controls

Use [control-widgets](../control-widgets/SKILL.md) to choose widgets and labels. Publish control layout changes in a model revision. Operating those controls afterward changes only the local preview pose, not saved geometry or validation input; pose changes need no freeze or save. Keep physical joint declarations and connectors intact when editing the UI.

Without UI declarations, revolute and prismatic joints generate sliders labeled by `rumi:control` or the child mesh name. To choose widgets, set the default prim’s string attribute `rumi:motionControls` to a JSON array. Each item has `kind`, `label`, and `axes`; each axis references an absolute joint prim path and may set `step`. For example:

```python
controls = [dict(kind="pad", label="Aim", axes=[
    dict(joint="/Model/Joints/Pan", step=1),
    dict(joint="/Model/Joints/Tilt", step=1),
])]
K.publish("models/turret", root=base, joints=joints, mode="separate",
          steps=steps, controls=controls)
```

The kit writes joints under `/Model/Joints/<USD identifier of joint id>`. Use the actual exported paths. For direct USD authoring, set `root.CreateAttribute("rumi:motionControls", Sdf.ValueTypeNames.String, custom=False).Set(json.dumps(controls))` inside `configure_robot`.

A slider or curve references one movable joint; a pad references two independent movements, horizontal then vertical. Joint limits supply axis ranges; reset returns to the saved pose at zero. Steps use degrees for rotation and millimetres for translation; defaults are 1 degree or 0.1 mm, capped to the range width. UI declarations cannot override limits or reset. Unspecified movements retain automatic sliders.

Joints sharing `rumi:control` share one value and must use matching units and overlapping limits. Reference that group once through any member joint. Repeated bindings, missing or fixed joints, unsupported widgets, and invalid steps withhold movement controls with a viewer diagnostic; geometry stays visible. The preview supports trees with up to 12 independent movements and preserves fixed descendants. Closed loops remain unsupported.

After publishing, inspect `viewer_load` feedback under `design.motion` and exercise each axis and reset. Invalid UI metadata does not change the physical validation result. Preview movement does not establish mechanical feasibility. Temporary mesh edits disable movement controls while keeping the panel visible. Reset the pose before source-bound cursor edits. Compatible pose values survive revisions and model switching while the viewer remains mounted; reopening starts at the saved pose.

## Clearances and retention

Keep at least 0.3 mm between separate parts everywhere in the saved pose: radial gaps in bores, end-play and door-to-frame gaps. `RUMI_CHECKS` reports `insufficient_clearance` as an error below 0.2 mm and lists the pairs and gaps. Parts joined by a fixed joint may touch.

Play is expected. Retention passes when the connector stops the part; the pivot may travel up to 2 mm and tilt up to 15°. Never reduce clearances to reduce drift.

Repair `unretained_part` and `unstable_at_rest` by adding or enlarging the feature that captures the part: a cap, shoulder, flange or collar wider than the bore, or a pin through both knuckles. Do not tighten the fit. Repair `insufficient_clearance` by widening the listed gaps while keeping the capturing feature.

## Pointing and print export

Follow [Clarify Mesh Changes](../clarify-mesh-changes/SKILL.md) for captured pointing references. Recompute selections after a topology change. Gaussian regions describe soft influence around a point.

Export print meshes from the intended evaluated solids. Follow [FDM Design](../fdm-design/SKILL.md) for geometry constraints and [Prepare Print Job](../prepare-print-job/SKILL.md) for slicing and placement.

## Validate a finished revision

Every `publish` checks the new revision in a separate Blender process and prints `RUMI_CHECKS <json>`: Toolbox geometry findings, part clearance, the assembly declaration error if any, and `dimensionsMm`. Only findings with a nonzero count appear. Read it after each build and fix `error` severity findings before building further; `warning` findings need judgment against the intended design. `status: "unavailable"` means no checks ran; call `blender_status` once in this project and publish again. Write no separate manifold, clearance or collision scripts, and do not invoke installed validator scripts or Bullet by hand.

The open viewer automatically checks the selected saved revision and cancels superseded checks; it does not accept revisions or start repair turns. Explicit tools reuse completed stages. When the design is ready and `RUMI_CHECKS` has no blocking errors, call `validation_mechanics` once with the model `path`. The host re-runs any missing cheap checks for that revision first and stops with their findings if one blocks. Otherwise it runs Bullet, the costly stage (up to ten minutes), testing whole-assembly contacts, retention, sampled movement, declared sequences and removal paths with only the root held. Do not weaken settings, omit parts, narrow movement or substitute a reduced assembly to obtain a pass; incomplete coverage remains unverified. Then call `validation_accept` with the `path` and `fingerprint` it returned. For moving assemblies, declare removal paths for every nonroot part; missing paths produce `assembly_path_required` and block acceptance while retaining the motion findings. Only an `accepted` result supports an acceptance claim, and it does not certify slicing, deformation, strength, assembly accessibility or print readiness. A printer volume that was never configured means printer fit is unchecked.

After any repair or placement change, publish again and repeat for the new revision; never report a previous revision's results as current. Validation never starts follow-up turns, so finish repairs in this turn. Preserve requested features, connectors, controls and full movement ranges. If checks fail or cannot be resolved safely, report the remaining limitation briefly instead of claiming acceptance.
