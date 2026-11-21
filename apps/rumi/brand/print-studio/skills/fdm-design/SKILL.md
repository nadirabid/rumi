---
name: fdm-design
description: "Design model geometry for FDM printing, including bed fit, support, feature size, clearances, and strength."
---

# Design for FDM printing

Preserve the requested design while considering these constraints. They guide design; this skill does not run checks or certify print readiness.

## Core constraints

1. **Represent the intended solid.** Use explicit units, finite coordinates, and nondegenerate triangles. Each intended solid should have a closed, consistently oriented surface without self-intersections or nonmanifold connections. Slicer repair is not evidence that the intended geometry was preserved.
2. **Fit the usable printing region.** Check the proposed placement against the active nozzle's reachable region and exclusions. Reserve room for required supports, adhesion aids, and clearance. On dual-nozzle printers, do not substitute the combined envelope for either nozzle's usable region.
3. **Keep intended connections physical.** Features that must form one piece need a real material connection or an explicit assembly joint. Mere contact at a point or edge is not a reliable bond. Separate parts and color regions are allowed; shell count alone is not a defect.
4. **Plan support and bed attachment.** Choose an orientation with a viable first layer or an adhesion/support strategy. Regions above it need sufficient support from previous layers, feasible bridging, or generated supports. Temporary supports need a removal or dissolution route. Face angle alone does not establish support; a flat base and support-free printing are not universal requirements.
5. **Preserve printable features.** Size walls, posts, holes, gaps, and text for the selected nozzle, layer height, material, and wall generator. Thin features may disappear or widen during slicing. No fixed wall thickness, bridge length, or overhang angle applies to every configuration.
6. **Allow intended fits and motion.** Mating and moving parts need clearance or interference appropriate to the intended fit, material, orientation, and calibrated process. Do not assume nominally identical dimensions will fit. Keep at least 0.3 mm between separate moving parts; tighter fits fuse or bind. Use a small fit test when the result matters and calibration is unavailable.
7. **Design for intended use.** For functional parts, choose material, section thickness, connections, and orientation for expected loads and temperature exposure. Layer-dependent strength, shrinkage, and warping matter; successful slicing does not establish strength or dimensional accuracy.

## Sequence the work

1. **Get printer facts.** Read [inspect-printer](../inspect-printer/SKILL.md) for the selected model, nozzle diameter, single or dual mode, build volume and excluded areas. Without a selected printer, continue a visual draft and leave fit, feature size and clearance unverified rather than guessing defaults.
2. **Inspect the geometry you have.** Read the current `meshState` and the model's source. Record overall dimensions, the thinnest walls and posts, hole diameters, gap sizes, and which parts must move or stay separate. These numbers decide every constraint below; do not assess them from the render alone.
3. **Choose an orientation.** Pick the resting face for the first layer, then check what the choice costs: supported area, bridge spans, layer direction against expected load, and whether surface finish matters on the face touching the bed. Orientation is a design decision made now, not a slicer setting fixed later.
4. **Apply the constraints that the facts and the geometry disagree on.** Each numbered constraint above names a decision. When a requested design cannot meet one, say which and why, and offer the smallest change that resolves it before building.
5. **Validate before claiming readiness.** Run the model checks described in [blender-modeling](../blender-modeling/SKILL.md#validate-a-finished-revision), then slice and inspect the preview for unsupported regions, thin walls and layer time. Report what was checked and what remains unverified.

## Report the checks before recommending a change

When a design is near a printer, material, fit, or load limit, record the applicable measurements below before recommending a geometry change.

Record each applicable measurement or mark it `unverified` and name the missing fact.

| Ask | Cell | Answer |
|---|---|---|
| What can the nozzle actually place? | nozzle diameter × layers | e.g. `0.4 mm → 0.8 mm min wall` |
| Smallest wall, post or stroke in the model | measured value vs that cell | e.g. `0.6 mm < 0.8 mm — too thin` |
| Smallest hole or gap | measured value vs nozzle | e.g. `3.0 mm — prints ~2.8 mm, drill after` |
| Every moving pair | measured gap vs 0.3 mm | e.g. `0.25 mm — binds, raise to 0.35` |
| Overhangs and bridges | angle or span that needs support | e.g. `55° overhang, 12 mm bridge` |
| Orientation chosen | what it costs | e.g. `flat — no support, 3 mm layer lines across load` |
| Overall size | vs usable bed region | e.g. `120×40×30 in a 220×220 bed` |
| Facet held in service | material and load assumption | e.g. `PLA, ~2 kg static — fine` |

Then answer in this order: what must change, why each change follows from its row, and which rows stayed `unverified`. Do not lead with a change whose row you have not filled.

If the slice drops a thin feature, measure its extrusion width and adjust the feature or explain the loss. For undersized holes, consider an enlarged or teardrop opening and a finishing pass. Address corner lift with bed adhesion, geometry, or a material change. Repair open or degenerate geometry in the source and run validation again. Check orientation before splitting a model that exceeds the bed, and preserve the requested scale unless the user asks to change it.
