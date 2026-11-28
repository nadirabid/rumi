# Mechanisms

All movable mechanisms in `cad/joints/mechanisms.py` are **separate-print** assemblies mounted on removable bayonet-capped axles/posts. Lengths are millimetres, Z up. `axis` points away from the flat base face the mechanism mounts onto.

## spur_gear

**Use for**: a flat-printable involute spur gear blank (20° pressure angle) to mount on `bayonet_axle` or `snap_axle`.

**Call**: `g = K.spur_gear('Gear', 18, (0, 0, 0), '+Z', module=2, width=6)`, then `K.bayonet_axle(base, g, (0, 0, 0), '+Z', width=6)`.

**Key options**: `module` 1.5 or more; `backlash` 0.7 to 1.0 (0.8 default); `xdir`, `phase_degrees`. Place two meshing gears with `gear_pair` so centre distance and tooth phase match automatically.

## gear_pair

**Use for**: two meshing involute gears spinning on separate bayonet axles with locking hub caps (5 separate parts: base, 2 gears, 2 bayonet caps).

**Call**: `res = K.gear_pair(base, (0, 0, 0), '+Z', 16, 20, toward='+X')`

**You provide**: `base`, centre of gear A, `axis`, tooth counts (14 or more per gear), `toward` (direction from A to B).

**Key options**: `module` 2.0 to 2.5; `width` 6 to 8; `axle_diameter` 7.0; `limits`; `names`; `controls`.

**Prints & assembles**: base, both gears, and both bayonet caps print flat separately; PLA or PETG. Drop gears onto bayonet axles, twist-lock caps 90°. Records `gear-pair` badge evidence.

## rack_pinion

**Use for**: a spinning pinion driving a linear slotted rack on two bayonet-capped guide posts (6 separate parts: base, pinion, rack, 3 bayonet caps).

**Call**: `res = K.rack_pinion(base, (0, 0, 0), '+Z', '+X', pinion_teeth=16, travel=30)`

**You provide**: `base`, pinion centre, `axis`, `slide` direction. The rack sits on the `-(axis × slide)` side.

**Key options**: `travel` 20 to 40; `pinion_teeth` 12 or more; `module` 2.0 to 2.5; `width` 6.

**Prints & assembles**: all 6 parts print flat separately; PLA or PETG. Place pinion and rack on posts, twist-lock the 3 bayonet caps. Records `rack-and-pinion` badge evidence.

## ratchet

**Use for**: a wheel that turns freely one way and locks against a gravity-dropped pawl the other way (5 separate parts: base, wheel, pawl, 2 bayonet caps).

**Call**: `res = K.ratchet(wall, (0, 0, 0), '-Y', '+Z')` (pawl on the `+Z` side).

**You provide**: `base`, wheel centre, `axis` (roughly horizontal so gravity drops the pawl nose), `up` (pawl side, perpendicular to axis).

**Key options**: `teeth` 10 to 14; `diameter` 40 or more; `width` 6; `axle_diameter` 7.0.

**Prints & assembles**: all 5 parts print flat separately; PLA or PETG. Mount wheel and pawl on bayonet axles, twist-lock caps.

## cam_follower

**Use for**: an eccentric cam lifting a guided follower (5 separate parts: base, cam, follower, bayonet cam cap on the stationary post, and keyed double-D snap cap on the moving follower stem).

**Call**: `res = K.cam_follower(wall, (0, 0, 0), '-Y', '+Z')` (follower rises along `up`).

**You provide**: `base`, cam axle centre, `axis`, `up`.

**Key options**: `eccentricity` (lift is twice that, 3.5 default); `cam_radius` (18 default, at least 7 mm more than eccentricity); `stem_diameter` 7.5; `width` 6.

**Prints & assembles**: all 5 parts print flat separately; PLA or PETG. Mount cam on bayonet axle with its twist-lock cap, insert follower and snap its keyed double-D retainer cap. Gravity returns the follower.

## detent_slider

**Use for**: a linear slider with a compliant bump arm that clicks between discrete positions (4 separate parts: base, slider, 2 bayonet caps).

**Call**: `res = K.detent_slider(base, (0, 0, 0), '+Z', '+X', positions=3, pitch=8)`

**You provide**: `base`, slider centre, `axis`, `slide` direction.

**Key options**: `positions` (odd, 3+); `pitch` 6 or more; `width` 6; `limits` (defaults to `±pitch/2`).

**Prints & assembles**: all 4 parts print flat separately; PETG recommended for crisp spring click. Bullet checks rigid motion/retention; test click force on a physical print.

## flexure_spring

**Use for**: a one-piece flat-printable serpentine flexure spring between two mounting blocks (no rigid joint).

**Call**: `s = K.flexure_spring('Spring', (0, 0, 0), '+Z', '+X')`

**Key options**: `beams` (even); `beam_length`; `thickness` 0.8 or more; `height`; `block`; `hole_diameter`.

**Prints as**: one solid flat on the bed; PETG or PLA. Stiffness and fatigue require physical testing.

## living_hinge

See [rotation.md](rotation.md#living_hinge) — one-piece flexible fold for PP, PETG, or TPU (records `living-hinge` badge evidence).
