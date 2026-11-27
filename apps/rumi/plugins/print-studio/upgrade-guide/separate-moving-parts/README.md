---
kind: upgrade-guide
description: Moving models must be redesigned for separate printing before publishing, validation or print preparation.
---

# Separate printing for moving parts

English | [中文](README.zh.md)

## Change

Rumi requires moving physical parts to print separately and assemble afterward. Existing USD and Blender originals remain readable for inspection and movement preview. Publishing and print preparation reject moving assemblies declared `print-in-place`; validation reports `separate_printing_required`. Earlier acceptance does not carry over to the new validation policy. Missing removal paths produce `assembly_path_required` and prevent acceptance even when motion probes pass. Static one-part models are unaffected.

`K.robot` and `K.publish` require explicit `mode='separate'` for moving assemblies. Omitting the mode no longer selects printed-assembled manufacture. Captive recipe examples are legacy geometry references, not supported separate-print designs. A `separate` declaration does not establish assembly feasibility.

## Migration

1. Preserve the existing model and revisions. Review each axle, hinge, slider and retainer for an insertion path and practical assembly order; redesign captive connections with accessible pins, caps or other suitable features. Keep every requested movement and range.
2. Update the project's `source/` script to publish with `mode='separate'`. For a custom USD callback, explicitly set `rumi:manufacturingMode` to `separate`. Do not change the label without reviewing the geometry.
3. Publish a new revision in the same model directory. Read `RUMI_CHECKS`, resolve blocking findings, supply removal paths for every nonroot part through `K.publish(..., steps=[...])` or `rumi:disassembly`, then run `validation_mechanics` and `validation_accept` for the new fingerprint. Missing or unsupported assembly evidence stays unverified; motion probes alone do not establish assembly feasibility.
4. Open **Arrange for printing**, review the individually placed pieces, and save the new layout. Review materials, supports and slicing in Bambu Studio before printing.
