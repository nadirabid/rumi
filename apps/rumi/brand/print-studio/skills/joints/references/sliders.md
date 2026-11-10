## dovetail_slide

**Use for**: a carriage on a dovetail key in a closed groove; it cannot lift off or leave.

**Call**: `j = K.dovetail_slide(base, carriage, (0, 0, 0), '+X', '+Z', travel=30, control='slide')`

**You provide**: `base` (the held part) with a flat top at the pivot, 11+ mm thick, 22+ mm wide, `travel` + 20 mm long; `carriage`, a block over the pivot at least 3 mm tall. `axis` is the slide direction, `up` points out of `base`. The recipe cuts the groove and fuses the key.

**Key options**: `travel` 10 to 60; `length` 12 to 30; `head_width` 8 to 14; `head_height` 4 to 6.

**Prints as**: print-in-place, base upright; PLA or PETG.

**Validation**: assembly, geometry and fit pass (overhang warnings); mechanics passed, verified, 209 of 209 probes. Same when rotated (axis -Y, up +X, pivot (37, -22, 14)).

## tslot_rail

**Use for**: a T-shaped slider in a closed T-slot.

**Call**: `j = K.tslot_rail(block, slider, (0, 0, 0), '+X', '+Z', travel=30, control='slide')`

**You provide**: `block` with a flat top at the pivot, 10+ mm deep, 16+ mm wide, `travel` + 20 mm long; `slider`, a block over the pivot at least 4 mm tall. Axes as `dovetail_slide`.

**Key options**: `travel` 10 to 60; `length` 12 to 30; `head_width` 8 to 16; `head_height` 3 to 6; `neck_depth` 2.5 to 4; leave `neck_clearance` at 1.

**Prints as**: print-in-place, block upright (the lid bridges); PLA or PETG.

**Validation**: assembly, geometry and fit pass (overhang warnings); mechanics passed, verified, 209 of 209 probes; same rotated. With a tight stem, a sideways probe read 3.6 mm penetration.

## telescoping_tube

**Use for**: a rod that slides out of a socket and stops at both ends.

**Call**: `j = K.telescoping_tube(outer, inner, (0, 0, 0), 'Z', tube_diameter=20, travel=30, control='tube')`

**You provide**: `outer` with its mouth face at the pivot, 43+ mm deep, 36+ mm across; `inner`, a solid rod of `tube_diameter` reaching 23+ mm behind the pivot. `axis` points out of the mouth.

**Key options**: `travel` 10 to 40; `tube_diameter` 10 to 30; `lip` 5 to 8; `flange_thickness` 3 to 5; `neck_clearance` 0.6.

**Prints as**: print-in-place, mouth up; PLA or PETG.

**Validation**: assembly, geometry and fit pass (overhang warnings); mechanics passed, verified, 209 of 209 probes, axis vertical and along X. A 3 mm lip passed vertical but sagged sideways.

## pin_slot

**Use for**: a block that slides on a headed pin in a closed slot.

**Call**: `j = K.pin_slot(plate, block, (0, 0, 0), '+X', '+Z', travel=24, control='slide')`

**You provide**: `plate` with a flat top at the pivot, 8+ mm thick, 14+ mm wide, `travel` + 20 mm long; `block` over the pivot at least 4 mm tall. Axes as `dovetail_slide`.

**Key options**: `travel` 10 to 40; `pin_diameter` 4 to 6; `pin_length` 6 to 12; `head_diameter` 9 to 14; `head_length` 14 to 24.

**Prints as**: print-in-place, plate upright (the lid bridges); PLA or PETG.

**Validation**: assembly, geometry and fit pass (overhang warnings); mechanics passed, verified, 187 of 187 probes; same rotated. A round pin spins freely and fails `unretained_part`, so pin and head are ovals.
