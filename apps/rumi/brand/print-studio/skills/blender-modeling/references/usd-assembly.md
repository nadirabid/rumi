# Author USD assembly joints

Use standard OpenUSD Python APIs in a `configure_robot(stage)` callback. The exporter creates `IsaacRobotAPI` on `/Model`, applies `IsaacLinkAPI`, `PhysicsRigidBodyAPI` and `PhysicsCollisionAPI` to each mesh, and lists the links in `isaac:physics:robotLinks`. Set that ordered relationship explicitly so the first link is the intended test fixture. Author every connection with `UsdPhysics`, apply `IsaacJointAPI`, and list every joint in `isaac:physics:robotJoints`:

```python
from pxr import Gf, Sdf, UsdPhysics

def configure_robot(stage):
    root = stage.GetDefaultPrim()
    root.GetAttribute("rumi:manufacturingMode").Set("separate")
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

This example assumes both mesh transforms are identity and requires actual connectors that retain the door and can be assembled after separate printing. Joint positions and rotations are local to the respective body: calculate each frame from the saved world pivot and axis. USD positions and prismatic limits use metres; revolute limits use degrees. The current checker supports fixed, revolute and prismatic joints, at most 128 parts and 128 joints, with finite ranges containing the saved pose at zero and bounded by ±180 degrees or ±1 metre. Include every retaining pin, cap and axle as its own link. The first robot link is held by the fixture; all others must be connected through the declared graph. Joints describe expected behavior; Bullet does not create ideal constraints that could hide missing connectors.

The helper retains the native USD description in the editable `.blend`. Later `publish` calls preserve it; supply `configure_robot` when changing the robot. USD is the authoritative geometry and joint format, while `.blend` retains editable modifiers. Use one self-contained ASCII layer, metres/Z up, with no external textures, references, variants or animation. Use surface colours for the preview. Each exported physical link must be one uniquely named mesh.

Rumi-specific attributes cover information the robot schema does not define: `rumi:control` on a joint labels its slider; `rumi:manufacturingMode` on the root must be `separate` for moving assemblies. Legacy `print-in-place` models remain viewable but require connector redesign before publishing or print preparation. Optional root strings `rumi:sequences` and `rumi:disassembly` encode JSON movement waypoints and translation-only reverse-assembly paths. Waypoints name joint prims and use degrees or millimetres; disassembly paths name link prims and use millimetre offsets. These are checking instructions, not a second body/joint description. Unsupported coupling and incomplete coverage remain unverified. See [movement controls](../SKILL.md#movement-controls) for viewer widgets.
