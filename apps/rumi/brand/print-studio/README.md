# Print Studio

English | [中文](README.zh.md)

Setup detection and guided Bambu Lab configuration for Rumi's 3D print workflow.

This slice covers setup plus a real test print. It answers three setup questions and adds one end-to-end print path:

- Is Bambu Studio installed?
- Does it have the H2D profiles?
- Is a printer configured and reachable on the LAN?

The host half discovers the printer over SSDP, exposes `GET /api/print-studio/status`, the Bambu Cloud routes under `/api/print-studio/cloud/*`, the mesh viewer routes under `/api/print-studio/viewer/*`, and the model-facing tools. Signing in fetches the bound printer's `dev_access_code`; Bambu Connect sends the sliced job. The browser half is the Print Studio card under **Plugins → Built-in plugin settings**, plus the 3D preview tab. The bundled [setup skill](skills/print-studio-setup/SKILL.md) and [FDM design skill](skills/fdm-design/SKILL.md) are registered at plugin load for agent discovery. They provide setup guidance and design constraints; the agent loads their instructions when relevant.

Printer IP and serial are stored in `$DSH_HOME/print-studio/printer.json` (owner-only). The LAN access code is stored through `ctx.credentials` as `BAMBU_LAN_ACCESS_CODE`; it is never returned to the client and never belongs in the profile patch.

The [printer-awareness skill](skills/printer-awareness/SKILL.md) connects live status tools and installed machine profiles to printer-specific decisions, preserving unknown readings and requiring a sourced build envelope.

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

## Blender editing and GLB previews

New modeling and mesh edits use local Blender background Python scripts through the existing shell tool and its permissions. Packaged Rumi includes Blender under `Resources/runtime/blender`; app updates replace that runtime with the pinned release. `blender_status` uses it by default and reports a broken bundle rather than silently falling back to a separate installation. An explicit `blenderExecutable` overrides discovery. Development checkouts can use `blenderHome/tools/blender/Blender.app`, `/Applications/Blender.app`, or the user's Applications folder; `blenderHome` defaults to `DSH_RUMI_HOME` or `~/.rumi`. The bundled [blender-modeling skill](skills/blender-modeling/SKILL.md) owns the agent workflow; the status tool returns the installed export-helper path.

The helper saves immutable `.blend`, GLB and measurement revisions under `models/<name>/revisions/`, then atomically replaces `model.glb`. Scripts run a full Blender process without opening its window. Blender coordinates are metres, Z up; standard GLB uses metres, Y up. Three.js converts GLB to millimetres, Z up, preserving names, normals and materials. Cursor snapshots and highlights therefore retain the same model-local millimetre coordinates as JavaScript designs. Blender edits must account for object transforms and divide these coordinates by 1,000. The helper retains modifiers in the editable original and applies them to the viewing export. Export failure leaves the previous preview intact; partial revision files remain available for diagnosis.

`viewer_load` accepts self-contained static GLB files inside the project, limited to 64 MiB and 200,000 visible triangles. External resources, animations, skinning and required extensions are rejected. Detailed assets must be preserved separately when explicitly producing a lighter preview. The viewer discovers `models/<name>/model.glb` before JavaScript entries in the same directory and reloads completed exports after two identical polls. Immutable snapshot URLs preserve version identity for cursor capture and agent highlights. Invalid exports retain the last successful preview and report an error. These checks do not establish print readiness.

## Editable Three.js models

Store each independent model in `models/<name>/model.js` (or `model.mjs`), with helpers inside the same directory. The viewer discovers these entries automatically, labels its rounded glass buttons with the folder names, and notices additions and removals on its next poll. Each button keeps a visible border and shadow, including when only one model exists. Call `viewer_load` with an entry path to bring that model into view; `mesh_state` lists discovered models and the selected entry. Existing `source/model.js` entries remain discoverable. The module exports a synchronous `build(THREE)` function returning a new `THREE.Mesh` or `THREE.Group`. Use millimetres, with Z up. Pass `buildVolume` to `viewer_load` to draw the printer envelope and enable fit checks; omitting it retains the current print context. [The table example](assets/example-model.js) demonstrates named parts, shared geometry, materials, and parameters.

The host serves immutable snapshots of `.js` and `.mjs` files beneath the entry's directory. Relative imports must stay within that directory and include their extension; helper functions receive `THREE` from the entry module. Bare package imports, imported assets, and files outside that directory are not provided. Keep source in a dedicated directory: snapshots allow 64 modules, 2 MiB of source, and 512 directory entries; symlinks are rejected. While the preview is mounted, two identical source polls publish an update, normally within 2–4 seconds. All modules receive new URLs together, including unchanged importers of an edited dependency.

The Electron renderer executes the module and displays its returned hierarchy. The host never executes project JavaScript, and no additional process is started. Models support static Mesh and Group hierarchies, up to 200,000 visible triangles, without skins, instances, morph targets, or partial draw ranges. The viewer owns the scene, lights, camera, orbit controls, and resource disposal. Build code must be synchronous and free of DOM access, timers, and other side effects; it runs with renderer capabilities, not in a sandbox. A blocking build can freeze the window.

`viewer_transform` applies uniform scale, XYZ rotation in degrees, and bottom-centre position in millimetres without changing source. `viewer_camera` frames the design from an azimuth and elevation without altering its geometry. Both operate on the loaded design as a whole; edit named parts in source. Camera state and placement survive successful rebuilds. Failed imports or builds leave the last successful model visible and show an error; `mesh_state` includes the source revision, build error, and renderer-reported measurements. Measurements require the preview to be mounted and never certify print readiness. The existing STL import and scene tools remain available separately.

