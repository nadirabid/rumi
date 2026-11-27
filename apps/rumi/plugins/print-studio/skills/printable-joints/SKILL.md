---
name: printable-joints
description: "Build separately printed assemblies with Blender joint recipes for wheels, hinges, sliders, snaps, and gears."
---

# Printable joints

`blender_status` returns a `joints` path. Load it at the top of the build script:

```python
import runpy, types
K = types.SimpleNamespace(**runpy.run_path(joints_path))
```

The kit works in **millimetres, Z up** and creates the Blender geometry in metres for you. Do not mix raw `bpy` coordinates with kit calls. Parts keep identity transforms, which the joint frames need.

Use a compatible recipe before designing a connector by hand.

See the [kit API](references/kit.md) for primitives, booleans, transforms, and publishing.

## Separate printing for moving parts

Rumi requires every moving physical part to be printed separately and assembled afterward. Joint kind still describes movement after assembly: fixed, rotating or sliding. Do not offer print-in-place as an option or ask the user to choose a manufacturing mode. Publish movable assemblies with explicit `mode='separate'`; omitting the mode or using `print-in-place` is rejected. Single-piece static models need no manufacturing choice.

Design the assembly before choosing connectors. Provide accessible insertion paths, an assembly order and separate pins or retainers where needed. Explain it briefly: “The wheels and doors print separately, then attach so they still spin and open.” Consider bed orientation, support removal, joint clearances, materials, strength and repairability. Keep requested movement; never fuse a moving part or change it to a fixed joint to meet the requirement.

Recipes described below or in their cards as print-in-place are legacy geometry references, not supported designs for new movable prints. Do not use their captive defaults or change a manufacturing label to make them appear compatible. Use a separately assembleable variant only when the card identifies one, or design removable connectors with the kit and declare them with `K.joint`. Existing printed-assembled models remain inspectable, but their connectors must be reviewed and redesigned before republishing or arranging for printing. Preserve their previous revisions.

