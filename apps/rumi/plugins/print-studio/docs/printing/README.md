# Printers and print layout

English | [中文](README.zh.md)

Use the Print Studio card under **Plugins → Built-in plugin settings** to check Bambu Studio, H2D profiles, and LAN printer discovery. The host discovers printers over SSDP. Signing in retrieves the bound printer’s access code for monitoring. See the [setup skill](../../skills/print-studio-setup/SKILL.md) and [printer inspection skill](../../skills/inspect-printer/SKILL.md).

Printer IP and serial are stored in `$DSH_HOME/print-studio/printer.json` (owner-only). The LAN access code is stored through `ctx.credentials` as `BAMBU_LAN_ACCESS_CODE`; it is never returned to the client and never belongs in the profile patch.

## Bambu app setup

On macOS, choose **Set up Bambu Studio** to install Bambu Studio 02.09.01.70 from the `bambulab/BambuStudio` GitHub release. The installer verifies the universal disk image against a pinned SHA-256 checksum. The staged app must pass deep code-signature verification against Bambu’s team `T3UBR9Y3B2` and macOS Gatekeeper assessment. Rumi installs it under `$DSH_HOME/print-studio/applications` and recognizes copies in `/Applications` and `~/Applications`.

Setup reports downloading, verifying, installing, and failure states. Concurrent requests share one installation. Failed setup preserves existing copies, and retry starts a new download. Plugin shutdown waits for the operation and staging cleanup. A failed disk-image detach retains the staging directory and reports a cleanup failure. `appDownloadTimeoutSeconds` (900) and `appDownloadRetries` (2) govern each download. Mount, copy, signature, and Gatekeeper steps each have a 600-second limit. When updating the pinned version, update its checksum and verify the publisher signature and launch on each target.

## Account sign-in

The settings card opens Bambu's hosted sign-in page in an isolated Rumi desktop window. The desktop adapter accepts login messages only from that window's main frame on `https://bambulab.com`. Social sign-in opens the system browser and returns through a temporary loopback listener. Closing the window, closing Rumi, or reaching the three-minute deadline removes the listener and message handler.

The window advertises a space-delimited `BBL-Slicer/v02.08.02.61` user-agent marker so Bambu's page enables its Studio ticket callback. The page obtains an `http://localhost:<port>` address through `get_localhost_url` before opening the system browser; Bambu rejects numeric loopback addresses. Browser sign-in must retain that return address. Receiving a ticket closes the login window and focuses Rumi.

Print Studio validates the returned message, exchanges tickets through Bambu's ticket endpoint, and stores credentials through `ctx.credentials`. The desktop adapter retains neither tokens nor passwords. The browser card requires Rumi's desktop bridge; standalone DSH Web cannot open this native login window.

The hosted page and ticket exchange were verified with a live Bambu account; re-run that check after Bambu changes the page. Local tests cover the user-agent format, callback address, ticket delivery, window cleanup, message validation, and ticket requests.

## Print monitoring

`GET /api/print-studio/print/status` and `print_studio_progress` read progress, layers, temperatures, AMS, and errors over local MQTT.

## Print layout

Moving physical parts must print separately and assemble afterward, retaining their declared rotation or sliding. The agent designs accessible connectors and explains the assembly order, following [separate printing](../../skills/printable-joints/SKILL.md#separate-printing-for-moving-parts). Legacy printed-assembled movement remains viewable, but publishing, validation and print preparation reject it until redesigned. See [migration](../../upgrade-guide/separate-moving-parts/README.md) for existing models and scripts.

Choose **Arrange for printing** in a canonical USD model's preview to place its physical parts on build plates. **Back to model** restores the saved model and its movement controls. Separately manufactured parts are placed individually, including parts joined by fixed connections after assembly. Static legacy print-in-place groups remain intact. Missing multi-part manufacturing declarations block arrangement until the model is corrected. Automatic placement evaluates all axis-aligned face-down orientations for each part by flat bed-contact footprint area, overhang penalty, and Z height, and adds plates without changing scale. It does not select supports or certify printability.

Drag a part across its plate to change its placement. The selected part has an outline. **Undo** retains up to 32 changes; **Auto arrange** repacks the parts. Overlapping bounding rectangles, insufficient spacing, out-of-plate parts and excess height block export. Completed edits automatically save placement atomically beside the project, independently for each model. Saves run in order and coalesce queued edits; part and plate selection do not write placement. Failed saves retain the draft and offer **Retry saving**. Returning to the model, switching models and opening the slicer wait for the current save. Saved layouts match the source content, viewer transform and plate dimensions; changed models receive a fresh arrangement for review. Unreadable saved state remains untouched until the person explicitly starts a new layout.

**Open plate in Bambu Studio** exports the selected plate as a standard 3MF in a new private `.rumi-print-*` project folder. Each printable part is an independently selectable object with its scale, orientation and position relative to the other parts. Solid material colors are stored per face, including multiple colors on one mesh. Match the imported colors to filaments in Bambu Studio’s color import dialog. In Bambu Studio 2.8.2, choose **OK** if prompted to load geometry only. Review the plate, supports and slicing before printing. The action never sends a print. A failed launch retains the exported file and reports the uncertain handoff. Configure `printLayout.gap` for part and edge spacing (default 5 mm) and `printLayout.volume` for the fallback envelope (default 300 × 320 × 320 mm); an explicit scene build volume takes precedence.

Plate placement checks run independently of model validation. Opening the print layout surfaces the selected model’s current validation status (`accepted`, `passed`, `review`, `needs_repair`, `unavailable`, or `unverified`) both in the print preparation notice before handoff and in the viewer’s status indicator.
