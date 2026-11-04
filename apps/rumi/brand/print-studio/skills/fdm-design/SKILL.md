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
6. **Allow intended fits and motion.** Mating and moving parts need clearance or interference appropriate to the intended fit, material, orientation, and calibrated process. Do not assume nominally identical dimensions will fit. Use a small fit test when the result matters and calibration is unavailable.
7. **Design for intended use.** For functional parts, choose material, section thickness, connections, and orientation for expected loads and temperature exposure. Layer-dependent strength, shrinkage, and warping matter; successful slicing does not establish strength or dimensional accuracy.