Run the geometry, clearance, collision, retention and movement workflow in [finished-revision validation](../blender-modeling/SKILL.md#validate-a-finished-revision). Describe the assembly order and pass `steps=[dict(part="part_name", path=[[0, 0, 0], [dx, dy, dz], ...]), ...]` to `K.publish` for every nonroot part. Offsets use millimetres and each path starts at zero. Missing paths leave the mechanical result under review and block acceptance, even when motion probes pass. Bullet checks supplied translation paths in reverse; it does not discover them or simulate snapping, flexing or threaded insertion. Missing or unsupported assembly evidence remains unverified even when movement checks pass. The `separate` declaration and plate placement are not proof that assembly is possible.

## Build order

1. Plan assembly after separate printing, then block out each physical part as a simple solid with its real outer size and position.
2. Choose each joint's pivot and axis from those coordinates.
3. Call the recipe. It adds and cuts the mating features on both parts and returns the joint record. A recipe raises an error that says what to move when a part does not reach the joint.
4. Add detail and colour. Build one side and `K.mirror` it for pairs.
5. Publish the assembled pose with `K.publish`, read `RUMI_CHECKS`, then follow [Blender modeling](../blender-modeling/SKILL.md#edit-and-publish) for region labels and preview. The viewer derives a separate plate layout from the physical parts.

Choose movement widgets through [blender-modeling](../blender-modeling/SKILL.md#movement-controls). Pass their declarations as `controls` to `K.publish`; joint geometry and limits remain the movement definition.

## Recipes are starting points

Each recipe was checked alone at its default size on a small sample; your whole model still has to pass its own checks. Resize a recipe through its options, and keep clearances and minimum walls as they are when you scale a model up or down. When no recipe fits, model the connector with the kit and declare it with `K.joint`; copy the nearest recipe's proportions.

What the mechanics check needs, whichever way you build:

- Only the root part is held. Every other part must be caught by shape in every direction: an assembled retainer wider than its bore, a removable pin secured by a cap, a lip over an insertable slider. Friction, press fits, magnets and glue hold nothing in the check.
- Provide retention geometry that can be assembled after separate printing. A join held only by friction stays unverified; report that limitation rather than switching to print-in-place to obtain a pass. Fuse parts with `K.join` only when the design calls for one physical piece.
- Keep 0.3 mm between different parts. Let flat faces and round pins in round bores carry loads; cone tips, slots and sharp edges in a bearing surface read as `excessive_penetration`.
- Recipes marked **over limit** below can read 0.16–0.39 mm `excessive_penetration` against the 0.15 mm limit while the part is captive. Do not tighten clearances or redesign repeatedly to chase it; after one repair attempt report the model as built and unverified.

## Catalog

Mechanics column: **passes** means the recipe's sample passed `validation_mechanics` at the default limits. **over limit** means the part is captive and passes rest and retention, but a probe read `excessive_penetration` just above 0.15 mm. **unverified** means the check cannot confirm it by design; say so to the user.

| Need | Recipe | Mechanics | Card |
|---|---|---|---|
| Wheel that spins on a body | `K.wheel` then `K.captive_axle` | passes | `wheels.md` |
| Two wheels turning together on one axle | `K.through_axle` | passes | `wheels.md` |
| Soft tyre on a rigid hub | `K.tyre` | passes | `wheels.md` |
| Wheel held on by a collar | `K.axle_clip` | passes (`open_clip=True` unverified) | `wheels.md` |
| Door, lid or flap | `K.barrel_hinge` | over limit, 0.16–0.39 mm | `rotation.md` |
| Door that clips onto a post | `K.clip_hinge` | over limit, 0.18–0.34 mm | `rotation.md` |
| Fold line in one flexible part | `K.living_hinge` | one part, nothing to check | `rotation.md` |
| Tilting head or arm | `K.ball_socket` | over limit, 0.27–0.35 mm; one tilt axis | `rotation.md` |
| Turntable, turret, spinner | `K.turntable_plate` then `K.turntable` | passes | `rotation.md` |
| Shaft turning inside a housing | `K.bearing` | passes | `rotation.md` |
| Sliding carriage or drawer | `K.dovetail_slide`, `K.tslot_rail` | passes | `sliders.md` |
| Telescoping tube, piston | `K.telescoping_tube` | passes | `sliders.md` |
| Latch or slider in a slot | `K.pin_slot` | passes | `sliders.md` |
| Snap two parts together | `K.snap_hook` | passes | `fasteners.md` |
| Round snap-on lid | `K.snap_lid` | passes | `fasteners.md` |
| Flat-pack wall into a base | `K.tab_slot` | over limit, 0.16 mm | `fasteners.md` |
| Twist-lock cap | `K.bayonet_lock` | over limit, 0.20 mm | `fasteners.md` |
| Printed bolt and nut | `K.bolt_nut` | unverified: the nut can unscrew | `fasteners.md` |
| Push-fit pegs, dog-bone key, magnets, metal insert | `K.press_pegs`, `K.dogbone_key`, `K.magnet_pockets`, `K.insert_boss` | unverified: held by friction, magnetism or hardware | `fasteners.md` |
| Meshing gears | `K.gear_pair` (blank: `K.spur_gear`) | passes up to ratio 1.45 | `mechanisms.md` |
| Rack and pinion | `K.rack_pinion` | passes | `mechanisms.md` |
| One-way ratchet | `K.ratchet` | passes; axis must be horizontal | `mechanisms.md` |
| Slider that clicks between positions | `K.detent_slider` | passes | `mechanisms.md` |
| Cam lifting a follower | `K.cam_follower` | over limit, 0.22 mm | `mechanisms.md` |
| Crank driving a slider | `K.crank_slider` | unverified: closed loop | `mechanisms.md` |
| One-piece spring | `K.flexure_spring` | one part, nothing to check | `mechanisms.md` |

Read the card before the first use of a recipe. Each family's file under `references/` beside this skill gives every recipe's call, what the parts must provide, the options worth changing, how it prints, and what validation reported. A recipe sample passing motion probes does not establish separate assembly feasibility.
