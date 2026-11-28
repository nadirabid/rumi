---
name: built-in-mesh-operations
description: "Bind a live bulge, bend, twist, taper, or planar cut to a selected mesh region."
---

# Built-in mesh operations

Use [mesh-edit-controls](../mesh-edit-controls/SKILL.md) to establish the intended change, verify it, and manage preview, save, or cancel. Use [control-widgets](../control-widgets/SKILL.md) for widget declarations. Built-in operations preview the existing geometry and materials locally; do not rebuild the CAD script while someone drags.

## Select the region

Read `meshState` and the `build123d` CAD source. Supply the current model’s exact `path`, `revision`, and `url`, a short region label, and exact mesh names in `parts`. An empty parts list selects every mesh in the region. Use `viewer_highlight` to establish a deformation region; cuts use the automatic cut-plane guide instead.

`center` is model-local XYZ millimetres. The local frame has N = `direction`, U = world-up cross N, and V = N cross U; near a vertical N, world-up is Y instead of Z. `radii` are extents along U, V, N. Choose a region that excludes protected features. Influence is compact and zero outside this ellipsoid. The ellipsoid limits deformations, not cuts.

These operations do not implement extrusion, curved cuts, remeshing, or beveling. For other variations that preserve connectivity, follow the field workflow in `mesh-edit-controls`; do not relabel an unrelated operation.

## Deformation values

Supply all six `values` in 0..1, but expose only axes useful for this edit. Declare axis ranges as min 0 and max 1.

- Bulge uses `amount`, `angle`, `spread`, `peakX`, `peakY`, and `falloff`.
- Bend, twist, and taper use all except `angle`. Their `limit` does not set an angle range.
- Cut uses `amount`, `angle`, and `spread`; supply .5 for the unused values.

For deformations, amount .5 leaves the geometry unchanged; larger values deform positively and smaller values negatively. For bulge, `limit` is maximum displacement in millimetres, no greater than the smallest radius. Spread .5 gives the supplied extents; peakX and peakY .5 center the effect. Angle .5 points outward. Falloff ranges from broad to concentrated; .35 is a useful starting value.

Start with zero deformation unless the person requested an initial change. Define reset values explicitly: amount, spread, angle, and peak normally reset to .5; choose falloff’s reset to match the intended starting profile. Reset affects only that control’s axes.

## Planar cuts

For a bottom cut, use `operation: cut`, `direction: [0,0,1]` to retain the upper side, and `center` at the proposed height. Amount moves the plane by `(amount*2-1)*limit` along direction; .5 is the proposed height. Angle tilts along V and spread leans along U, each spanning -60 to +60 degrees with .5 untilted. Positive tilt raises the plane toward positive V; positive lean raises it toward positive U. Set every radius at least as large as limit; radii do not clip the cut footprint. Select all parts that should share the edge.

Opening a cut clears prior mesh overlays and displays a continuous teal guide at the actual plane. A rendered cut receipt confirms the guide and controls. The guide disappears on freeze or close; other region highlights are rejected until the cut resolves. The viewer previews capped cross-sections; saving uses `helper["cut_solid"](part, recipe)` in `build123d` for an exact B-Rep half-space cut that preserves cavity openings.

Open controls before applying the requested cut. To restore material below an already cut edge, use the matching earlier revision.

## Change an open edit

`meshState` contains the last released values. Cursor snapshots and measurements during an edit do not describe a trustworthy deformed selection. Close the edit before changing its region; open a fresh session for a new direction, operation, or region. Follow `mesh-edit-controls` to preserve wanted adjustments or discard a rejected preview. Close restores the saved original and clears the region highlight.
