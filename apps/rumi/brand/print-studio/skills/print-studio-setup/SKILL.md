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

1. Tell the adult to press **Set up Bambu Studio** in **Plugins → Print Studio**.
2. Re-run `print_studio_status`; do not claim it is installed until the probe finds it.

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

The H2D profiles ship inside Bambu Studio. If the probe finds none, the installed
Bambu Studio is too old for the H2D: ask the adult to update it, then re-run
`print_studio_status`.

## Before any print

- Use `printer-awareness` to resolve the selected machine profile, nozzle mode and loaded filament. Do not infer these from installed presets.
- Call the current `meshState` context before saying what the preview shows. Load editable USD or JavaScript models with `viewer_load`, or STL with `mesh_open`; pass only a verified build envelope. The viewer's rectangular box does not include every nozzle or exclusion constraint.
- Use `viewer_transform` for editable-model placement or `mesh_transform` for STL scene placement. Opening the same STL again adds a second copy.
- Follow `fdm-design` for geometry, bed attachment, supports and slicer validation. Preview checks do not establish print readiness.
- Ask the adult which loaded AMS filament to use.
- Never send a print without the adult confirming the prepared job.

## Reporting

Speak in plain language and name the one next step. Do not dump raw JSON at the person;
translate the status into "Bambu Studio is installed, the printer is not connected yet",
and so on.

## Worked examples

**First run, nothing installed.** The person says "I want to print something." Call `print_studio_status`, read `nextSteps`, and report only the first step: "Bambu Studio isn't installed yet — press Set up Bambu Studio in Plugins → Print Studio, and I'll check again." Do not list every later step.

**Installed but no printer.** "Is the printer ready?" The probe finds Bambu Studio but no configured printer. Say: "Bambu Studio is installed. I can see the printer on your network but it isn't connected yet — sign in with Bambu once and I'll take it from there." Never ask for the access code or password in chat.

**Access code rejected.** The sign-in completed but local access fails. Say the code was rejected and offer the printer-side step: enable LAN Only Mode, and Developer Mode if the firmware shows that switch. Do not retry the same probe unchanged and do not fall back to cloud printing.

**Profiles too old.** The probe finds no H2D profiles. Say the installed Bambu Studio predates the H2D and ask the adult to update it, then re-check. Do not attempt to install or patch a slicer.

**A print request, not a setup request.** "Print this." Setup is already complete, so this is a job, not a repair. Follow the Before any print checks, and use [fdm-design](../fdm-design/SKILL.md) for the geometry side. Do not re-run installation steps.

## Checking a print job before it is sent

After the setup checks pass, the order that prevents mistakes is: confirm the printer is reachable, confirm the selected machine profile matches the physical machine, confirm the filament that will actually be used, then confirm the model dimensions fit the usable region. Only then prepare the job and ask for confirmation. A job prepared against an assumed printer or an assumed spool is the failure this sequence exists to stop.
