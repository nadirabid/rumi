# Author USD assembly declarations

`cad/rumi_cad.py` writes a pure-Python self-contained ASCII `#usda 1.0` layer (metres, Z up) with `IsaacRobotAPI` and `UsdPhysics.ArticulationRootAPI` on `/Model`, per-part `IsaacLinkAPI`, `PhysicsRigidBodyAPI`, and `PhysicsCollisionAPI` on each mesh, and ordered `isaac:physics:robotLinks` and `isaac:physics:robotJoints`. Pass an `assembly` dictionary (or use `K.publish` from `printable-joints`, which builds it for you) when calling `helper["publish"]`:

```python
assembly = {
    "version": 1,
    "root": "Frame",
    "parts": [{"id": "Frame", "mesh": "Frame"}, {"id": "Door", "mesh": "Door"}, {"id": "Pin", "mesh": "Pin"}],
    "connections": [
        {
            "id": "DoorHinge",
            "parent": "Frame",
            "child": "Door",
            "kind": "revolute",
            "axis": [0, 0, 1],
            "pivot": [0, 0, 12],
            "range": [0, 90],
            "control": "Door",
        },
        {
            "id": "PinLock",
            "parent": "Frame",
            "child": "Pin",
            "kind": "fixed",
            "retainer": "bayonet",
            "axis": [0, 0, 1],
            "pivot": [0, 0, 24],
        },
    ],
    "sequences": [],
    "manufacturing": {
        "mode": "separate",
        "steps": [
            {
                "part": "Pin",
                "actions": [
                    {"kind": "rotate", "pivot": [0, 0, 24], "axis": [0, 0, 1], "degrees": 45, "pitchMm": 0},
                    {"kind": "translate", "delta": [0, 0, 30]},
                ],
            },
            {
                "part": "Door",
                "actions": [
                    {"kind": "translate", "delta": [25, 0, 0]},
                ],
            },
        ],
    },
}
helper["publish"]("models/<name>", [frame, door, pin], assembly=assembly)
```

All coordinates, pivots, offsets, and prismatic ranges in the `assembly` dict are in **millimetres, Z up**; `rumi_cad.py` converts positions and prismatic limits to metres automatically when writing `model.usda`. Revolute limits are in degrees.

## Supported joints and retainers

The checker supports `fixed`, `revolute`, and `prismatic` joints, up to 128 parts and 128 joints, with finite ranges containing the saved pose at zero and bounded by ±180 degrees or ±1 metre. Include every retaining pin, cap, collar, and axle as its own part and link. The first robot link (`root`) is held by the fixture; all other parts must connect through the declared graph. Joints describe expected behavior; Bullet does not create ideal constraints that could hide missing connectors.

On `fixed` joints, set optional `retainer` (`rumi:retainer` in USD) to describe how the separate retainer holds:

- `'rigid'` (default): full 6-DOF retention probes.
- `'snap'`: full 6-DOF retention probes for snap-engaged locks.
- `'bayonet'` or `'threaded'`: requires a nonzero lock `axis` (and optional `pivot`). Runs full axial pull-out, radial shear, and off-axis tilt retention probes while skipping pure unscrewing torque about `axis`.
- `'friction'`: emits `retainer_unverified_friction` warning (does not falsely certify rigid mechanical retention).

## Disassembly steps

Every nonroot part in a `separate` assembly requires a disassembly entry in `manufacturing["steps"]` (written as `rumi:disassembly` JSON on `/Model`). Each step names `"part"` and supplies either `actions` (v2, recommended) or legacy `path` (`[[0,0,0], [dx,dy,dz], ...]`). Each action in `actions` is one of:

- `{"kind": "translate", "delta": [dx, dy, dz]}`: rigid collision-free linear move in mm (`penetration <= initialPenetrationMm`).
- `{"kind": "rotate", "pivot": [x, y, z], "axis": [ax, ay, az], "degrees": deg, "pitchMm": 0}`: rigid rotation or helical unscrewing (`pitchMm` axial travel per 360° along `axis`, right-hand rule; `penetration <= initialPenetrationMm`).
- `{"kind": "snap", "delta": [dx, dy, dz], "maxInterferenceMm": limit, "mate": optional_part_id}`: bounded elastic snap disengagement/engagement along `delta` (`0 < limit <= 2.5` mm). Verifies clear start and end (`<= initialPenetrationMm`), interference against the mating part within `limit`, and zero interference with unrelated third parts.

After a part's actions complete, Bullet checks AABB clearance against all remaining parts.

## USD layer invariants

`rumi_cad.py` always produces a single self-contained ASCII `#usda 1.0` layer (metres, Z up) with embedded `UsdPreviewSurface` diffuse colors and no external assets, references, subLayers, payloads, variants, or animation. Moving assemblies require `rumi:manufacturingMode = "separate"`; legacy `print-in-place` moving assemblies remain viewable but are rejected for publishing and print preparation until redesigned. See [movement controls](../SKILL.md#movement-controls) for `rumi:motionControls` widgets.
