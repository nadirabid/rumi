All wheel and axle recipes in `cad/joints/wheels.py` are **separate-print** assemblies. Every part prints flat on the bed and assembles afterward without print-in-place captivity.

## wheel

**Use for**: a flat-printable wheel blank that `bayonet_axle` or `snap_axle` mounts; make it first.

**Call**: `w = K.wheel('FrontLeftWheel', (-40, 44, 14), '-X', diameter=30, width=10, tread=12)`

**You provide**: the pivot on the body's side face and the axis pointing away from the body. The disc's inner face sits `standoff + end_play` (1.35 mm default) off the pivot, with chamfered rim edges.

**Key options**: `diameter` 20 to 60; `width` 8 to 14; `tread` 0 to 16 ribs; `end_play` 0.35; `standoff` 1.0; `chamfer_size` 0.5.

**Prints as**: flat on the bed (axis vertical); PLA or PETG.

## bayonet_axle

**Use for**: a wheel or roller spinning on a smooth stub axle, retained by a separate quarter-turn twist-lock hub cap (3 separate parts: body+axle, wheel, cap).

**Call**: `res = K.bayonet_axle(body, w, (-40, 44, 14), '-X', width=10, axle_diameter=8, control='front left wheel')`

**You provide**: a solid `body` under the pivot; a `wheel` blank made at the same pivot, axis, and `width`.

**Key options**: `axle_diameter` 6 to 12; `clearance` 0.35; `end_play` 0.35; `cap_diameter`; `turn` 90; `recess` `None` (default: counterbores the outer face when `width >= 8` and hub radius clears the wall so the cap sits compactly with less cantilever leverage, automatically falling back to external on thin/narrow rotors; pass `True` to require a counterbore or `False` for an external cap); `limits` `(-180, 180)`.

**Prints & assembles**: body upright, wheel flat, bayonet cap flat on its outer face; PLA or PETG. Slide wheel onto axle, push cap on, twist 90° to lock. Declares `revolute` wheel joint + `fixed` (`retainer='bayonet'`) cap joint and automatic `step_twist` + `step_translate` disassembly actions. Records `wheel-and-axle` badge evidence.

## snap_axle

**Use for**: a 2-part wheel mounting where a split cantilevered barbed stub axle snaps through a counterbored wheel hub (no separate cap needed).

**Call**: `res = K.snap_axle(body, w, (-40, 44, 14), '-X', width=10, axle_diameter=8, barb=1.0, control='front left wheel')`

**You provide**: a solid `body` under the pivot; a `wheel` blank at the same pivot, axis, and `width`.

**Key options**: `axle_diameter` 6 to 10; `barb` 0.8 to 1.2; `clearance` 0.35; `recess` True; `limits` `(-180, 180)`.

**Prints & assembles**: body + wheel separate; PETG recommended for compliant snap fingers (PLA works for light assembly). Declares `revolute` joint + `step_snap` disassembly action. Records `wheel-and-axle` badge evidence.

## through_axle

**Use for**: two wheels turning together on one removable double-D through-axle passing through the body, retained by a keyed double-D snap cap (4 separate parts: body, axle with integral left wheel `.axle`, keyed right wheel `.wheel_right`, and keyed snap cap `.cap`).

**Call**: `res = K.through_axle(body, 'RearAxle', (0, -22, 14), 'X', body_width=40, wheel_diameter=30, wheel_width=8, tread=10)`

**You provide**: a solid `body` whose two side faces are `body_width` apart, centred on the pivot along the axis.

**Key options**: `axle_diameter` 7 to 12 (8.5 default); `wheel_diameter` 20 to 60; `wheel_width` 6 to 14; `tread`; `limits`.

**Prints & assembles**: axle/left-wheel unit, keyed right wheel, and keyed double-D snap cap print flat separately (`retainer='snap'`, full 6-DOF, cannot unscrew while rolling). Insert axle through body bore, slide keyed right wheel onto the D-end, and snap the cap on. Records `wheel-and-axle` badge evidence.

## tyre

**Use for**: a separate soft TPU tyre seated in a keyed rim channel on a rigid hub (2 parts).

**Call**: `res = K.tyre(hub, 'Tyre', (0, 0, 0), 'Z', hub_diameter=40, width=14, tyre_diameter=50, flange=2.0)`

**You provide**: `hub`, a solid disc centred on the pivot, `width` thick; `child` is a new name for the tyre. The recipe cuts a rim channel and anti-spin pegs into the hub.

**Key options**: `flange` 2.0 to 3.0; `rim_depth` 2.0 to 4.0; `pegs` 6; `tread` 0 or 20; `gap` 0.3.

**Prints & assembles**: hub in PLA or PETG; tyre in TPU, stretched over the flange onto the locating pegs. Declares `fixed` (`retainer='snap'`) joint + `step_snap` disassembly action.
