## snap_hook

**Use for**: a clip that clicks through a window in a wall and cannot be pulled back out.

**Call**: `j = K.snap_hook(panel, clip, (0, 0, 0), '+X', '+Z', width=8, wall=3)`

**You provide**: `panel` with a flat wall `wall` thick at the pivot, 22 x 12 mm or more; `clip`, a block 9 mm behind that face, 22 x 12 mm or more. `axis` is the push direction, `hook_side` the way the hook points. The recipe cuts the window and adds arm, guide and stops.

**Key options**: `width` 6 to 12; `arm_thickness` 1.6 to 2.5; `hook_height` 1.2 to 2; keep `lead_in` 0.8.

**Prints as**: separate; clip with the arm flat, PETG or nylon (PLA arms snap).

**Validation**: assembly, geometry (warnings) and fit pass; mechanics passed, verified, 13 of 13 probes; same at (47, -31, 18) with axis +Y and axis -X. Without `lead_in` the window rim read 2.8 mm penetration.

## snap_lid

**Use for**: a round lid that snaps onto a round tub.

**Call**: `j = K.snap_lid(tub, lid, (0, 0, 30), '+Z', radius=20)`

**You provide**: `tub`, a round wall of outer `radius`, 1.4 mm or more thick, flat rim at the pivot; `lid`, a plate 1.5 mm or more thick and wider than radius + 2.5 mm, underside 0.3 mm above the rim. The recipe adds bead and ribs to the tub, skirt, groove and slots to the lid.

**Key options**: `bead` 0.6 to 1.0; `skirt_wall` 2.2; `keys` 2 (0 lets the lid spin).

**Prints as**: tub upright, lid upside down; PETG or PP.

**Validation**: assembly, geometry (warnings) and fit pass; mechanics passed, verified, 13 of 13 probes; same at (47, -31, 18) with axis +Y and -X. Without keys the lid spun: `unretained_part`.

## press_pegs

**Use for**: locating two parts with pegs in blind holes.

**Call**: `j = K.press_pegs(base, cover, [(-8, 0, 0), (8, 0, 0)], '+Z', diameter=5, length=8)`

**You provide**: two parts with flat faces `gap` (0.2) apart, never touching; pegs rise from the first at the points (`pegs_on='child'` for the second). Keep the face outlines 0.3 mm or more apart: identical outlines read 20 mm penetration.

**Key options**: `diameter` 3 to 10; `length` 6 to 12; `clearance` 0.05 to 0.2.

**Prints as**: separate; PLA or PETG.

**Validation**: kind (b), held by friction. Cheap checks pass. Axis +X: `unretained_part` (3 of 4 probes passed). Upright it passed 13 of 13 only because the cover's weight beats the lift probe. Tell the user it is unverified; `K.join` fuses the parts.

## dogbone_key

**Use for**: tying two flat plates side by side with a separate dog-bone key.

**Call**: `j = K.dogbone_key(left, right, (0, 0, 9), '+X', '+Z')` (two records; pass them to `K.publish`)

**You provide**: plates 9 mm thick with a 0.3 mm seam, reaching 10 mm each way from the pivot on the seam at the key's face. `axis` crosses the seam, `lift` leaves the face. Default: open pockets, the key drops in. `closed=True` seals it in (print-in-place, plates 7.5 mm or more).

**Key options**: `length` 16 to 30; `bulb_diameter` 8 to 14; `neck_width` 4 to 6.

**Prints as**: flat; PLA or PETG.

**Validation**: cheap checks pass, both variants. Open: `unretained_part` on the seam (lift-out), unverified. Closed: 0.40 mm penetration, unverified.

## tab_slot

**Use for**: a standing wall that clicks into slots in a base plate.

**Call**: `j = K.tab_slot(base, wall, (0, 0, 4), '+Z', '+X', tabs=(-12, 12))`

**You provide**: `base` of thickness `plate` (4), top face at the pivot; `wall` with a flat foot 0.2 mm above it, 3 mm or more thick. `across` runs along the foot. The recipe cuts slots and adds split barbed tabs.

**Key options**: `tab_width` 8 to 14; `tab_thickness` 2 to 4; `barb` 0.5 to 0.8; `relief` 0 to 4 (more flex).

