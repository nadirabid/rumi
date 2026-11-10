# Mechanisms

Recipes from `joints/mechanisms.py`. Lengths are millimetres. `axis` points away from the base face the recipe grows from; the base must be flat there. Every moving part sits on an integral post or inside an integral guide, so nothing is loose hardware. Use axis-aligned directions such as `'+X'`; a diagonal direction left a degenerate face in one test.

## spur_gear

**Use for**: one involute gear blank (20 degree pressure angle) to put on `captive_axle`, like `wheel`.
**Call**: `g = K.spur_gear('Gear', 18, (0, 0, 0), '+Z', module=2, width=6)`, then `K.captive_axle(base, g, (0, 0, 0), '+Z', width=6)`.
**You provide**: name, tooth count (12 or more), pivot on the base face, axis.
**Key options**: `module` 1.5 or more; `backlash` 0.7 or more (0.8 default); `xdir`, `phase_degrees` set tooth 0.
**Prints as**: print-in-place, axis up.
**Validation**: only measured inside `gear_pair`, never alone. Two gears side by side must be placed with `gear_pair`, which sets centre distance, tooth phase and tip trim.

## gear_pair

**Use for**: two meshing gears turning on captive posts.
**Call**: `joints = K.gear_pair(base, (0, 0, 0), '+Z', 16, 20, toward='+X')`
**You provide**: base, centre of gear A, axis, tooth counts, `toward` (direction from A to B).
**Key options**: `module` (2 and 2.5 tested), `width` (6 and 7 tested), `limits`. Each gear needs 14 or more teeth.
**Prints as**: print-in-place on the base, axis up. Gear B sits 0.5 mm higher so the faces are not coplanar.
**Validation**: 16:20 passed `verified=True` (185 probes per gear, +-180 degrees). Ratios above 1.45 default to +-10 degrees: 14:30 passed there, but +-20 gave a false block. Tell the user a short turn was verified. 12 and 13 tooth gears jammed or read 0.18 mm penetration, so they are refused.

## rack_pinion

**Use for**: a pinion that slides a rack.
**Call**: `joints = K.rack_pinion(base, (0, 0, 0), '+Z', '+X', pinion_teeth=16, travel=30)`
**You provide**: base, pinion centre, axis, slide direction.
**Key options**: `travel` (30 and 20 tested), `pinion_teeth` 12 or more, `module`. The rack lies on the -(axis x slide) side.
**Prints as**: print-in-place on a flat base, axis up. The rack has a slot over two headed posts; slot ends stop it 0.3 mm past the travel.
**Validation**: `verified=True` (pinion 97 probes, rack 229, +-15 mm). Second placement (14 teeth, module 2.5, axis -Y) passed the cheap checks.

## ratchet

**Use for**: a wheel that turns one way and is locked the other way.
**Call**: `joints = K.ratchet(wall, (0, 0, 0), '-Y', '+Z')` (pawl on the +Z side).
**You provide**: base, wheel centre, axis, `up` (the pawl side, perpendicular to axis).
**Key options**: `teeth` (12 tested; 10 passed cheap checks), `diameter` 40 or more.
**Prints as**: print-in-place. No spring: gravity drops the pawl nose into the teeth, so the axis must be roughly horizontal.
**Validation**: `verified=True` (43 probes each). The checker drives the wheel only 15 degrees clockwise and back (it always returns a joint to zero through the locked direction); 17 degrees read 0.74 mm penetration. A rigid overlap test: the lock bites after about 6 degrees of back-turn. Tell the user a full free turn was not checked.

## crank_slider

**Use for**: a crank turning a slider back and forth through a rod.
**Call**: `joints = K.crank_slider(base, (0, 0, 0), '+Z', '+X', crank_radius=10, rod_length=40)`
**You provide**: base, crank centre, axis, slide direction.
**Key options**: `crank_radius`, `rod_length` (3 times the radius or more); `crank_range`, `slider_range` set what the checker drives.
**Prints as**: print-in-place on a flat base; the rod lies over crank and slider.
**Validation**: not verified. Stock limit: 0.166 mm penetration at rest. At 0.3 mm the crank (+-10 degrees) and rod pin pass, but one slider (+-3 mm) retention probe reads 4.8 mm. Declaring both rod pins (two parents) gave `unsupported_coupled_motion` and zero probes, so only the crank pin is declared. Tell the user the linkage is unverified.

## cam_follower

**Use for**: a cam that lifts a follower that cannot leave its guide.
**Call**: `joints = K.cam_follower(wall, (0, 0, 0), '-Y', '+Z')` (follower rises along `up`).
**You provide**: base, cam axle centre, axis, `up`.
**Key options**: `eccentricity` (lift is twice that), `cam_radius` (7 mm more than eccentricity or more).
**Prints as**: print-in-place; guide arch fused to the base. Follower is one piece: foot, stem through the arch, head above it.
**Validation**: stock limit fails: one cam retention probe reads 0.22 mm penetration. At 0.3 mm limit it passes `verified=True` (cam +-180 degrees, 175 probes; follower 0 to 6 of the 7 mm lift, 86 probes). Say gravity must return the follower.

## detent_slider

**Use for**: a slider that clicks between notches.
**Call**: `joint = K.detent_slider(base, (0, 0, 0), '+Z', '+X', positions=3, pitch=8)`
**You provide**: base, slider centre, axis, slide direction.
**Key options**: `positions` (odd), `pitch` (6 or more); `limits` default +-pitch/2.
**Prints as**: print-in-place, axis up. A slot over two headed posts holds the slider; a thin arm carries the bump.
**Validation**: `verified=True` at +-4 mm with pitch 8 (99 probes). +-6 and +-8 mm read 0.2 mm penetration. The arm is rigid in the checker, so click force is not simulated; the user must try the print.

## flexure_spring

**Use for**: a one-piece spring between two mounting blocks.
**Call**: `s = K.flexure_spring('Spring', (0, 0, 0), '+Z', '+X')`
**You provide**: name, pivot, axis (height direction), `pull` (direction the blocks move).
**Key options**: `beams` (even), `beam_length`, `thickness` 0.8 or more, `height`.
**Prints as**: one solid, print flat with the height along axis. Join it with `join`, or publish it alone.
**Validation**: single solid; all cheap checks and mechanics passed (no joints). Second placement passed. Stiffness and fatigue were not measured: tell the user to test a print.
