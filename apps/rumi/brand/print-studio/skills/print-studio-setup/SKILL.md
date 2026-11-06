---
name: print-studio-setup
description: "Set up and diagnose Print Studio: Bambu Studio, H2D LAN mode, access code, and print readiness."
---

# Print Studio setup

Use this skill whenever a person asks to set up, fix, or check the 3D printer, or when
`print_studio_status` reports something missing. Call `print_studio_status` first and
work from its `nextSteps`; do not guess.

## What Print Studio needs

- **Bambu Studio** — the slicer for the H2D.
- **A printer on the same network** — Print Studio finds its IP address and serial
  number; the LAN access code is fetched after the adult signs in to Bambu.
- **A test slice** — a small cube, before anything is printed.

## If the slicer is missing

1. Tell the adult to install Bambu Studio from
   https://bambulab.com/en/download/studio
2. Open it once so it writes the H2D profiles.
3. Re-run `print_studio_status`; do not claim it is installed until the probe finds it.

Do not download or install applications yourself.

## Signing in does not require LAN mode

Print Studio talks to the printer's local MQTT and FTPS ports. Bambu Cloud sign-in is used only to retrieve the LAN access code; printing stays local. A printer reporting `DevConnect: cloud` can still accept local access after that sign-in. Only if the code is rejected should the adult enable **LAN Only Mode** on the printer, and **Developer Mode** if the firmware shows that switch.
Ask the adult to use the **Sign in with Bambu** button. Never ask them to paste account credentials into chat.

## If the printer is not configured

1. Print Studio finds the printer and its IP/serial automatically.
2. The adult signs in once with their Bambu account in **Plugins → Print Studio**;
   Print Studio fetches the printer's access code from the bound-device list. Never
   ask for the account password or the access code in chat.
3. Re-run `print_studio_status` and confirm the access code was accepted before
   proceeding.

If the printer is on a different network or the ports are blocked, say so and stop;
do not fall back to cloud printing.

## If the H2D profiles are missing

Open Bambu Studio once with the H2D selected so it writes its machine/process/filament
presets, then re-run `print_studio_status`. If Bambu Studio is too old for the H2D,
ask the adult to update it.

## Before any print

- Use `printer-awareness` to resolve the selected machine profile, nozzle mode and loaded filament. Do not infer these from installed presets.
- Call the current `meshState` context before saying what the preview shows. Load editable GLB or JavaScript models with `viewer_load`, or STL with `mesh_open`; pass only a verified build envelope. The viewer's rectangular box does not include every nozzle or exclusion constraint.
- Use `viewer_transform` for editable-model placement or `mesh_transform` for STL scene placement. Opening the same STL again adds a second copy.
- Follow `fdm-design` for geometry, bed attachment, supports and slicer validation. Preview checks do not establish print readiness.
- Ask the adult which loaded AMS filament to use.
- Never send a print without the adult confirming the prepared job.

## Reporting

Speak in plain language and name the one next step. Do not dump raw JSON at the person;
translate the status into "Bambu Studio is installed, the printer is not connected yet",
and so on.
