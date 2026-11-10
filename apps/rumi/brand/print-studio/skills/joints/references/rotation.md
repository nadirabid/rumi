## barrel_hinge

**Use for**: a door or lid on a pin hinge, printed assembled.

**Call**: `K.barrel_hinge(body, door, (0, 0, 0), 'Z', '-X', '+Y', length=20, reach=14, limits=(-90, 0))`

**You provide**: both parts, each reaching to within `reach` mm of the hinge line on its side (default knuckle radius + 3), with nothing else within the knuckle radius + 0.3 of the line.

**Key options**: `length` 14 to 40; `knuckle_diameter` 10 to 16; `pin_diameter` 3 to 6; `pin_clearance` 0.5 to 0.8; `limits`.

**Prints as**: print-in-place, pin fused to the parent, hinge axis vertical or flat; PLA or PETG.

**Validation**: sample with a vertical axis: assembly, geometry and fit pass (overhang warnings only). Mechanics fail: 4 probes pass, 1 retention probe reads 0.39 mm penetration at both the 0.15 and the 0.3 limit. Rest passes.

## clip_hinge

**Use for**: a leaf that swings on a round post held out from the parent by two arms.

**Call**: `K.clip_hinge(body, door, (0, 0, 0), 'Z', '-X', '+Y', reach=14, limits=(-90, 0))`

**You provide**: the parent reaching within `reach` mm (default 9.7) of the axis on `parent_side`; the child reaching the same distance on `child_side`, within +-(length/2 - 0.4) of the pivot along the axis, clear of the parent's sweep. The two sides must differ.

**Key options**: `length` 18 to 40; `post_diameter` 5 to 10; `radial_clearance` 0.3 to 0.7; `opening_deg` 70 to 100 (the C opening must be narrower than the post).

**Prints as**: print-in-place, post fused to the parent, axis vertical; PLA or PETG. The C opening only retains by shape.

**Validation**: sample: assembly, geometry and fit pass (overhang and thin-face warnings only). Mechanics fail: 4 probes pass, 1 retention probe reads 0.177 mm penetration at the 0.15 limit; at MAXPEN=0.3 a movement probe at -25 degrees reads 0.34 mm. Not verified.

## living_hinge

**Use for**: a flexing fold between two panels in one printed part (PP, PETG or TPU only).

**Call**: `hinge = K.living_hinge('FoldingLid', (0, 0, 0), 'Y', across='X', panel_width=18, panel_thickness=3, length=30)`

**You provide**: nothing. It returns one part and no joint. Publish it as a plain part (`K.publish(dir, hinge, [])`). Rumi cannot check or animate it as a movable assembly.

**Key options**: `web_thickness` 0.4 to 0.8 (two to four layers); `web_length` 1.5 to 3; `panel_thickness` 2 to 4; `length`.

**Prints as**: one part flat, web face on the bed, so layers run across the web. PLA cracks after a few folds. Folds toward the grooved side (the +axis x across side), about 90 degrees.

**Validation**: sample: assembly, geometry and fit pass (overhang and thin-face warnings only; the 0.5 mm web is thin by design). The mechanics stage has nothing to test and errors on a one-part model.

## ball_socket

**Use for**: a tilting joint such as a lamp head or a swivel arm.

**Call**: `K.ball_socket(base, arm, (0, 0, 0), 'Z', ball_diameter=12, stem_length=14, limits=(-20, 20))`

**You provide**: the parent with material reaching about 8.9 mm from the pivot on the side away from `axis`; the child reaching the stem tip, `stem_length` along `axis`.

**Key options**: `ball_diameter` 10 to 20; `stem_length` 10 to 30; `keyed` (default True: blade stem in a slot, so only the tilt about `tilt_axis` is free); `limits` up to +-30. `keyed=False` gives a round stem and a true swivel, `slits=N` flexes the shell. The checker supports only revolute joints and reports the free swivel as unretained.

**Prints as**: print-in-place, socket axis vertical, no slits; overhangs inside the socket.

**Validation**: sample: assembly, geometry and fit pass (overhang and thin-face warnings only). Mechanics fail: 7 probes pass, 1 retention probe reads 0.27 mm penetration at the 0.15 limit, 0.35 mm at MAXPEN=0.3.

## turntable

**Use for**: a platter that spins on a post, such as a display stand.

**Call**: `plate = K.turntable_plate('Platter', (0, 0, 0), 'Z', diameter=40, thickness=4); K.turntable(base, plate, (0, 0, 0), 'Z', thickness=4)`

**You provide**: a parent whose flat face holds the pivot (the recipe adds a post and shoulder) and a platter from `turntable_plate`, or any disc spanning 1.4 to 5.4 mm along the axis.

**Key options**: `thickness` 3 to 8; `post_diameter` 8 to 16; `head_overhang` 2.5 to 5; `radial_clearance` 0.5 to 0.8; `limits`.

**Prints as**: print-in-place, flat on the bed; the flange head holds the platter, no cap.

**Validation**: sample: assembly, geometry and fit pass (overhang warnings only). Mechanics pass, verified: 165 of 165 probes at the 0.15 limit. A second sample at pivot (37, -22, 14), axis Y, also passes all 165.

## bearing

**Use for**: a part that spins on a plain captive bearing, such as a wheel hub or knob.

**Call**: `K.bearing(block, disc, (0, 0, 0), 'Z')`

**You provide**: a parent solid across the bearing thickness (8.8 mm with defaults) centred on the pivot; a child whose underside lies 1 to 3 mm beyond the top face, so the 4 mm stem fuses into it.

**Key options**: `hub_diameter` 10 to 30; `flange_overhang` 2 to 5; `lip_height` 2 to 6; `radial_clearance` 0.4 to 0.8. It is a sliding journal bearing; rolling balls would be separate parts the checker cannot verify, so none are offered.

**Prints as**: print-in-place, axis vertical; the spool flanges trap the lip cut into the parent.

**Validation**: sample: assembly, geometry and fit pass (overhang warnings only). Mechanics pass, verified: 165 of 165 probes at the 0.15 limit. A second sample at pivot (37, -22, 14), axis -X, also passes all 165.
