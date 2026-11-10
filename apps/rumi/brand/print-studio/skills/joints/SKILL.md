---
name: joints
description: Ready-made printable joints and a millimetre modelling kit for Blender scripts — wheels on axles, hinges, sliders, snap fits, gears. Read before modelling any part that moves or attaches to another part.
---

# Joints and the modelling kit

`blender_status` returns a `joints` path. Load it at the top of the build script:

```python
import runpy, types
K = types.SimpleNamespace(**runpy.run_path(joints_path))
```

The kit works in **millimetres, Z up** and creates the Blender geometry in metres for you. Do not mix raw `bpy` coordinates with kit calls. Parts keep identity transforms, which the joint frames need.

Use the kit and a recipe before designing a connector yourself. Working out retention geometry and joint frames by hand is the slowest part of a build; a recipe is one call.

## Kit

| Call | Makes |
|---|---|
| `K.start()` | An empty metric scene. Call once, first. |
| `K.box(name, size, center)`, `K.box2(name, low, high)` | A box by size and centre, or by two corners. |
| `K.cylinder(name, radius, length, center, axis, radius2=None)`, `K.rod(name, radius, a, b)` | A cylinder or cone frustum, by centre and axis or between two points. |
| `K.sphere(name, radius, center)`, `K.prism(name, points, height, center, axis)`, `K.lathe(name, profile, center, axis)` | A sphere, an extruded 2D outline (concave is fine), a revolved `(radius, height)` profile. |
| `K.join(a, b, ...)`, `K.cut(a, tool, ...)`, `K.common(a, tool)` | Fuse, subtract, intersect. The first part is changed and kept; the others are deleted. Results are cleaned for the geometry check. |
| `K.copy(obj, name)`, `K.mirror(obj, 'X', name)`, `K.move(obj, offset)`, `K.rotate(obj, axis, degrees, pivot)` | Duplicate, mirror across the origin plane, translate, turn. |
| `K.paint(obj, (r, g, b))` | One surface colour. |
| `K.bounds(obj)`, `K.solids(obj)` | Corner coordinates; the number of disconnected pieces (a printable part has one). |
| `K.joint(name, kind, parent, child, axis, pivot, limits, control)` | A joint record for a connector you modelled yourself. |
| `K.publish(directory, root, joints, mode='print-in-place')` | Publishes `model.usda`, writes the whole USD assembly from the joint records, and prints `RUMI_CHECKS`. It replaces `helper["publish"]` and `configure_robot`. |

Axes are `'X'`, `'-Y'`, `'+Z'` or a vector. Give tools and helper solids names starting with `_`; never leave one in the scene, because every visible mesh is published as a part. Overlap pieces you fuse by at least 0.5 mm and run cutters past the surface.

## Build order

1. Block out each physical part as a simple solid with its real outer size and position.
2. Choose each joint's pivot and axis from those coordinates.
3. Call the recipe. It adds and cuts the mating features on both parts and returns the joint record. A recipe raises an error that says what to move when a part does not reach the joint.
4. Add detail and colour. Build one side and `K.mirror` it for pairs.
5. `K.publish(...)`, read `RUMI_CHECKS`, then follow `blender-modeling` for `viewer_load` and validation.

## Worked example

A box kart with four spinning wheels and two opening doors:

```python
import runpy, types
K = types.SimpleNamespace(**runpy.run_path(joints_path))
K.start()
body = K.box('KartBody', (80, 120, 30), (0, 0, 25))
K.cut(body, K.box('_cockpit', (68, 50, 30), (0, 0, 32)))
K.paint(body, (0.85, 0.2, 0.1))
joints = []
for sx, side in ((1, 'Right'), (-1, 'Left')):
    out = '+X' if sx > 0 else '-X'
    for sy, end in ((1, 'Front'), (-1, 'Rear')):
        pivot = (sx * 40, sy * 44, 14)                      # on the body's side face
        wheel = K.wheel(end + side + 'Wheel', pivot, out, diameter=28, width=10, tread=12)
        K.paint(wheel, (0.1, 0.1, 0.1))
        joints.append(K.captive_axle(body, wheel, pivot, out, width=10, control=end + ' ' + side.lower() + ' wheel'))
    door = K.box2(side + 'Door', (40.5, -12, 14), (44.5, 18, 38))   # overlay door, 0.5 mm off the body face
    if sx < 0:
        K.mirror(door, 'X')
    K.paint(door, (0.95, 0.75, 0.35))
    joints.append(K.barrel_hinge(body, door, (sx * 46.3, -20, 26), 'Z', parent_side='-X' if sx > 0 else '+X',
                                 child_side='+Y', length=20, limits=(-110, 0) if sx > 0 else (0, 110), control=side + ' door'))
K.publish('models/kart', body, joints)
```

## Recipes are starting points

Each recipe was checked alone at its default size on a small sample; your whole model still has to pass its own checks. Resize a recipe through its options, and keep clearances and minimum walls as they are when you scale a model up or down. When no recipe fits, model the connector with the kit and declare it with `K.joint`; copy the nearest recipe's proportions.

What the mechanics check needs, whichever way you build:

- Only the root part is held. Every other part must be caught by shape in every direction: a head wider than its bore, a pin fused into both knuckles, a lip over a slider. Friction, press fits, magnets and glue hold nothing in the check.
- So prefer the captive default of each recipe, which prints assembled. A join held only by friction stays unverified; say so, or fuse the two parts with `K.join` when they need not come apart.
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

Read the card before the first use of a recipe. Each family's file under `references/` beside this skill gives every recipe's call, what the parts must provide, the options worth changing, how it prints, and what validation reported. `wheel`, `captive_axle` and `barrel_hinge` are shown in the worked example above.
