---
name: fdm-design
description: Apply FDM design constraints when creating or modifying meshes intended for physical printing. Use during design, before slicer preparation; the modeling method remains the agent's choice.
---

# Design for FDM printing

Preserve the requested design while considering these constraints. They guide design; this skill does not run checks or certify print readiness.

Use `printer-awareness` to obtain the selected printer, nozzle and material facts before applying printer-specific constraints.

## Core constraints

1. **Represent the intended solid.** Use explicit units, finite coordinates, and nondegenerate triangles. Each intended solid should have a closed, consistently oriented surface without self-intersections or nonmanifold connections. Slicer repair is not evidence that the intended geometry was preserved.
2. **Fit the usable printing region.** Check the proposed placement against the active nozzle's reachable region and exclusions. Reserve room for required supports, adhesion aids, and clearance. On dual-nozzle printers, do not substitute the combined envelope for either nozzle's usable region.
3. **Keep intended connections physical.** Features that must form one piece need a real material connection or an explicit assembly joint. Mere contact at a point or edge is not a reliable bond. Separate parts and color regions are allowed; shell count alone is not a defect.
4. **Plan support and bed attachment.** Choose an orientation with a viable first layer or an adhesion/support strategy. Regions above it need sufficient support from previous layers, feasible bridging, or generated supports. Temporary supports need a removal or dissolution route. Face angle alone does not establish support; a flat base and support-free printing are not universal requirements.
5. **Preserve printable features.** Size walls, posts, holes, gaps, and text for the selected nozzle, layer height, material, and wall generator. Thin features may disappear or widen during slicing. No fixed wall thickness, bridge length, or overhang angle applies to every configuration.
6. **Allow intended fits and motion.** Mating and moving parts need clearance or interference appropriate to the intended fit, material, orientation, and calibrated process. Do not assume nominally identical dimensions will fit. Keep at least 0.3 mm between separate moving parts; tighter fits fuse or bind. Use a small fit test when the result matters and calibration is unavailable.
7. **Design for intended use.** For functional parts, choose material, section thickness, connections, and orientation for expected loads and temperature exposure. Layer-dependent strength, shrinkage, and warping matter; successful slicing does not establish strength or dimensional accuracy.

## Sequence the work

Constraints only help when they arrive before the geometry is fixed. Work in this order.

1. **Get printer facts.** Read [printer-awareness](../printer-awareness/SKILL.md) for the selected model, nozzle diameter, single or dual mode, build volume and excluded areas. Without a selected printer, continue a visual draft and leave fit, feature size and clearance unverified rather than guessing defaults.
2. **Inspect the geometry you have.** Read the current `meshState` and the model's source. Record overall dimensions, the thinnest walls and posts, hole diameters, gap sizes, and which parts must move or stay separate. These numbers decide every constraint below; do not assess them from the render alone.
3. **Choose an orientation.** Pick the resting face for the first layer, then check what the choice costs: supported area, bridge spans, layer direction against expected load, and whether surface finish matters on the face touching the bed. Orientation is a design decision made now, not a slicer setting fixed later.
4. **Apply the constraints that the facts and the geometry disagree on.** Each numbered constraint above names a decision. When a requested design cannot meet one, say which and why, and offer the smallest change that resolves it before building.
5. **Validate before claiming readiness.** Run the model checks described in [blender-modeling](../blender-modeling/SKILL.md#validate-a-finished-revision), then slice and inspect the preview for unsupported regions, thin walls and layer time. Report what was checked and what remains unverified.

## Worked examples

**A wheel that must spin.** The person asks for a cart with four turning wheels on a 0.4 mm nozzle. Constraint 6 sets 0.3 mm between the wheel bore and the axle, and constraint 3 means the axle is a separate part rather than a fused lump. Orientation puts the wheel disc flat on the bed so the bore is round, not ovalised by layer stair-stepping. The joint kit in [joints](../joints/SKILL.md) already carries these clearances; read it before hand-modelling the axle.

**A bracket that must hold.** The person asks for a shelf bracket "as thin as possible". Constraint 7 makes the load the deciding fact, not the render. Lay it so layer lines run along the bending span, since a part loaded across layer boundaries splits sooner. State the assumption you used for load and offer a thicker section if it is heavy.

**Text on a lid.** The person asks for their name embossed on a lid in the same colour. Constraint 5 makes the stroke width the question: letters narrower than about two extrusion widths on the selected nozzle may vanish or blur. Either raise the text to a relief height that survives, or widen the strokes, and say which you did.

**A part that will not fit the bed.** The person asks for a 300 mm rail on a 256 mm bed. Constraint 2 rules out printing it as one piece. Offer splitting into parts with a connection that constraint 3 can justify — a dovetail or a pinned joint, not a butt seam — or a different orientation if the diagonal fits. Do not scale it down without being asked.

## When a constraint cannot be met

These are the recurring failures with their causes and the action to take.

| Symptom | Cause | What to do |
|---|---|---|
| Slicer reports open or nonmanifold edges | Geometry was not a closed solid, or booleans left stray faces | Repair the source geometry and re-check; do not accept slicer auto-repair as proof |
| Thin wall or post vanishes in the preview | Feature thinner than the nozzle can deposit | Thicken to at least two extrusion widths, or remove the feature and say so |
| Small hole closes up | Hole smaller than the nozzle, or bridging across the top | Enlarge the hole, or model it as a teardrop and drill after printing |
| Moving part fuses or binds | Clearance below the calibrated process tolerance | Raise clearance to 0.3 mm or more, re-check, and consider a fit test coupon |
| Part warps or lifts at a corner | Large flat area, sharp corner, or uneven cooling | Add a brim, round the corner, or reconsider material; report that the cause is process, not geometry |
| Two parts meant to be one separate | Only touching at a point or edge | Add a real overlap, a connector, or an explicit assembly joint |
| Long unsupported span droops | Bridge span beyond the material's feasible length | Reorient, add supports, or split the span with a rib |
| Model will not validate after a change | A boolean left intersecting triangles or a degenerate face | Rerun the operation with cleaned inputs, or repair the affected region; a new defect is not excused by an older one |

Report a constraint you could not satisfy, and why, rather than silently certifying the result. A model that slices is not a model that fits, holds or prints.
