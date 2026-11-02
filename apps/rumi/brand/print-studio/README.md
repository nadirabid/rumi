# Print Studio

English | [中文](README.zh.md)

Setup detection and guided Bambu Lab configuration for Rumi's 3D print workflow.

This slice covers setup plus a real test print. It answers three setup questions and adds one end-to-end print path:

- Is Bambu Studio installed?
- Does it have the H2D profiles?
- Is a printer configured and reachable on the LAN?

The host half discovers the printer over SSDP, exposes `GET /api/print-studio/status`, the Bambu Cloud routes under `/api/print-studio/cloud/*`, the mesh viewer routes under `/api/print-studio/viewer/*`, and the model-facing tools. Signing in fetches the bound printer's `dev_access_code`; Bambu Connect sends the sliced job. The browser half is the Print Studio card under **Plugins → Built-in plugin settings**, plus the 3D preview tab. The bundled `skills/print-studio-setup/SKILL.md` is registered at load so the agent can walk an adult through whatever the probe reports.

Printer IP and serial are stored in `$DSH_HOME/print-studio/printer.json` (owner-only). The LAN access code is stored through `ctx.credentials` as `BAMBU_LAN_ACCESS_CODE`; it is never returned to the client and never belongs in the profile patch.

## Test print

`POST /api/print-studio/print/test` (and the `print_studio_print_test` tool) slices the bundled 10 x 10 x 1.2 mm tile with Bambu Studio, sets the H2D dual-extruder project and the Supertack plate, and hands the sliced 3MF to Bambu Connect. Bambu Connect requires an adult to press **Send**; there is no supported API for that final authorization on macOS. `GET /api/print-studio/print/status` and `print_studio_progress` read progress, layers, temperatures, AMS, and errors over local MQTT.

The test tile is about six minutes.

## Mesh preview

The `viewer/` module is a general 3D viewport for any conversation; printing is one caller, not its subject. One folder is one Cordis plugin, so it ships here rather than as a package of its own.

The STL scene document separates geometry from placement:

- a **datablock** is one mesh: the geometry the host read, its canonical STL bytes, and the
  centre its rotation turns around;
- an **object** places one datablock with a scale, a rotation, and a position; scale and
  rotation turn the mesh about its centre, and the position says where its bottom centre
  sits, so a part that grows or turns stays on the plate
- the **scene** is the objects plus the build volume they are checked against.

Opening the same file twice places two objects that share one datablock, so the browser fetches the geometry once and every placement moves without touching it.

Every change is a command (`addObject`, `removeObject`, `setTransform`, `setVisible`, `setVolume`), and commands return a new document, so undo is a list of earlier documents. The agent issues them through `mesh_open`, `mesh_transform`, and `mesh_remove`, and reads the result with `mesh_state`; a gizmo, when there is one, will issue the same commands.

`GET /api/print-studio/viewer/state?sessionId=…` returns the scene as the browser draws it (one placement matrix per object, statuses, and counts). `GET /api/print-studio/viewer/model?sessionId=…&datablockId=…` returns one datablock's bytes, which never change once opened and are cached as immutable.

`bake.js` is the projection onto files: one mesh per visible object, transforms applied. It uses the same placement calculation as measurement. Export and slicing can consume these meshes without altering their source files.

STL imports accept files up to 20 MiB and 200,000 triangles. Editable designs use the [Three.js model interface](#editable-threejs-models). Scenes and datablocks are held in memory for eight conversations and disappear when the plugin unloads. An STL opened from a conversation renders through the same tab type as a file preview.

Only `viewport/` imports Three.js. Both model types use `transform.js` for placement; `bake.js` prepares placed STL geometry for export.

## Client build

This is the one Cordis row that ships a renderer, so its browser half is bundled rather than served as plain JavaScript: Three.js stays private to this row and never enters the shared client module table. `esbuild` and `three` are development dependencies of `apps/rumi`; `build-client.mjs` writes `lib/client.js` and Three's license beside it.

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

## Editable Three.js models

Store each independent model in `models/<name>/model.js` (or `model.mjs`), with helpers inside the same directory. The viewer discovers these entries automatically, labels its rounded glass buttons with the folder names, and notices additions and removals on its next poll. Each button keeps a visible border and shadow, including when only one model exists. Call `viewer_load` with an entry path to bring that model into view; `mesh_state` lists discovered models and the selected entry. Existing `source/model.js` entries remain discoverable. The module exports a synchronous `build(THREE)` function returning a new `THREE.Mesh` or `THREE.Group`. Use millimetres, with Z up. Pass `buildVolume` to `viewer_load` to draw the printer envelope and enable fit checks; omitting it retains the current print context. [The table example](assets/example-model.js) demonstrates named parts, shared geometry, materials, and parameters.

The host serves immutable snapshots of `.js` and `.mjs` files beneath the entry's directory. Relative imports must stay within that directory and include their extension; helper functions receive `THREE` from the entry module. Bare package imports, imported assets, and files outside that directory are not provided. Keep source in a dedicated directory: snapshots allow 64 modules, 2 MiB of source, and 512 directory entries; symlinks are rejected. While the preview is mounted, two identical source polls publish an update, normally within 2–4 seconds. All modules receive new URLs together, including unchanged importers of an edited dependency.

The Electron renderer executes the module and displays its returned hierarchy. The host never executes project JavaScript, and no additional process is started. Models support static Mesh and Group hierarchies, up to 200,000 visible triangles, without skins, instances, morph targets, or partial draw ranges. The viewer owns the scene, lights, camera, orbit controls, and resource disposal. Build code must be synchronous and free of DOM access, timers, and other side effects; it runs with renderer capabilities, not in a sandbox. A blocking build can freeze the window.

`viewer_transform` applies uniform scale, XYZ rotation in degrees, and bottom-centre position in millimetres without changing source. `viewer_camera` frames the design from an azimuth and elevation without altering its geometry. Both operate on the loaded design as a whole; edit named parts in source. Camera state and placement survive successful rebuilds. Failed imports or builds leave the last successful model visible and show an error; `mesh_state` includes the source revision, build error, and renderer-reported measurements. Measurements require the preview to be mounted and never certify print readiness. The existing STL import and scene tools remain available separately.

Each conversation owns its live preview. The last selected entry and plate dimensions are saved atomically in the project’s `.rumi-viewer.json` and restored when a preview opens after restart; without a saved selection, the first discovered model opens. Switching models resets camera and placement. A missing or unreadable saved entry shows an error instead of substituting another model; select an available model to recover. Discovery excludes symlinked folders and entries. Only the selected source is loaded; other model files remain on disk. STL scene objects remain in memory.

Source loading and snapshots are Cordis effects owned by the Print Studio plugin. Snapshot effects collect the route registrations’ exact disposers. Unloading stops source polling, awaits admitted loads and polls, and releases routes; the viewer discards late imports and disposes its GPU resources. Tests exercise these paths with real Cordis contexts.
