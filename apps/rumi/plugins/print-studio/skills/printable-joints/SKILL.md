---
name: printable-joints
description: "Build separately printed assemblies with build123d CAD joint recipes for wheels, hinges, sliders, snaps, bayonets, threads, and gears."
---

# Printable joints

`cad_status` returns a `joints` path (`cad/rumi_joints.py`). Load it at the top of your `build123d` script:

```python
import runpy, types
K = types.SimpleNamespace(**runpy.run_path(joints_path))
```

The kit works directly in **millimetres, Z up** using exact OpenCASCADE B-Rep solids (`build123d`). Every recipe builds **separately printable** parts with real retaining hardware (quarter-turn bayonet caps, split snap barbs, removable pins, end-stop plugs, or collars), returns a `RecipeResult` with `.parts`, `.joints`, `.steps`, and `.features`, and registers its pieces so `K.publish` writes STEP, B-Rep, and self-contained ASCII USD with complete topologically ordered disassembly `actions` automatically.

Use a compatible recipe before designing a connector by hand.

See the [kit API](references/kit.md) for primitives, fillets/chamfers, exact Booleans, disassembly step helpers, and publishing.

## Separate printing for moving parts

Rumi requires every moving physical part to be printed separately and assembled afterward. Joint kind still describes movement after assembly: `fixed`, `revolute`, or `prismatic`. Do not offer print-in-place as an option or ask the user to choose a manufacturing mode. Publish movable assemblies with explicit `mode='separate'`; omitting the mode or using `print-in-place` is rejected. Single-piece static models need no manufacturing choice.

Design the assembly before choosing connectors. Provide accessible insertion paths, an assembly order, and separate pins, caps, or collars where needed. Explain it briefly: “The wheels and doors print separately, then attach with locking caps so they still spin and open.” Consider flat bed orientation, support removal, joint clearances, materials, strength, and repairability. Keep requested movement; never fuse a moving part or change it to a fixed joint to meet the requirement.

Every moving recipe in this kit is a separate-print design — there are no print-in-place moving joints. When building a custom connector, declare it with `K.joint(...)` (setting `retainer` on fixed retainers: `'rigid'`, `'bayonet'`, `'threaded'`, `'snap'`, or `'friction'`) and declare a disassembly step for every nonroot part using `K.step_translate`, `K.step_twist`, or `K.step_snap`.

