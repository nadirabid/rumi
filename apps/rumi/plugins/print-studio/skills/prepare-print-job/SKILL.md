---
name: prepare-print-job
description: Prepare a model for an adult to review, slice, and print in Bambu Studio.
---

# Prepare print job

Use [Print Studio setup](../print-studio-setup/SKILL.md) if the printer or slicer is unavailable.

1. Use [Inspect Printer](../inspect-printer/SKILL.md) to confirm the printer is reachable and resolve the applicable machine profile, nozzle mode, and loaded filament. Ask the adult which loaded AMS filament to use.
2. Read the current `meshState` before describing the preview. Use `viewer_load` for editable USD or `mesh_open` for an STL import. Reopening an STL adds a copy. Use `viewer_transform` for editable USD placement or `mesh_transform` for STL placement.
3. Check the placement against the profile’s usable region, including nozzle reach and exclusions. In the 3D preview, choose **Arrange for printing**, then **Open plate in Bambu Studio**.
4. In Bambu Studio, have the adult select the confirmed printer and filament, slice the plate, and review layer coverage, supports, and bed attachment. Use [FDM design](../fdm-design/SKILL.md) for geometry decisions. The adult sends the job from Bambu Studio.
