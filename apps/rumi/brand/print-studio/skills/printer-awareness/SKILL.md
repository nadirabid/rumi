---
name: printer-awareness
description: Retrieve printer identity, connectivity, live state, filament and machine-profile limits before answering printer questions or making printer-specific design and fit decisions.
---

# Printer awareness

Use observed printer facts for design constraints. A modeling request alone does not select a printer, nozzle mode, filament or build volume. Continue a visual draft when printer details are unavailable; leave print fit unverified.

## Retrieve the relevant facts

- Call `print_studio_status` for the configured printer, discovered devices, LAN reachability and `slicer.profiles.root`. A configured model is saved configuration; compare it with discovered identity before selecting a machine profile. If discovery cannot confirm it, label it configured rather than detected. Profile availability and setup `ready` do not establish that a particular job can print.
- Call `print_studio_progress` for live job state, temperatures, reported nozzle diameter, AMS trays and errors. Null, absent or incomplete fields mean unknown, not zero, empty or idle. Report when the reading was obtained; refresh live readings when answering a new status question or preparing a job. Older conversation results are historical.
- If the printer does not answer, say it is unreachable and its power state is unknown. A successful current report establishes that it is responding; failed discovery or a closed port cannot establish that it is powered off. Use `print-studio-setup` for missing configuration or rejected access. Do not repeatedly retry a failed probe without a relevant change.
- Read the applicable Bambu Studio machine profile under the returned `slicer.profiles.root` through the file/shell tools. Match the confirmed or explicitly selected model, nozzle diameter and single/dual-nozzle mode; installed profiles alone do not identify the active selection. Follow named `inherits` profiles and apply child and explicit job overrides. Inspect `printable_area`, `printable_height`, `bed_exclude_area`, nozzle-specific limits and applicable plate/process settings. Preserve the source paths and selected mode when reporting derived dimensions. If the selection or inheritance cannot be resolved, report the missing fact; ask only when it blocks the requested print decision.

Bambu Studio's documented CLI is for slicing and export, not a live-status command. Use the existing Print Studio tools for live telemetry; do not invent CLI flags or install a separate CLI to answer status questions. Keep access codes and tokens in the credential service, out of scripts, shell arguments and chat.

## Apply facts to the model

Pass `buildVolume` to `viewer_load` or `mesh_open` only from an applicable profile or dimensions explicitly supplied by the user. Name that source. Never substitute a familiar printer size, a test-print preset or an existing viewer box for the selected printer's limits. The viewer box is a rectangular envelope; it does not encode excluded areas or different nozzle reach. Check those separately and use the slicer for final placement validation. An inherited viewer box is not evidence of printer fit; omitting `buildVolume` retains an existing box, so disclose an unverified retained envelope rather than relying on it.

Do not scale or split a design to satisfy an assumed envelope. Separate the measured model dimensions from the printer constraints. A material preset describes slicing settings, not a loaded spool. Report AMS material/color/remaining values as printer-reported; unavailable remaining amounts, external-spool details and physical plate identity stay unknown. Tray IDs may repeat across AMS units in the current tool output; do not guess a physical slot or nozzle mapping from an ambiguous ID. Ask the user to identify the intended filament when that choice matters.

Checking status does not authorize heating, motion, filament loading, calibration or printing. Preserve the existing confirmation flow for sending a prepared print. Present the relevant facts and uncertainties in plain language rather than dumping raw telemetry.

## Tools and parameters

- `print_studio_status` takes no arguments. It returns `configured` (the saved printer model and serial), `devices` (discovered on the LAN), `reachable`, `lanAccessOk`, `nextSteps`, and `slicer.profiles.root`. Read `nextSteps` first and act on it; it names the one thing blocking setup.
- `print_studio_progress` takes no arguments. It returns live `temperatures` keyed by heater, `nozzleDiameter`, `jobs` with state and progress, `ams` trays with material, colour and remaining amount, and `errors`. Any field may be null when the printer did not report it.
- `viewer_load` and `mesh_open` accept `buildVolume` as a three-number array of millimetres. Supply it only from a resolved profile or an explicit user statement, and name the source when you report fit.
- The machine profile is a Bambu Studio JSON file under `slicer.profiles.root`. Read it with the file tools; `printable_area`, `printable_height`, `bed_exclude_area`, `nozzle_diameter` and `inherits` are the fields that decide fit.

## Worked examples

**"Is my printer on?"** Call `print_studio_status`, then `print_studio_progress`. If both answer, it is on and reachable — report the state with a timestamp. If the probe fails, say the printer is unreachable and its power state is unknown. Do not conclude it is switched off.

**"What filament is loaded?"** Call `print_studio_progress` and read `ams`. Report material and colour per tray, and say "the printer did not report a remaining amount" when that field is null. If two trays share an ID across AMS units, say the slot is ambiguous and ask which one they mean.

**"Will this fit my print bed?"** Read the machine profile for the confirmed model and nozzle, resolve `inherits`, and take the usable region from `printable_area` minus `bed_exclude_area`. Compare against the model's measured dimensions from `meshState`, not the viewer box. Report the dimension, the limit, and the margin. If the model is not selected, say fit is unverified.

**A request that must not use this skill.** "Make this bigger" is a modelling and edit request; it belongs to [blender-modeling](../blender-modeling/SKILL.md) and [mesh-edit-controls](../mesh-edit-controls/SKILL.md). Only retrieve printer facts when the answer depends on the machine — fit, feature size, clearance, material, or live state.
