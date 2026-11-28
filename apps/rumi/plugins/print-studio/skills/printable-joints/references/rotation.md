All rotational recipes in `cad/joints/hinges.py` are **separate-print** assemblies (except the one-piece flexible `living_hinge` in `mechanisms.py`). Every multi-part hinge, ball socket, turntable, and bearing prints as separate flat parts and assembles afterward.

## pin_hinge (alias `barrel_hinge`)

**Use for**: a door, lid, or flap on a strong separate-print knuckle hinge (4 separate parts: parent outer knuckles, child center knuckle, keyed removable pin, and quarter-turn bayonet end cap).

**Call**: `res = K.pin_hinge(body, door, (0, 0, 0), 'Z', '-X', '+Y', length=32, knuckle_diameter=13, pin_diameter=6.5, limits=(0, 110), control='Door')`

**You provide**: both parts reaching within `reach` mm of the hinge line on their respective sides (`parent_side`, `child_side`), with clear space around the knuckle barrel.

**Key options**: `length` 22 to 50; `knuckle_diameter` 11 to 18; `pin_diameter` 5.5 to 9; `pin_clearance` 0.35; `turn` 90; `limits`.

**Prints & assembles**: all four pieces print separately (pin lies flat on its key flat for shear strength). Align knuckles, slide keyed pin through, twist-lock bayonet cap 90°. Declares `revolute` door joint + `fixed` pin/cap joints (`retainer='bayonet'` on cap) and automatic disassembly actions. Records `barrel-hinge` badge evidence.

## snap_hinge

**Use for**: a lightweight 2-part separate-print leaf that snaps sideways onto a cylindrical post held between two arms on the parent.

**Call**: `res = K.snap_hinge(body, door, (0, 0, 0), 'Z', '-X', '+Y', length=24, post_diameter=6, limits=(-90, 90), control='Flap')`

**You provide**: `parent` reaching the hinge arms on `parent_side`; `child` reaching the C-clip leaf on `child_side`, clear of the parent's sweep.

**Key options**: `length` 18 to 40; `post_diameter` 5 to 9; `radial_clearance` 0.42; `opening_deg` 95; `limits`.

**Prints & assembles**: 2 separate parts; PETG recommended for compliant snap clip. Snaps radially onto the post (`step_snap` disassembly action).

## living_hinge

**Use for**: a flexing fold between two panels in one printed part (PP, PETG, or TPU only; lives in `cad/joints/mechanisms.py`).

**Call**: `hinge = K.living_hinge('FoldingLid', (0, 0, 0), 'Y', across='X', panel_width=18, panel_thickness=3, length=30)`

**You provide**: nothing. Returns one `CadPart` with `living-hinge` badge evidence and no rigid joint. Publish as a plain part (`K.publish(dir, root=hinge)`).

**Key options**: `web_thickness` 0.4 to 0.8 (two to four layers); `web_length` 1.5 to 3; `panel_thickness` 2 to 4; `length`.

**Prints as**: one part flat on the bed so layers run across the web. PLA cracks after a few folds.

## ball_socket

**Use for**: a 2-part tilting head, lamp joint, or swivel arm where a ball stem snaps into a slotted compliant socket.

**Call**: `res = K.ball_socket(base, arm, (0, 0, 0), 'Z', ball_diameter=14, stem_length=16, limits=(-20, 20), control='Head tilt')`

**You provide**: `parent` with solid material under the socket; `child` reaching the stem tip `stem_length` along `axis`.

**Key options**: `ball_diameter` 12 to 20; `wall` 2.6; `clearance` 0.36; `keyed` True (keyed tilt axis for Bullet revolute verification); `slits`; `limits` up to `(-30, 30)`.

**Prints & assembles**: 2 separate parts; PETG recommended for compliant slotted petals. Ball snaps straight into the socket (`step_snap` disassembly action).

## turntable

**Use for**: a platter that spins smoothly on a bayonet post, retained by a separate quarter-turn center hub cap (3 separate parts: base+post, platter, cap).

**Call**: `plate = K.turntable_plate('Platter', (0, 0, 0), 'Z', diameter=40, thickness=5); res = K.turntable(base, plate, (0, 0, 0), 'Z', thickness=5, control='Turntable')`

**You provide**: `base` with a flat face at the pivot; `plate` from `turntable_plate` (or any disc spanning the platter thickness).

**Key options**: `thickness` 4 to 8; `post_diameter` 8 to 16; `cap_overhang` 3.5; `radial_clearance` 0.4; `turn` 90; `limits`.

**Prints & assembles**: all three parts print flat with zero supports; PLA or PETG. Drop platter on post, twist-lock center cap 90°.

## bearing

**Use for**: a 3-part separate-print journal bearing (bored housing, flanged rotor, and keyed snap retainer cap).

**Call**: `res = K.bearing(block, disc, (0, 0, 0), 'Z', hub_diameter=12, housing_thickness=8.0, control='Knob')`

**You provide**: `parent` housing spanning `housing_thickness` centred on the pivot; `child` disc seated beyond the rotor top face.

**Key options**: `hub_diameter` 10 to 24; `flange_overhang` 3.0; `housing_thickness` 6 to 12; `radial_clearance` 0.4; `barb` 0.95; `limits`.

**Prints & assembles**: all three parts print flat; PLA or PETG. Insert rotor through housing bore from one side and snap retainer cap onto the rotor stem from the other (`step_snap` + `step_translate`).
