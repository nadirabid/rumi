---
name: blender-modeling
description: Create, import, or edit Rumi meshes using background Blender Python scripts, then inspect and iterate in the Three.js viewer. Use for model creation and geometry edits.
---

# Blender modeling

Call `blender_status` for the executable and helper paths. Run Blender through the ordinary shell tool, using its permissions and cancellation; do not build a separate execution service. If Blender is unavailable, report the setup action returned by the tool.

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
6. Call `viewer_load` on `models/<name>/model.usda`. Saved models display independently of validation. Use `RUMI_CHECKS` and `meshState.validation` to inspect findings; a visible model is not a printability pass. Use `viewer_camera`, `viewer_cursor_snapshot`, and `viewer_highlight` for iteration.

## Declare physical movement

Every multi-part or movable model requires a complete assembly description. Give each physical piece a unique mesh name and include retaining pins, caps and axles. Disconnected solids cannot become one rigid piece by grouping or joining their mesh objects. Preserve requested features, connectors, names, controls and movement ranges through repairs and conversions.

Use standard OpenUSD Python APIs in a `configure_robot(stage)` callback. The exporter creates `IsaacRobotAPI` on `/Model`, applies `IsaacLinkAPI`, `PhysicsRigidBodyAPI` and `PhysicsCollisionAPI` to each mesh, and lists the links in `isaac:physics:robotLinks`. Set that ordered relationship explicitly so the first link is the intended test fixture. Author every connection with `UsdPhysics`, apply `IsaacJointAPI`, and list every joint in `isaac:physics:robotJoints`:

```python
from pxr import Gf, Sdf, UsdPhysics

def configure_robot(stage):
    root = stage.GetDefaultPrim()
    root.GetRelationship("isaac:physics:robotLinks").SetTargets(["/Model/Frame", "/Model/Door"])
    joint = UsdPhysics.RevoluteJoint.Define(stage, "/Model/DoorHinge")
    joint.GetPrim().AddAppliedSchema("IsaacJointAPI")
    joint.CreateBody0Rel().SetTargets(["/Model/Frame"])
    joint.CreateBody1Rel().SetTargets(["/Model/Door"])
    joint.CreateAxisAttr("Z")
    joint.CreateLocalPos0Attr(Gf.Vec3f(0, 0, .012))
    joint.CreateLocalPos1Attr(Gf.Vec3f(0, 0, .012))
    joint.CreateLowerLimitAttr(0)
    joint.CreateUpperLimitAttr(90)
    joint.GetPrim().CreateAttribute("rumi:control", Sdf.ValueTypeNames.String, custom=False).Set("Door")
    root.GetRelationship("isaac:physics:robotJoints").SetTargets([joint.GetPath()])

helper["publish"]("models/<name>", configure_robot=configure_robot)
```

This example assumes both mesh transforms are identity and requires actual captive connector geometry. Joint positions and rotations are local to the respective body: calculate each frame from the saved world pivot and axis. USD positions and prismatic limits use metres; revolute limits use degrees. The current checker supports fixed, revolute and prismatic joints, at most 128 parts and 128 joints, with finite ranges containing the saved pose at zero and bounded by ±180 degrees or ±1 metre. Include every retaining pin, cap and axle as its own link. The first robot link is held by the fixture; all others must be connected through the declared graph. Joints describe expected behavior; Bullet does not create ideal constraints that could hide missing connectors.

The helper retains the native USD description in the editable `.blend`. Later `publish` calls preserve it; supply `configure_robot` when changing the robot. USD is the authoritative geometry and joint format, while `.blend` retains editable modifiers. Use one self-contained ASCII layer, metres/Z up, with no external textures, references, variants or animation. Use surface colours for the preview. Each exported physical link must be one uniquely named mesh.

Rumi-specific attributes cover information the robot schema does not define: `rumi:control` on a joint labels its slider; `rumi:manufacturingMode` on the root is `print-in-place` or `separate`. Optional root strings `rumi:sequences` and `rumi:disassembly` encode JSON movement waypoints and translation-only reverse-assembly paths. Waypoints name joint prims and use degrees or millimetres; disassembly paths name link prims and use millimetre offsets. These are checking instructions, not a second body/joint description. Unsupported coupling and incomplete coverage remain unverified. Read `interactive-controls` for persistent movement controls.

## Clearances and retention

Keep at least 0.3 mm between separate parts everywhere in the saved pose: radial gaps in bores, end-play and door-to-frame gaps. `RUMI_CHECKS` reports `insufficient_clearance` as an error below 0.2 mm and lists the pairs and gaps. Parts joined by a fixed joint may touch.

Play is expected. Retention passes when the connector stops the part; the pivot may travel up to 2 mm and tilt up to 15°. Never reduce clearances to reduce drift.

Repair `unretained_part` and `unstable_at_rest` by adding or enlarging the feature that captures the part: a cap, shoulder, flange or collar wider than the bore, or a pin through both knuckles. Do not tighten the fit. Repair `insufficient_clearance` by widening the listed gaps while keeping the capturing feature.

## Pointed regions and printing

Use `printer-awareness` before supplying a build volume or making printer-specific fit, nozzle or filament claims.

Use the cursor snapshot associated with the request and visually ground named regions through `viewer_highlight`, following `clarify-mesh-changes`. Check the model revision before editing; a Gaussian region is a soft reference, not an exact vertex selection or semantic part boundary. Changes to topology invalidate old triangle indices.

Keep `.blend` files as editable originals and USD as the shared geometry and robot description. Export print meshes separately from the intended evaluated solids and verify units, wall thickness, manifoldness, fit, supports and slicer output using `fdm-design`. Blender operations and viewer checks do not certify print readiness. Whole-model placement still uses `viewer_transform`; it does not rewrite the Blender original.

## Validate a finished revision

Every `publish` checks the new revision in a separate Blender process and prints `RUMI_CHECKS <json>`: Toolbox geometry findings, part clearance, the assembly declaration error if any, and `dimensionsMm`. Only findings with a nonzero count appear. Read it after each build and fix `error` severity findings before building further; `warning` findings need judgment against the intended design. `status: "unavailable"` means no checks ran; call `blender_status` once in this project and publish again. Write no separate manifold, clearance or collision scripts, and do not invoke installed validator scripts or Bullet by hand.

When the design is ready and `RUMI_CHECKS` has no blocking errors, call `validation_mechanics` once with the model `path`. The host re-runs any missing cheap checks for that revision first and stops with their findings if one blocks. Otherwise it runs Bullet, the costly stage (up to ten minutes), testing whole-assembly contacts, retention, sampled movement, declared sequences and removal paths with only the root held. Do not weaken settings, omit parts, narrow movement or substitute a reduced assembly to obtain a pass; incomplete coverage remains unverified. Then call `validation_accept` with the `path` and `fingerprint` it returned. Only an `accepted` result supports an acceptance claim, and it does not certify slicing, deformation, strength, assembly accessibility or print readiness. A printer volume that was never configured means printer fit is unchecked.

After any repair or placement change, publish again and repeat for the new revision; never report a previous revision's results as current. Validation never starts follow-up turns, so finish repairs in this turn. Preserve requested features, connectors, controls and full movement ranges. If checks fail or cannot be resolved safely, report the remaining limitation briefly instead of claiming acceptance.