**Prints as**: wall flat; PETG.

**Validation**: cheap checks pass; 3 tabs with relief 3 pass too. Mechanics: rest passes, then a sideways probe reads 0.157 mm penetration (0.48 mm at limit 0.3; the wall leans 7 degrees): unverified. An 8 mm thick foot read 3.2 mm at rest.

## bayonet_lock

**Use for**: a cap locked by a quarter turn; modelled locked, declared fixed.

**Call**: `j = K.bayonet_lock(socket, cap, (0, 0, 22), '+Z')`

**You provide**: `socket`, a solid block 30 mm or more across and 16 mm deep, flat mouth at the pivot; `cap`, a disc wider than the stem, underside `gap` (1.2) above the mouth. The recipe cuts bore, slots and notches, adds stem and lugs.

**Key options**: `bore_diameter` 16 to 30; `lugs` 2 to 4; `turn` 40; `notch` 0.8 (`gap` at least notch + 0.3). Use whole degrees.

**Prints as**: separate; PETG.

**Validation**: cheap checks pass, also at an offset on axis +X and -X. Mechanics: 5 probes passed, then 0.20 mm penetration (limit 0.3: 11 of 12 pass; the last reads 0.80 mm though the notch stops the twist at 3 degrees). `notch=0`: the twist back is free, `unretained_part`.

## bolt_nut

**Use for**: a real helical thread on a printed stud, with a printed nut or cap.

**Call**: `j = K.bolt_nut(plate, nut, (0, 0, 0), '+Z', diameter=12, pitch=2, length=20, seat=2)`

**You provide**: `plate` with a flat face at the pivot and 1 mm or more of material under it; `nut`, a hex block or cap wider than the thread, near face flat at `seat`. The recipe grows the stud and cuts the thread.

**Key options**: `diameter` 8 to 30; `pitch` 2 to 4; `length` at least seat + 2 x pitch; `clearance` 0.2 to 0.4.

**Prints as**: stud vertical, 0.1 to 0.15 mm layers; slow.

**Validation**: assembly, geometry (warnings) and fit pass; D16 pitch 2.5 at axis +Y and -X too. Mechanics: 11 of 12 probes pass; spin about the axis fails `unretained_part` (the nut can unscrew). About 7 s.

## insert_boss

**Use for**: a screw clamping two parts through a brass heat-set insert; no hardware is modelled.

**Call**: `j = K.insert_boss(block, cover, [(-8, -8, 0), (8, 8, 0)], '+Z', screw='M3')`

**You provide**: `block` with 12 mm or more of solid under each point; `cover` 5 mm or more thick, face 0.2 mm above the block's, outline 1 mm inside it. The recipe cuts insert pocket, clearance hole and counterbore.

**Key options**: `screw` M2 to M5; `insert_diameter`, `insert_length` from the datasheet; `melt` 0.4.

**Prints as**: separate; buy brass inserts and screws.

**Validation**: kind (b). Cheap checks pass. Axis +X: `unretained_part`. Upright: 4.6 mm penetration at rest. Unverified; the screws hold it. Tell the user.

## magnet_pockets

**Use for**: two parts held by hidden disc magnets and located by pins.

**Call**: `j = K.magnet_pockets(base, cover, [(-5.5, 0, 0), (5.5, 0, 0)], '+Z', pins=[(-16, 0, 0), (16, 0, 0)])`

**You provide**: `base` with its face at the pivot and 8 mm or more of solid; `cover` 8 mm or more thick, face 0.2 mm above, outline 1 mm inside. The recipe cuts cavities and holes, adds pins of two sizes (one fit only).

**Key options**: `magnet_diameter` 4 to 10; `magnet_thickness` 1 to 4; `skin` 0.6; `vent` 0.6 or more (a sealed cavity is refused).

**Prints as**: pause at the cavity top, add magnets, opposite poles facing.

**Validation**: kind (b). Cheap checks pass (thin_faces warnings). Axis +X: `unretained_part` (3 of 4 probes passed). Upright 13 of 13 by weight only. A sealed cavity read `disconnected_body`. Unverified.
