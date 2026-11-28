All fastener recipes in `cad/joints/fasteners.py` build **separate-print** connectors in `build123d` B-Rep with exact clearances, lead-in chamfers, and v2 disassembly `actions`.

## snap_hook

**Use for**: a cantilever clip that clicks through a chamfered window in a wall and cannot be pulled back out.

**Call**: `res = K.snap_hook(panel, clip, (0, 0, 0), '+X', '+Z', width=8, wall=3)`

**You provide**: `panel` with a flat wall `wall` thick at the pivot, at least 22 × 12 mm; `clip`, a block 9 mm behind that face, at least 22 × 12 mm. `axis` is the push direction, `hook_side` the way the hook points.

**Key options**: `width` 6 to 12; `arm_thickness` 1.6 to 2.5; `hook_height` 1.2 to 2.0; `lead_in` 0.7; `clearance` 0.35.

**Prints & assembles**: separate; clip with arm flat on bed; PETG or nylon (PLA arms can snap). Declares `fixed` (`retainer='snap'`) + `step_snap`.

## snap_lid

**Use for**: a round lid with anti-spin keys that snaps onto an annular beaded container rim.

**Call**: `res = K.snap_lid(tub, lid, (0, 0, 30), '+Z', radius=20)`

**You provide**: `tub`, a round wall of outer `radius` with flat rim at the pivot; `lid`, a plate wider than `radius + 2.5` mm with underside `seat` (0.3 mm) above the rim.

**Key options**: `bead` 0.6 to 1.0; `skirt_wall` 2.2; `keys` 2 (keeps lid from spinning); `clearance` 0.35.

**Prints & assembles**: tub upright, lid upside down on its flat top; PETG or PP. Declares `fixed` (`retainer='snap'`) + `step_snap`.

## bayonet_lock

**Use for**: a twist-lock cap or plug locked by a partial turn; modelled locked, declared `fixed` with `retainer='bayonet'`.

**Call**: `res = K.bayonet_lock(socket, cap, (0, 0, 22), '+Z', bore_diameter=20)`

**You provide**: `socket`, a solid block at least 30 mm across and 16 mm deep with flat mouth at the pivot; `cap`, a disc wider than the stem with underside `gap` (0.4 mm) above the mouth.

**Key options**: `bore_diameter` 16 to 30; `lugs` 2 to 4; `turn` 45; `lip` 4.0; `clearance` 0.35.

**Prints & assembles**: separate, both flat; PLA or PETG. Declares `fixed` (`retainer='bayonet'`, lock `axis`) + `step_twist` (twist then pull out). Bullet runs full pull-out, shear, and tilt retention probes while allowing intentional hand unscrewing about the lock axis.

## bolt_nut

**Use for**: a real analytic B-Rep helical thread on a printed stud with a matching internally threaded nut or cap.

**Call**: `res = K.bolt_nut(plate, nut, (0, 0, 0), '+Z', diameter=12, pitch=2.5, length=18, seat=2.0)`

**You provide**: `plate` with a flat face at the pivot and solid material under it; `nut`, a hex block or cap wider than the thread with flat near face at `seat`.

**Key options**: `diameter` 8 to 30; `pitch` 2.0 to 4.0; `length` at least `seat + 2 * pitch`; `clearance` 0.35.

**Prints & assembles**: stud vertical, 0.12 to 0.16 mm layer height; PLA or PETG. Declares `fixed` (`retainer='threaded'`, lock `axis`) + helical `step_twist(..., pitch_mm=pitch)` unscrewing action.

## tab_slot

**Use for**: a standing wall that clicks into chamfered slots in a base plate via split barbed tabs.

**Call**: `res = K.tab_slot(base, wall, (0, 0, 4), '+Z', '+X', tabs=(-12, 12))`

**You provide**: `base` of thickness `plate` (4 mm) with top face at the pivot; `wall` with flat foot `gap` (0.35 mm) above it, at least 3 mm thick. `across` runs along the foot.

**Key options**: `tab_width` 8 to 14; `tab_thickness` 2.5 to 4; `barb` 0.8 to 1.2; `clearance` 0.35.

**Prints & assembles**: base and wall both print flat; PETG recommended for tab flex. Declares `fixed` (`retainer='snap'`) + `step_snap`.

## press_pegs

**Use for**: locating two parts with chamfered push-fit pegs in blind holes (friction-held; unverified by Bullet rigid retention).

**Call**: `res = K.press_pegs(base, cover, [(-8, 0, 0), (8, 0, 0)], '+Z', diameter=5, length=8)`

**Key options**: `diameter` 3 to 10; `length` 6 to 12; `clearance` 0.15; `pegs_on` `'parent'` or `'child'`.

**Prints & validation**: separate; PLA or PETG. Declares `fixed` (`retainer='friction'`), emitting `retainer_unverified_friction` — inform the user that friction holds it rather than positive capture.

## dogbone_key

**Use for**: tying two flat plates side by side with a separate drop-in dog-bone key (separate-print only).

**Call**: `res = K.dogbone_key(left, right, (0, 0, 9), '+X', '+Z')`

**You provide**: plates at least 9 mm thick with a seam (`recess` 0.35 mm) along the pivot; `axis` crosses the seam, `lift` leaves the top face.

**Key options**: `length` 16 to 30; `bulb_diameter` 8 to 14; `neck_width` 4 to 6; `height` 4.5.

**Prints & validation**: all 3 parts print flat; PLA or PETG. Key drops in from the open top (`retainer='friction'`, unverified for upward lift-out).

## insert_boss

**Use for**: clamping two parts with a machine screw into a brass heat-set insert (metal hardware not modelled).

**Call**: `res = K.insert_boss(block, cover, [(-8, -8, 0), (8, 8, 0)], '+Z', screw='M3')`

**Key options**: `screw` `'M2'` to `'M5'`; `insert_diameter`, `insert_length` from datasheet; `melt` 0.4.

**Prints & validation**: separate; buy brass inserts and screws. Declares `fixed` (`retainer='friction'`); inform the user hardware holds it.

## magnet_pockets

**Use for**: two parts held by embedded disc magnets (with mandatory vent holes) plus optional keyed locating pins.

**Call**: `res = K.magnet_pockets(base, cover, [(-5.5, 0, 0), (5.5, 0, 0)], '+Z', pins=[(-16, 0, 0), (16, 0, 0)])`

**Key options**: `magnet_diameter` 4 to 10; `magnet_thickness` 1 to 4; `skin` 0.6; `vent` 1.0 (sealed cavities are refused).

**Prints & validation**: pause print at cavity top to insert magnets with opposing poles facing. Declares `fixed` (`retainer='friction'`); inform the user magnets hold it.