Run the geometry, clearance, collision, retention, and movement workflow in [finished-revision validation](../cad-modeling/SKILL.md#validate-a-finished-revision). Bullet checks each nonroot part's disassembly `actions` (`translate`, `rotate` with optional helical `pitchMm`, and bounded elastic `snap` with `maxInterferenceMm`) plus full retention and motion probes with only the root held. Missing steps produce `assembly_path_required` and block acceptance. The `separate` declaration and plate placement alone are not proof that assembly is possible.

## Build order

1. Call `K.start()`, plan assembly after separate printing, and block out each physical part as a solid with its real outer size and position in millimetres.
2. Choose each joint's pivot and axis from those coordinates.
3. Call the recipe. It adds and cuts the mating features on both parts, creates any separate retainer hardware (caps, pins, collars, plugs), and records the joint records and disassembly `actions`. A recipe raises an error explaining what to move when a part does not reach the joint.
4. Add detail, fillets/chamfers, and colour (`K.paint` for whole parts; `K.split_faces` + `K.paint_faces` or `K.paint_regions` for multi-colour faces on one part). Build one side and `K.mirror` it for pairs.
5. Publish the assembled pose with `K.publish("models/<name>", root=base, joints=joints, mode="separate", controls=controls)`. `K.publish` auto-collects recipe-created parts, joints, topologically ordered disassembly steps, and badge features, prints `RUMI_MODEL` and `RUMI_CHECKS`, and updates `model.usda`. Follow [CAD modeling](../cad-modeling/SKILL.md#edit-and-publish) for region labels, `viewer_load`, and `validation_mechanics` + `validation_accept`.

Choose movement widgets through [cad-modeling](../cad-modeling/SKILL.md#movement-controls). Pass their declarations as `controls` to `K.publish`; joint geometry and limits remain the movement definition.

## Recipes are starting points

Each recipe is checked alone at its default size on a sample fixture; your whole model still has to pass its own `RUMI_CHECKS` and `validation_mechanics`. Resize a recipe through its options, and keep clearances (at least 0.3 mm for moving fits) and minimum walls intact when scaling a model up or down. When no recipe fits, model the connector with the kit and declare it with `K.joint` + `K.step_*`; copy the nearest recipe's proportions.

What the mechanics check needs, whichever way you build:

- Only the root part is held. Every other part must be caught by shape in every direction: a quarter-turn bayonet cap, a snap barb/ring wider than the bore, a removable keyed pin with locking cap, or an end-stop plug closing a slide. Friction, press fits, magnets, and glue hold nothing in the rigid check (`retainer='friction'` reports `retainer_unverified_friction`).
- Keep at least 0.3 mm between separate moving parts (`RUMI_CHECKS` uses exact `BRepExtrema` surface distance and flags `< 0.2 mm` as `insufficient_clearance`). Fixed mates may touch flush (`0.0 mm`) without error, while overlapping fixed volumes fail.
- Provide disassembly `actions` for every nonroot part (`K.publish` collects recipe steps automatically in topological removal order — caps/pins/plugs first, then moving parts).

## Catalog

All moving recipes print as separate pieces with real retainers and auto-generated disassembly `actions`. **verifiable** recipes pass `cad/validate.py` and `rumi-bullet` v2; **unverified** recipes rely on friction, magnets, or external metal hardware and stay marked unverified by design.

| Need | Recipe | Parts & retainer | Card |
|---|---|---|---|
| Wheel spinning on a stub axle (twist-lock cap) | `K.wheel` then `K.bayonet_axle` | 3 parts: axle + wheel + 90° bayonet cap | `wheels.md` |
| Wheel snapping onto a split stub axle | `K.wheel` then `K.snap_axle` | 2 parts: split barbed axle + counterbored wheel | `wheels.md` |
| Two wheels turning together on one axle | `K.through_axle` | 4 parts: body + axle/left wheel + keyed right wheel + keyed snap cap | `wheels.md` |
| Soft tyre on a rigid hub | `K.tyre` | 2 parts: pegged hub + snap-on TPU tyre | `wheels.md` |
| Door, lid, or flap (pin hinge) | `K.pin_hinge` (alias `K.barrel_hinge`) | 4 parts: parent/child knuckles + keyed pin + bayonet cap | `rotation.md` |
| Door that clips onto a post | `K.snap_hinge` | 2 parts: post + compliant C-clip leaf | `rotation.md` |
| Fold line in one flexible part | `K.living_hinge` | 1 part (PP/PETG/TPU, no rigid joint) | `rotation.md` |
| Tilting head or arm | `K.ball_socket` | 2 parts: slotted compliant socket + ball stem | `rotation.md` |
| Turntable, turret, spinner | `K.turntable_plate` then `K.turntable` | 3 parts: bayonet post + platter + 90° hub cap | `rotation.md` |
| Shaft turning inside a housing | `K.bearing` | 3 parts: bored housing + flanged rotor + snap retainer cap | `rotation.md` |
| Sliding carriage or drawer | `K.dovetail_slide`, `K.tslot_rail` | 3 parts: open-ended rail + slider + snap end-stop plug | `sliders.md` |
| Telescoping tube, piston | `K.telescoping_tube` | 3 parts: open chamber + flanged rod + twist-lock mouth collar | `sliders.md` |
| Latch or slider in a slot | `K.pin_slot` | 4 parts: slotted plate + bored block + stadium pin + keyed snap cap | `sliders.md` |
| Snap two parts together | `K.snap_hook` | 2 parts: chamfered window + cantilever hook | `fasteners.md` |
| Round snap-on lid | `K.snap_lid` | 2 parts: beaded rim + grooved keyed skirt | `fasteners.md` |
| Flat-pack wall into a base | `K.tab_slot` | 2 parts: slotted plate + barbed tabs | `fasteners.md` |
| Twist-lock cap | `K.bayonet_lock` | 2 parts: L-slot socket + lugged plug (`retainer='bayonet'`) | `fasteners.md` |
| Printed bolt and nut | `K.bolt_nut` | 2 parts: analytic B-Rep helical thread (`retainer='threaded'`) | `fasteners.md` |
| Push-fit pegs, dog-bone key, magnets, metal insert | `K.press_pegs`, `K.dogbone_key`, `K.magnet_pockets`, `K.insert_boss` | unverified: held by friction, magnetism, or hardware | `fasteners.md` |
| Meshing gears | `K.gear_pair` (blank: `K.spur_gear`) | 5 parts: base + 2 gears + 2 bayonet hub caps | `mechanisms.md` |
| Rack and pinion | `K.rack_pinion` | 6 parts: base + pinion + rack + 3 bayonet caps | `mechanisms.md` |
| One-way ratchet | `K.ratchet` | 5 parts: base + wheel + pawl + 2 bayonet caps | `mechanisms.md` |
| Cam lifting a follower | `K.cam_follower` | 5 parts: base + cam + follower + bayonet cam cap + keyed snap cap | `mechanisms.md` |
| Slider that clicks between positions | `K.detent_slider` | 4 parts: base + slider + 2 bayonet caps | `mechanisms.md` |
| One-piece spring | `K.flexure_spring` | 1 part (no rigid joint) | `mechanisms.md` |

Read the card before the first use of a recipe. Each family's file under `references/` beside this skill gives every recipe's call, what the parts must provide, the options worth changing, and how it prints and assembles.
