## wheel

**Use for**: the wheel blank that `captive_axle` and `axle_clip` mount; make it first.

**Call**: `w = K.wheel('FrontLeftWheel', (-40, 44, 14), '-X', diameter=28, width=10, tread=12)`

**You provide**: the pivot on the body's side face and the axis pointing away from the body. The disc's inner face sits `standoff + end_play` (1.3 mm) off the pivot.

**Key options**: `diameter` 20 to 60; `width` 8 to 14; `tread` 0 to 16 ribs; keep `end_play` 0.3 and `standoff` 1.

**Prints as**: part of the assembled print, axis horizontal; PLA or PETG.

**Validation**: no separate run; it is the wheel in the `captive_axle` sample.

## captive_axle

**Use for**: a wheel or roller that spins on a stub axle growing out of the body.

**Call**: `j = K.captive_axle(body, w, (-40, 44, 14), '-X', width=10, control='front left wheel')`

**You provide**: a solid `body` under the pivot; a `wheel` made at the same pivot, axis and `width`.

**Key options**: `axle_diameter` 4 to 8; `head_overhang` 1.2 to 2; keep `snap` False and `recess` True.

**Prints as**: print-in-place, axle and head fused to the body; PLA or PETG.

**Validation**: four-wheel sample (tread 12): assembly, geometry (warnings) and fit pass; mechanics passed, verified, 225 of 225 probes per wheel. `snap=True` fails `excessive_penetration` 0.16 to 0.20 mm (reported, not re-run).

## through_axle

**Use for**: one axle through the body with a wheel on each end, turning together.

**Call**: `j = K.through_axle(body, 'RearAxle', (0, -22, 14), 'X', body_width=40, wheel_diameter=28, wheel_width=8, tread=10)`

**You provide**: a solid `body` whose two faces are `body_width` apart, centred on the pivot along the axis. `child` is a new name; paint it via `K.bpy.data.objects['RearAxle']`.

**Key options**: `axle_diameter` 4 to 8; `wheel_diameter` 16 to 60; `wheel_width` 4 to 14; `tread`.

**Prints as**: print-in-place, one solid, axle horizontal; PLA or PETG.

**Validation**: assembly, geometry (warnings) and fit pass; mechanics passed, verified, 165 of 165 probes; same at pivot (37, -22, 14), axis Y. Wheels bearing straight on a flat box face read 0.16 to 0.99 mm penetration, hence the small bearing rings.

## tyre

**Use for**: a separate soft tyre seated on a hub.

**Call**: `j = K.tyre(hub, 'Tyre', (0, 0, 0), 'Z', hub_diameter=40, width=14, tyre_diameter=50, flange=2.5)`

**You provide**: `hub`, a solid disc centred on the pivot, `width` thick; `child` is a new name for the tyre. The recipe cuts a channel and pegs in the hub.

**Key options**: `flange` 2 to 3; `rim_depth` 2.5 to 4; `pegs` 6; `tread` 0 or 24.

**Prints as**: separate; tyre in TPU, stretched over a flange; hub in PLA or PETG.

**Validation**: two samples (axis Z at the origin; axis -X at (37, -22, 14)): assembly, geometry and fit pass; mechanics passed, verified, 13 of 13 probes each. Without pegs the tyre spins and fails `unretained_part`.

## axle_clip

**Use for**: keeping a wheel on a stub axle with a collar at the axle end.

**Call**: `j = K.axle_clip(body, w, (40, 30, 14), '+X', width=10, control='wheel')`

**You provide**: the same `body`, `wheel`, pivot, axis and `width` as `captive_axle`.

**Key options**: `collar_overhang` 1.5 to 2.5; `collar_height` 2. `open_clip=True` adds a groove and a separate C-clip (two joint records).

**Prints as**: print-in-place, collar fused to the axle; PLA or PETG.

**Validation**: two-wheel sample: assembly, geometry and fit pass; mechanics passed, verified, 185 of 185 probes per wheel; one wheel at another pivot and axis passed (165 of 165). `open_clip=True`: the clip spins in its groove and fails `unretained_part`; not verifiable.