Each conversation owns its live preview. The last selected entry and plate dimensions are saved atomically in the project’s `.rumi-viewer.json` and restored when a preview opens after restart; without a saved selection, the first discovered model opens. Switching models refreshes the preview as soon as the host accepts the selection, without waiting for the periodic poll, and resets camera and placement. A missing or unreadable saved entry shows an error instead of substituting another model; select an available model to recover. Discovery excludes symlinked folders and entries. Only the selected source is loaded; other model files remain on disk. STL scene objects remain in memory.

Source loading and snapshots are Cordis effects owned by the Print Studio plugin. Snapshot effects collect the route registrations’ exact disposers. Unloading stops source polling, awaits admitted loads and polls, and releases routes; the viewer discards late imports and disposes its GPU resources. Tests exercise these paths with real Cordis contexts.

### Visual clarification

The bundled `clarify-mesh-changes` skill guides region identification and clarification of the requested operation. `viewer_highlight` replaces up to eight Gaussian ellipsoids on the editable model loaded with `viewer_load`; STL imports are not supported. Pass `design.path`, `design.revision`, and `design.url` from `mesh_state`, a short `label`, and `blobs` containing three-number `center`, `radii`, and `rotationDegrees` arrays. Coordinates are model-local millimetres including part transforms, before whole-design placement; rotations are XYZ Euler degrees. Radii are nominal extents: influence is `exp(-1.5 * dot(q,q))` after inverse rotation and division by radii, combined by maximum and faded with `smoothstep(0.08,0.42,influence)`. Every intersected surface can be affected, including the back of a shell.

Agent regions use teal fill and dark wireframe; the cursor region uses blue fill and dark blue edges, blended with the shaded surface before tone mapping independently of the app theme. The viewport reveals triangle edges inside the soft region without changing source geometry, materials, measurements, exports, or project covers. Agent-proposed highlights are controlled through the conversation. Hovering over an editable model or STL reveals nearby triangle edges with the same Gaussian fade. Where regions overlap, cursor blue takes precedence. The invisible hover region follows the nearest visible surface, uses a nominal 60 CSS-pixel radius, and updates at most once per display frame without a painted trail or session writes. Leaving the canvas, losing window focus, or replacing the model clears it; camera gestures remain available. Hover is omitted from project covers. Source revisions and model replacement clear the highlight; stale identities and source errors reject new highlights without replacing the previous state. An empty blob list clears the reference. Tool requests and returned regions are recorded by the normal tool conversation events; presentation state itself is session-memory only. `viewer_highlight` waits up to eight seconds for the visible renderer to acknowledge the matching highlight ID and source identity. Only `rendered` confirms rendering; `not_rendered`, cancellation, or replacement cannot be described as a visible highlight. Rendering is not user confirmation; this tool does not capture screenshots. The skill requires visual grounding for region-specific edits and named parts. Clear requests and offered choices are handled in context; ambiguous intent needs clarification. There is no phrase parser or highlight-based edit gate.

`viewer_cursor_snapshot` requests a fresh capture from the open viewer in the calling conversation. It samples the active cursor when the viewer processes the request, through a session-scoped long-poll wakeup; it never returns an earlier hover. A successful result includes a PNG attachment, capture time, pointed object or part path, triangle index, world-space point and Gaussian radius, camera, and geometry/placement identity. Editable-model hits include `region.modelLocalBlob` in the coordinates accepted by `viewer_highlight`; use the accompanying `identity.design` to propose the same region independently. Hover is not a persistent selection or an exact triangle mask.

Only requested captures cross to the host. Live Voice requests one at the first transcript chunk since its preceding delegation and records the timestamped result and image in separate background context linked to the spoken message ID. The user’s voice bubble contains only their words. This approximates pointing during speech; it is not audio-onset sampling. The agent must use that attached reference for the utterance rather than substitute a later cursor position. Viewer wakeups also deliver highlight changes without waiting for the two-second scene poll. The tool's structured result and durable image attachment enter the normal conversation log, making the agent's visual input replayable. Missing intersections report `no_hit`; closed or nonresponding viewers report `viewer_unavailable` after at most eight seconds. Changed source/placement identities report `stale_view`, capture or image-storage failures report `capture_failed`, and a concurrent request reports `busy`. Cancellation, scene eviction, and plugin disposal release pending requests. Responses are session/request scoped and validated before entering tool output. Images are limited to a 960-pixel longest edge and three million encoded characters; the attachment service validates and stores their PNG bytes. Agent highlights remain independently controlled by `viewer_highlight` and do not move with the cursor.

### Highlight diagnostics

`viewerDiagnosticsDirectory` defaults to `~/.rumi/viewer-logs`. Private JSONL files record highlight request IDs, host wakeups and state delivery, client apply and feedback phases, document visibility, viewport dimensions, identity comparisons, and settlement latency. Client durations use a monotonic clock; host receipt times establish cross-process order. No model source, images, audio, transcript text, or credentials are recorded. Files remain until deleted. Journal I/O errors fail the owning operation; failed client trace delivery also reports to the browser console.

`not_rendered` includes `reason`: `ack_timeout` means no matching acknowledgment arrived and does not establish that the highlight was absent; `viewer_hidden` and `render_failed` are explicit renderer reports. Returning a hidden document to view redraws and reports the current highlight. A highlight-only update reuses the geometry, materials, and measurement report; only region uniforms change. Placement, volume, and source changes invalidate measurements. The CPU diagnostic `node --import tsx/esm apps/rumi/brand/print-studio/tests/viewer-highlight.perf.ts` compares uniform updates with `--rebuild`; it excludes network, model response, and GPU time.
