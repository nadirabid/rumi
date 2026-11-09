---
name: blender-modeling
description: Create, import, or edit Rumi meshes using background Blender Python scripts, then inspect and iterate in the Three.js viewer. Use for model creation and geometry edits.
---

# Blender modeling

Call `blender_status` for the executable and helper paths. Run Blender through the ordinary shell tool, using its permissions and cancellation; do not build a separate execution service. If Blender is unavailable, report the setup action returned by the tool.

## Edit and publish

1. Read the current `meshState` context and the existing project files. Create another model folder only when the user explicitly requests or agrees to a separate model; clarify ambiguous intent before writing files. For edits and fixes, publish revisions in the existing model folder. Preserve existing models. For an existing Blender model, find its latest successful revision report under `models/<name>/revisions/` and open that report's `blend` path. Use the selected revision when the user asks to revert. For a USD, legacy GLB or STL import, use the helper's `import_mesh`. Legacy JavaScript previews are disabled by project isolation; migrate their actual geometry to USD using confined tools rather than approximating it from screenshots. Do not overwrite their source.
2. Write a reproducible Python script under `source/`. Run `"<executable>" --background --factory-startup --python-exit-code 1 --python "<script>"`. This runs a full Blender process without a window; ordinary system Python cannot import `bpy`.
3. Work in **metres, Z up** in Blender. Rumi's viewer, measurements and Gaussian regions use **millimetres, Z up**. Divide model-local cursor/highlight coordinates and radii by 1,000 before using them in Blender; account for object transforms when selecting vertices. Standard USD export/import handles the USD coordinate frame. Do not apply viewer placement to an editing selection twice.
4. Use Blender's modifiers and mesh operations. For symmetric objects construct one half and mirror it about an explicit plane; measure symmetry after evaluated modifiers. Keep planar faces planar, bevel widths consistent, sharp boundaries deliberate, and smooth normals confined to intended smooth surfaces. More subdivisions or smooth shading alone do not correct a lumpy silhouette. Inspect front, side and three-quarter views. Distinguish topology checks from visual/reference fidelity.
5. Load the helper returned by `blender_status` with `helper = runpy.run_path(helper_path)`, then call `helper["publish"]("models/<name>")`. Use `runpy` so importing the helper does not write bytecode into the installed application. It saves an immutable `.blend` and USD revision, prints the paths, and atomically updates `model.usda`. Keep named parts, modifiers, and movement declarations in the editable original. Preview limits are 200,000 triangles and 64 MiB; preserve detailed assets separately if a lighter preview is required. Do not silently simplify the print deliverable.
6. Call `viewer_load` on `models/<name>/model.usda`. Saved models display independently of validation. Use `meshState.validation` to inspect findings; a visible model is not a printability pass. Use `viewer_camera`, `viewer_cursor_snapshot`, and `viewer_highlight` for iteration.

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

## Pointed regions and printing

Use `printer-awareness` before supplying a build volume or making printer-specific fit, nozzle or filament claims.

Use the cursor snapshot associated with the request and visually ground named regions through `viewer_highlight`, following `clarify-mesh-changes`. Check the model revision before editing; a Gaussian region is a soft reference, not an exact vertex selection or semantic part boundary. Changes to topology invalidate old triangle indices.

Keep `.blend` files as editable originals and USD as the shared geometry and robot description. Export print meshes separately from the intended evaluated solids and verify units, wall thickness, manifoldness, fit, supports and slicer output using `fdm-design`. Blender operations and viewer checks do not certify print readiness. Whole-model placement still uses `viewer_transform`; it does not rewrite the Blender original.

Print Studio automatically runs Blender geometry validation after each agent turn for changed discovered models, then whole-assembly Bullet contact and movement probes when geometry has no blocking findings. Read `meshState.validation` for revision-specific findings, including `report.mechanics`; `previousReport` is historical. Do not claim the current edit passed before its matching result exists. The checker holds only the root fixture and tests actual mesh contacts while every other piece remains dynamic. It does not create ideal joints that supply missing connectors. Unsupported motion, incomplete checks, deformation, strength and slicing require separate evidence.

Blocking geometry or mechanism findings automatically start a repair turn with model paths and checked revisions. Preserve the requested design, moving parts, physical connectors, and declarations while repairing; do not remove requested features or narrow movement controls merely to hide failures. Repairs are checked again after the turn, with a bounded automatic retry budget. Unverified mechanical checks also trigger bounded repair; static geometry warnings and unavailable checks remain visible in the report without starting geometry repairs. If a repair cannot be made safely, report the remaining limitation briefly; never claim printability from geometry checks alone.
