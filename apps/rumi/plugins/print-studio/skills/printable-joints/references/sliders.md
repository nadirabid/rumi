All linear sliding recipes in `cad/joints/sliders.py` are **separate-print** assemblies. Rails open at one end for clean sliding insertion and lock closed with a separate snap-in end-stop plug or twist-lock collar.

## dovetail_slide

**Use for**: a 3-part sliding carriage or drawer on an open-ended dovetail rail closed by a snap-in end-stop plug.

**Call**: `res = K.dovetail_slide(base, carriage, (0, 0, 0), '+X', '+Z', travel=30, control='Drawer')`

**You provide**: `base` (the held part) with a flat top at the pivot, at least 11 mm thick, 22 mm wide, and `travel + length + stop_length + 8` mm long; `carriage`, a block over the pivot at least 3 mm tall. `axis` is the slide direction, `up` points out of `base`.

**Key options**: `travel` 10 to 60; `length` 14 to 30; `head_width` 8 to 14; `head_height` 4 to 6; `clearance` 0.35; `stop_length` 8.0; `barb` 0.9.

**Prints & assembles**: all 3 parts print flat; PLA or PETG. Slide carriage into the open rail end, then snap the end-stop plug in place (`step_snap` on plug, `step_translate` on carriage). Records `dovetail-slide` badge evidence.

## tslot_rail

**Use for**: a 3-part T-shaped slider inside an open-ended T-slot rail closed by a snap-in end-stop plug.

**Call**: `res = K.tslot_rail(block, slider, (0, 0, 0), '+X', '+Z', travel=30, control='Slider')`

**You provide**: `block` with a flat top at the pivot, at least 10 mm deep, 16 mm wide, and long enough for travel + slider + end stop; `slider` at least 4 mm tall. Axes as `dovetail_slide`.

**Key options**: `travel` 10 to 60; `length` 14 to 30; `head_width` 10 to 16; `head_height` 3.5 to 6; `neck_depth` 2.5 to 4; `neck_clearance` 0.8; `barb` 0.9.

**Prints & assembles**: all 3 parts print separately; PLA or PETG. Slide T-slider in from the open end and snap in the end-stop plug.

## telescoping_tube

**Use for**: a 3-part rod or piston that slides out of an open-chamber cylinder and stops at both ends via a twist-lock bayonet mouth collar.

**Call**: `res = K.telescoping_tube(outer, inner, (0, 0, 0), 'Z', tube_diameter=14, travel=24, control='Piston')`

**You provide**: `outer` with its mouth face at the pivot and solid depth for chamber + collar; `inner` rod of `tube_diameter` reaching behind the pivot. `axis` points out of the mouth.

**Key options**: `travel` 10 to 40; `tube_diameter` 12 to 28; `flange_thickness` 4; `collar_depth` 9.0; `clearance` 0.35; `turn` 45.

**Prints & assembles**: outer tube, flanged inner rod, and mouth collar print separately upright with flat bases; PLA or PETG. Drop inner rod into chamber, insert collar, twist 45° to lock (`step_twist` on collar, `step_translate` on inner rod).

## pin_slot

**Use for**: a 4-part latch or slider guided by a separate headed stadium pin through a through-slot, retained by a keyed double-D snap cap (`retainer='snap'`, full 6-DOF, cannot unscrew during motion).

**Call**: `res = K.pin_slot(plate, block, (0, 0, 0), '+X', '+Z', travel=24, control='Latch')`

**You provide**: `plate` with a flat top at the pivot, at least 8 mm thick, 16 mm wide, and long enough for the slot; `block` over the pivot at least 5 mm tall. Axes as `dovetail_slide`.

**Key options**: `travel` 10 to 40; `pin_diameter` 6.5 to 9 (7.5 default); `pin_length` 14 to 24; `head_overhang` 3.0; `clearance` 0.35.

**Prints & assembles**: plate, block, stadium pin, and keyed snap cap print flat separately; PLA or PETG. Insert stadium pin through plate slot and block bore, then press-snap the keyed cap onto the pin tip (`step_snap` on cap, `step_translate` on pin and block).
