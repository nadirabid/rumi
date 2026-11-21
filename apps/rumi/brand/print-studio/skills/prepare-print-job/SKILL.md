---
name: prepare-print-job
description: Check a model against the selected printer and filament, verify its slice and placement, and obtain adult confirmation before sending.
---

# Prepare print job

Use [Print Studio setup](../print-studio-setup/SKILL.md) if the printer or slicer is unavailable.

1. Use [Inspect Printer](../inspect-printer/SKILL.md) to confirm the printer is reachable and resolve the applicable machine profile, nozzle mode, and loaded filament. Ask the adult which loaded AMS filament to use.
2. Read the current `meshState` before describing the preview. Use `viewer_load` for editable USD or `mesh_open` for an STL import. Reopening an STL adds a copy. Use `viewer_transform` for editable USD placement or `mesh_transform` for STL placement.
3. Check the placement against the profile’s usable region, including nozzle reach and exclusions. Slice with the confirmed printer and filament settings. Inspect the slice for layer coverage, supports, and bed attachment using [FDM design](../fdm-design/SKILL.md) for geometry decisions.
4. Ask the adult to confirm the prepared job before sending it.
