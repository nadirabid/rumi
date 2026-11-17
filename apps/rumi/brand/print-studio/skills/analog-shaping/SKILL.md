---
name: analog-shaping
description: Bind Rumi’s built-in bulge, bend, twist, taper, and planar-cut operations after mesh-edit-controls has selected a suitable deformation.
---

# Built-in mesh operations

Use [mesh-edit-controls](../mesh-edit-controls/SKILL.md) to establish the intended change, verify it, and manage preview, save, or cancel. Use [interactive-controls](../interactive-controls/SKILL.md) for widget declarations. Built-in operations preview the existing geometry and materials locally; do not rebuild Blender while someone drags.

## Select the region

Read `meshState` and the original Blender source. Supply the current model’s exact `path`, `revision`, and `url`, a short region label, and exact mesh names in `parts`. An empty parts list selects every mesh in the region. Use `viewer_highlight` to establish a deformation region; cuts use the automatic cut-plane guide instead.

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

Opening a cut clears prior Gaussian highlights and displays a continuous teal guide at the actual plane. A rendered cut receipt confirms the guide and controls. The guide disappears on freeze or close; other region highlights are rejected until the cut resolves. The viewer previews capped cross-sections; saving uses a Blender intersection that preserves cavity openings.

Open controls before applying the requested cut. To restore material below an already cut edge, use the matching earlier revision.

## Change an open edit

`meshState` contains the last released values. Cursor snapshots and measurements during an edit do not describe a trustworthy deformed selection. Close the edit before changing its region; open a fresh session for a new direction, operation, or region. Follow `mesh-edit-controls` to preserve wanted adjustments or discard a rejected preview. Close restores the saved original and clears the region highlight.

## Worked examples

**Bulge an eye.** "Make the eyes bulge out a bit." Read `meshState`, then open `operation: bulge` with a `center` at the eye region in model-local millimetres, `direction` as the outward normal, and `radii` covering the eye but stopping short of the socket rim. Expose `amount` only, max 1, starting at .5, with `limit` set to the smallest radius and no more. Check the rim has not moved and both eyes match.

**Bend a flat panel.** "Curve this sign panel." Use `operation: bend` with `direction` along the bend axis, a region spanning the panel, and `values` supplied for all six fields with unused ones at .5. Expose `amount` and expose `falloff` only if the person wants to tune how local the bend is. Verify the panel's mounting edge stayed planar.

**Taper a post.** "Make the post thinner at the top." `operation: taper` with a vertical region and radii reaching past the post's section. Amount below .5 narrows positively along the shaping direction; confirm which way the geometry moved before presenting. Check the base where it meets the plate has not thinned.

**A planar cut.** "Cut the bottom off flat." Use `operation: cut`, `direction: [0,0,1]` to keep the upper side, `center` at the proposed height, and radii at least as large as `limit` for every part that should share the edge. Amount .5 is the proposed height. Confirm the guide traces one continuous teal plane before the person commits.

**A request that needs a field instead.** "Squeeze the waist in but keep the ribs sharp." A bulge would round the ribs, and spread alone cannot keep an edge. Point to the displacement-field workflow in [mesh-edit-controls](../mesh-edit-controls/SKILL.md) rather than relabelling a bulge.

**Wrong region after opening.** The person says "not that part, the other one". Close first; the region cannot be changed on an open edit. Then reopen with a new region and the same operation and starting values.
