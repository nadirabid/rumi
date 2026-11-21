---
name: name-model-regions
description: "Create or refresh persistent hover labels for an editable USD mesh revision."
---

# Name model regions

Inspect the actual current USD geometry and its source. Create or update `model.regions.json` on every publish. Save it beside `model.usda`, using the file's SHA-256 as `sourceHash`. Set `remainder` to the name of the main surface left after distinguishing the meaningful features. Set `regions` to an ordered array of objects with lowercase hyphenated `id`, short `name`, and `boxes`. Each box is `[minX, minY, minZ, maxX, maxY, maxZ]` in saved model-local millimetres before viewer placement. Use up to 96 regions and up to 16 boxes per region. The first region whose box contains the visible surface point supplies the label. Place small details before their larger features and use several boxes when a feature curves or changes direction. Verify that neighboring features receive their own names from multiple views.

Hover shows the saved feature name immediately. Clicking the surface pins its name, and activating the pinned label attaches it to the next request. Names should be familiar enough to reuse, with specific terms such as “tail base” and “inner bend” where the geometry supports them.
