# Print Studio

Setup detection and guided Bambu Lab configuration for Rumi's 3D print workflow.

This slice covers setup plus a real test print. It answers three setup questions and
adds one end-to-end print path:

- Is Bambu Studio installed?
- Does it have the H2D profiles?
- Is a printer configured and reachable on the LAN?

The host half discovers the printer over SSDP, exposes `GET /api/print-studio/status`,
the Bambu Cloud routes under `/api/print-studio/cloud/*`, the mesh viewer routes under
`/api/print-studio/viewer/*`, and the model-facing tools. Signing in fetches the bound
printer's `dev_access_code`; Bambu Connect sends the sliced job. The browser half is the
Print Studio card under **Plugins → Built-in plugin settings**, plus the 3D preview tab.
The bundled `skills/print-studio-setup/SKILL.md` is registered at load so the agent can
walk an adult through whatever the probe reports.

Printer IP and serial are stored in `$DSH_HOME/print-studio/printer.json` (owner-only).
The LAN access code is stored through `ctx.credentials` as `BAMBU_LAN_ACCESS_CODE`; it
is never returned to the client and never belongs in the profile patch.

## Test print

`POST /api/print-studio/print/test` (and the `print_studio_print_test` tool) slices the
bundled 10 x 10 x 1.2 mm tile with Bambu Studio, sets the H2D dual-extruder project and
the Supertack plate, and hands the sliced 3MF to Bambu Connect. Bambu Connect requires
an adult to press **Send**; there is no supported API for that final authorization on
macOS. `GET /api/print-studio/print/status` and `print_studio_progress` read progress,
layers, temperatures, AMS, and errors over local MQTT.

The test tile is about six minutes. A make DSL is a later slice.

## Mesh preview

The `viewer/` module is a general 3D viewport for any conversation; printing is one caller,
not its subject. One folder is one Cordis plugin, so it ships here rather than as a package
of its own.

The scene is the document, in the Blender sense:

- a **datablock** is one mesh: the geometry the host read, its canonical STL bytes, and the
  centre its rotation turns around;
- an **object** places one datablock with a scale, a rotation, and a position; scale and
  rotation turn the mesh about its centre, and the position says where its bottom centre
  sits, so a part that grows or turns stays on the plate
- the **scene** is the objects plus the build volume they are checked against.

Opening the same file twice places two objects that share one datablock, so the browser
fetches the geometry once and every placement moves without touching it.

Every change is a command (`addObject`, `removeObject`, `setTransform`, `setVisible`,
`setVolume`), and commands return a new document, so undo is a list of earlier documents.
The agent issues them through `mesh_open`, `mesh_transform`, and `mesh_remove`, and reads the
result with `mesh_state`; a gizmo, when there is one, will issue the same commands.

`GET /api/print-studio/viewer/state?sessionId=…` returns the scene as the browser draws it
(one placement matrix per object, statuses, and counts). `GET
/api/print-studio/viewer/model?sessionId=…&datablockId=…` returns one datablock's bytes,
which never change once opened and are cached as immutable.

`bake.js` is the projection onto files: one mesh per visible object, transforms applied. It is
the only place a placement becomes geometry, so an exported mesh and a measured mesh cannot
disagree. Export and slicing will consume it; nothing else may apply a transform.

The first pass accepts STL only, up to 20 MiB and 200,000 triangles. Scenes and datablocks are
held in memory for eight conversations and disappear when the plugin unloads. An STL opened
from a conversation renders through the same tab type as a file preview.

Two rules keep the layering: only `viewport/` imports three, and only `bake.js` turns a
placement into geometry.

## Client build

This is the one Cordis row that ships a renderer, so its browser half is bundled rather
than served as plain JavaScript: Three.js stays private to this row and never enters the
shared client module table. `esbuild` and `three` are development dependencies of
`apps/rumi`; `build-client.mjs` writes `lib/client.js` and Three's license beside it.

```sh
pnpm --filter dsh-rumi run build:print-studio-client   # or `run build`, which includes it
```

## Account sign-in

The settings card opens Bambu's hosted sign-in page in an isolated Rumi desktop window. The desktop adapter accepts login messages only from that window's main frame on `https://bambulab.com`. Social sign-in opens the system browser and returns through a temporary loopback listener. Closing the window, closing Rumi, or reaching the three-minute deadline removes the listener and message handler.

The window advertises a space-delimited `BBL-Slicer/v02.08.02.61` user-agent marker so Bambu's page enables its Studio ticket callback. The page obtains an `http://localhost:<port>` address through `get_localhost_url` before opening the system browser; Bambu rejects numeric loopback addresses. Browser sign-in must retain that return address. Receiving a ticket closes the login window and focuses Rumi.

Print Studio validates the returned message, exchanges tickets through Bambu's ticket endpoint, and stores credentials through `ctx.credentials`. The desktop adapter retains neither tokens nor passwords. The browser card requires Rumi's desktop bridge; standalone DSH Web cannot open this native login window.

The hosted page and ticket exchange were verified with a live Bambu account; re-run that check after Bambu changes the page. Local tests cover the user-agent format, callback address, ticket delivery, window cleanup, message validation, and ticket requests.

## Source ownership

The host and client entrypoints, discovery, cloud protocol, native login window, sandboxed Bambu preload, mesh viewer, and behavior tests live in this package. `desktop/` is compiled separately for Electron by `tsconfig.desktop.json`; it is not imported by the Cordis host. Rumi composes this adapter through a private package import and bundles its preload. The app retains only the validated IPC entry, main-window ownership, and preload exposure. `apps/rumi/tests/print-studio.spec.ts` includes the package-owned tests in upstream test discovery. Executable UUID assignment belongs to Rumi packaging because it affects every native capability.
