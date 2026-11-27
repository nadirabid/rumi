/** Agent-facing 3D preview and mesh manipulation tools registered on `ctx.tools`. */
import { createHash } from 'node:crypto'
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path'
import { checkControlGeometry } from '../blender/control-geometry.js'
import { createHistory } from './document.js'
import { STL_LIMITS, encodeStl, parseStl } from './stl.js'
import { discoverModels, saveSelection } from './catalog.js'
import { findModelRegion } from './model-regions.js'
import {
  datablockFor,
  HIGHLIGHT_FAILURES,
  loadIdentity,
  modelContextJson,
  onlyObject,
  refreshMeasurements,
  sceneReport,
} from './host-state.js'

const HIGHLIGHT_FAILURE_MESSAGES = {
  viewer_hidden: 'The viewer reports its document is hidden. Bring Rumi to the foreground and retry the highlight.',
  print_layout: 'Leave the print layout to show this highlight in the 3D preview.',
  highlight_hidden: 'Turn on highlight visibility in the preview to show this overlay.',
  region_unavailable: 'The viewer could not locate this feature on the displayed model. Check or rebuild its saved location.',
  render_failed: 'The viewer reported a rendering error. Read the current meshState context for the error before retrying.',
}

/**
 * Register all 3D preview and STL scene tools.
 * @param {object} deps Shared viewer runtime collaborators.
 * @returns {void}
 */
export function registerViewerTools({
  ctx, defineTool, store, diagnostics, receipts, loads, events, focus,
  loadTimeoutMs, validationConfig, loadJobs, captureJobs, captureReference,
}) {
  const { sessions, isClosed, displaySource, recordFor, serialize, loadSource } = store
  const register = (tool, label) => ctx.effect(() => ctx.tools.register(defineTool(tool)), label)

  register({
    name: 'viewer_cursor_snapshot',
    description: 'Capture the pinned blue region or fresh hover hit with a PNG and model identity. Use a geometry cursor mode for pointing. In Named regions, ask the person to say or type the feature name. For a mesh selection, mesh.path is a project-relative STL in model-local millimetres, Z up, before placement. Pass mesh.path to viewer_highlight to repeat the triangle selection. For each new pointing request use its own voice capture or call this tool. See clarify-mesh-changes.',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args, value) => {
        const { image, ...snapshot } = JSON.parse(value)
        return [{ type: 'text', text: JSON.stringify(snapshot) }, ...(image ? [{ type: 'image', attachment: image }] : [])]
      },
    },
    presentCall: () => ({ card: 'generic', title: 'Inspect cursor region', kind: 'read' }),
    isConcurrencySafe: () => true,
    timeoutMs: 10_000,
    async execute(_args, exec) {
      return captureReference(exec.agent?.session.id, exec.signal)
    },
  }, 'print viewer: inspect cursor')

  register({
    name: 'viewer_working_model',
    description: 'Declare which existing model you are actively inspecting or editing. Shows a green dot without changing the user selection. Use a path from meshState.models; call before work and when changing targets. Omit path to clear before clarification or unrelated work. The host also clears it when your agent stops or is disposed. This declaration does not authorize edits or resolve ambiguous references.',
    parameters: { path: { type: 'string', description: 'Discovered model entry path. Omit to clear the work indicator.' } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    isConcurrencySafe: () => false,
    timeoutMs: 10_000,
    async execute(args, exec) {
      if (!exec.agent) throw new Error('Model work requires a conversation')
      const record = recordFor(exec.agent.session.id)
      let path = null
      if (args.path !== undefined) {
        const cwd = await ctx.workingDirectory.ensure(exec.agent, exec.signal)
        record.models = await discoverModels(cwd)
        path = relative(cwd, resolve(cwd, args.path)).split(sep).join('/')
        if (!record.models.some(model => model.path === path)) throw new Error('Model entry not found; read the current meshState context')
      }
      exec.signal.throwIfAborted()
      if (isClosed()) throw new Error('Model preview is closed')
      focus.set(exec.agent, path)
      return JSON.stringify({ workingModel: path, selectedModel: record.selectedModel ?? null })
    },
  }, 'print viewer: declare working model')

  register({
    name: 'viewer_load',
    description: 'Select a Blender-exported USD in the Three.js viewer. Use models/<name>/model.usda; the viewer discovers these entries and reloads completed exports automatically. '
      + 'USD uses metres and Z up; the viewer converts to millimetres and Z up for measurements, placement and Gaussian regions. '
      + 'Use blender_status and the blender-modeling skill for editing with background Blender scripts. Keep .blend originals and revision exports. '
      + 'Self-contained static USD only, at most 64 MiB and 200,000 preview triangles. Preserve detailed originals when making a lighter preview. '
      + 'Executable .js/.mjs previews are disabled by project isolation; export USD instead. '
      + 'Reloading identical source bytes preserves staged controls and their review while requesting fresh renderer feedback. Changed source bytes invalidate them. '
      + 'Saved models display immediately; use validation_mechanics then validation_accept before claiming acceptance. '
      + 'Waits for renderer feedback for the exact source revision, placement and build volume. Returns load.status ready with design.report measurements and effective design.parameters, or an explicit build_failed, source_failed, viewer_hidden, timeout, superseded, cancelled or unavailable outcome. Only ready acknowledges a visible rendered model; timeout is not evidence of an unsupported model. Loading does not certify print readiness.',
    parameters: {
      path: { type: 'string', required: true, description: 'Model entry to bring into view, for example models/helmet/model.usda.' },
      buildVolume: {
        type: 'object', additionalProperties: false,
        description: 'Printable volume in millimetres. Omit to retain the scene’s current print context.',
        properties: {
          x: { type: 'number', required: true, description: 'Width in millimetres.' },
          y: { type: 'number', required: true, description: 'Depth in millimetres.' },
          z: { type: 'number', required: true, description: 'Height in millimetres.' },
        },
      },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    isConcurrencySafe: () => false,
    timeoutMs: 30_000,
    async execute(args, exec) {
      if (!exec.agent) throw new Error('Model preview requires a conversation')
      const volume = args.buildVolume === undefined ? undefined
        : createHistory().apply({ type: 'setVolume', volume: args.buildVolume }).volume
      const sessionId = exec.agent.session.id
      const record = recordFor(sessionId)
      const pending = (async () => {
        const cwd = await ctx.workingDirectory.ensure(exec.agent, exec.signal)
        exec.signal.throwIfAborted()
        const { completion, requested, initialScene } = await serialize(record, async () => {
          await loadSource(record, cwd, args.path, volume, exec.signal)
          record.models = await discoverModels(cwd)
          exec.signal.throwIfAborted()
          if (isClosed()) throw new Error('Model preview is closed')
          const requested = loadIdentity(record)
          const initialScene = structuredClone(sceneReport(record))
          const completion = loads.wait(sessionId, requested, exec.signal)
          events.notify(sessionId)
          return { completion, requested, initialScene }
        })
        const { scene = initialScene, ...outcome } = await completion
        return JSON.stringify({ ...scene, load: { ...outcome, requested } }, undefined, 2)
      })()
      loadJobs.add(pending)
      try { return await pending }
      finally { loadJobs.delete(pending) }
    },
  }, 'print viewer: load source')

  register({
    name: 'viewer_transform',
    description: 'Place the source model without changing its code. Rotation is in degrees about its centre; position is the bottom centre in millimetres. Placement survives source edits.',
    parameters: {
      scale: { type: 'number', description: 'Positive uniform scale.' },
      rotate: { type: 'object', additionalProperties: false, properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } } },
      position: { type: 'object', additionalProperties: false, properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } } },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    isConcurrencySafe: () => false,
    timeoutMs: 10_000,
    async execute(args, exec) {
      const record = sessions.get(exec.agent?.session.id)
      if (!record?.source) throw new Error('Load a model with viewer_load first')
      focus.assertSelected(exec.agent, record.selectedModel)
      record.source.transform(Object.fromEntries(Object.entries(args).filter(([, value]) => value !== undefined)))
      loads.update(exec.agent.session.id, loadIdentity(record))
      return JSON.stringify(sceneReport(record), undefined, 2)
    },
  }, 'print viewer: source placement')

  register({
    name: 'viewer_highlight',
    description: 'Show a saved named region or a project STL in teal on the editable model. Use the saved region for a request about its name or alias. Use the current displayedDesign identity and wait for rendered before describing the highlight as visible. See clarify-mesh-changes.',
    parameters: {
      path: { type: 'string', required: true, description: 'Exact design.path or selectedModel from the current meshState context.' },
      revision: { type: 'integer', required: true, description: 'Exact design.revision from the current meshState context.' },
      url: { type: 'string', required: true, description: 'Exact design.url from the current meshState context; identifies the loaded instance.' },
      label: { type: 'string', required: true, description: 'Short label up to 200 characters. For a saved region use its name. May be empty when clearing.' },
      region: { type: 'string', description: 'Saved feature name, alias or ID from the current model’s region map. Supply this or meshPath.' },
      regionMapKey: { type: 'string', description: 'Region map key from the resolved named feature. Supply with region to require that edition of the map.' },
      regionName: { type: 'string', description: 'Optional name shown on an STL overlay, up to 64 characters. Use a unique meshPath for each named overlay.' },
      meshPath: { type: 'string', description: 'Project-relative ASCII or binary STL outside the watched model directory. Use model-local millimetres, Z up, including part transforms before placement. Empty string clears the highlight.' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    isConcurrencySafe: () => false,
    timeoutMs: 10_000,
    async execute(args, exec) {
      const record = sessions.get(exec.agent?.session.id)
      if (!record?.source) return JSON.stringify({ status: 'model_required', message: 'Load an editable model with viewer_load first.' })
      focus.assertSelected(exec.agent, record.selectedModel)
      const started = performance.now()
      const operation = (async () => {
        const { result, receipt } = await serialize(record, async () => {
          exec.signal.throwIfAborted()
          await record.source.poll()
          exec.signal.throwIfAborted()
          if ((args.region === undefined) === (args.meshPath === undefined)) throw new Error('Supply either a saved region or a project-relative STL meshPath')
          if (args.region === undefined && args.regionMapKey !== undefined) throw new Error('A region map key requires a saved region')
          const source = displaySource(record)
          const design = source?.state()
          const path = args.path === record.selectedModel ? design?.path : args.path
          let named
          if (args.region !== undefined) {
            if (!design || path !== design.path || args.revision !== design.revision || args.url !== design.url || design.error) {
              return { result: { status: 'stale_model', message: 'Read the current displayed model before highlighting its named region.' } }
            }
            if (args.regionMapKey !== undefined && args.regionMapKey !== design.regionMap?.key) {
              return { result: { status: 'stale_region', message: 'The named regions changed. Ask for a fresh reference.' } }
            }
            const match = findModelRegion(design.regionMap, args.region)
            if (match.status !== 'found') {
              return {
                result: match.status === 'ambiguous'
                  ? { status: 'ambiguous_region', matches: match.matches, message: 'Ask which of these named regions the person means.' }
                  : { status: 'unknown_region', message: 'The current model has no matching named region. Check its region map or ask the person to point.' },
              }
            }
            named = match.region
          }
          let bytes = null
          if (args.meshPath) {
            if (isAbsolute(args.meshPath) || extname(args.meshPath).toLowerCase() !== '.stl') throw new Error('Supply a project-relative STL meshPath')
            const cwd = await ctx.workingDirectory.ensure(exec.agent, exec.signal)
            const target = await realpath(resolve(cwd, args.meshPath))
            const part = relative(await realpath(cwd), target)
            if (part === '..' || part.startsWith('..' + sep) || isAbsolute(part)) throw new Error('Highlight mesh must be inside this project')
            const file = await ctx.fs.resolve(target, { cwd, signal: exec.signal })
            bytes = encodeStl(parseStl(await ctx.fs.readBytes(file, exec.signal, STL_LIMITS.maxBytes)))
            exec.signal.throwIfAborted()
          }
          const target = named
            ? { ...args, path, label: named.name, regionId: named.id, regionMapKey: design.regionMap.key, regionName: named.name }
            : { ...args, path, triangleCount: bytes ? (bytes.byteLength - 84) / 50 : 0 }
          const result = source?.highlight(target) ?? { status: 'awaiting_validation', message: 'No accepted model is displayed yet.' }
          if (result.status === 'queued' && named) result.namedRegion = named
          let receipt = null
          if (result.status === 'queued') {
            record.highlightMesh = bytes ? { id: result.highlight.id, bytes } : null
            receipt = receipts.wait(exec.agent.session.id, result.highlight.id, exec.signal)
            diagnostics.record(exec.agent.session.id, 'highlight.requested', { highlightId: result.highlight.id, revision: args.revision, triangleCount: result.highlight.triangleCount })
          }
          if (result.status === 'cleared') record.highlightMesh = null
          events.notify(exec.agent.session.id)
          return { result, receipt }
        })
        if (!receipt) return JSON.stringify(result)
        const outcome = await receipt
        const status = HIGHLIGHT_FAILURES.has(outcome) ? 'not_rendered' : outcome
        const reason = outcome === 'not_rendered' ? 'ack_timeout' : outcome
        diagnostics.record(exec.agent.session.id, 'highlight.settled', { highlightId: result.highlight.id, status, reason, elapsedMs: Math.round(performance.now() - started) })
        exec.signal.throwIfAborted()
        return JSON.stringify({
          ...result,
          status,
          reason,
          elapsedMs: Math.round(performance.now() - started),
          message: status === 'rendered'
            ? 'The visible viewer rendered this teal highlight. Use it as the visual reference for the requested change.'
            : HIGHLIGHT_FAILURE_MESSAGES[reason]
              ?? 'No matching rendering acknowledgment arrived. Visibility is unknown; do not claim the highlight is visible or absent. Ask the person to open the preview and retry.',
        })
      })()
      captureJobs.add(operation)
      try { return await operation }
      finally { captureJobs.delete(operation) }
    },
  }, 'print viewer: highlight region')

  register({
    name: 'viewer_controls',
    description: 'Prepare, validate, review, and present temporary mesh edit controls. prepare (or open) stages controls without showing them and requires an expected effect and preserved features for every axis. validate generates actual-mesh before/after and displacement-overlay images for endpoints and combinations. Inspect every image, then review each axis and combined effects using the evidenceId; accept only useful, well-behaved edits, otherwise revise and prepare again. present requires accepted current evidence. Changes to the model, fields, parts or ranges require new validation. Pending work is reminded in context. Freeze the latest visible values before saving in Blender; close cancels. Read mesh-edit-controls for intent and quality guidance. Persistent joint controls are authored in USD, independently of this workflow.',
    parameters: {
      action: { type: 'string', required: true, enum: ['prepare', 'open', 'validate', 'review', 'present', 'freeze', 'save', 'close'] },
      id: { type: 'string', description: 'Prepared control review id for validate/review/present, or active analog id for freeze/close.' },
      evidenceId: { type: 'string', description: 'Exact evidenceId returned by validation; required for review.' },
      expectations: { type: 'array', description: 'Required for prepare: expected geometric effect and features to preserve for every axis.', items: { type: 'object', additionalProperties: false, properties: { key: { type: 'string', required: true }, effect: { type: 'string', required: true }, preserve: { type: 'string', required: true } } } },
      assessments: { type: 'array', description: 'Required for review: observations from the images and measurements, for every axis.', items: { type: 'object', additionalProperties: false, properties: { key: { type: 'string', required: true }, decision: { type: 'string', enum: ['accept', 'revise'], required: true }, observation: { type: 'string', required: true } } } },
      combined: { type: 'object', description: 'Required for review: assessment of combined extremes.', additionalProperties: false, properties: { decision: { type: 'string', enum: ['accept', 'revise'], required: true }, observation: { type: 'string', required: true } } },
      path: { type: 'string', description: 'Current design.path for open, absolute or project-relative.' },
      revision: { type: 'integer', description: 'Exact design.revision for open.' },
      url: { type: 'string', description: 'Exact design.url for open.' },
      label: { type: 'string', description: 'Short plain-language region label.' },
      operation: { type: 'string', enum: ['surface', 'fields', 'parameters', 'bulge', 'bend', 'twist', 'taper', 'cut'], description: 'surface supports connected side-view profiles, radial bands, grooves, and explicit planar patches. fields blends displacement lattices. Other adapters are fixed USD edits. JavaScript parameters are disabled.' },
      form: { type: 'object', additionalProperties: true, description: 'For surface: profile {kind:"profile", at:[t,...], pinned?:[stationIndex,...], links?:{stationIndex:earlierStationIndex}, directions?:[[front,up],...], lateral?} binds p0,p1,... for unpinned stations; pinned stations stay at zero and have no control. Linked stations share the earlier station control and do not get a separate value. directions supplies unit vectors in the side-view plane; defaults point outward at each station. Equal linked directions create a rigid section. Values are travel in mm to 2–8 rising stations: t=.25 front mid-height, .5 crown, .75 back mid-height. Station displacements blend smoothly across the outline, including Z; the underside seam at 0/1 is pinned. lateral is 1–8, default 1. ring {kind:"ring",from,to,millimetres} binds amount. channel {kind:"channel",at:[degrees],from,to,widthMillimetres} binds depth in mm; width is arc length. facet {kind:"facet",from,to,planes:[{normal:[x,y,z],offset}],wallThickness?} binds amount in 0..1. Planes use unit outward normals and offsets in model mm; 1–12 planes must be opposing or perpendicular. At amount=1, points beyond each plane project onto it inside the band core. For oriented hollow shells, wallThickness in mm offsets inward-facing surfaces onto separate inner planes; ambiguous rim edges are rejected. Without it, only shallow patches or solid parts are suitable. from/to are normalized selection height, with edge fade .01–.5 (default .08). Every axis requires a control with reset 0 and range within ±1000. Verify thickness and fit; these mappings do not certify them.' },
      uAt: { type: 'number', description: 'For surface: front direction around model Z in degrees, default -90 (-Y). All selected parts share one bounds-derived frame.' },
      finish: { type: 'string', enum: ['parameters', 'blender'], description: 'For parameter controls: parameters saves a final JavaScript model; blender finishes a temporary preview on a preserved original.' },
      original: { type: 'string', description: 'Preserved source path for a Blender-finished preview.' },
      edit: { type: 'string', description: 'Semantic Blender edit recipe, including how parameter values affect the original and what must be preserved.' },
      fieldsPath: { type: 'string', description: 'Project-local JSON file containing the fields array; use instead of inline fields for generated lattices.' },
      fields: { type: 'array', items: { type: 'object', additionalProperties: true }, description: 'For operation fields: {key, origin:[x,y,z], spacing:[x,y,z], dimensions:[nx,ny,nz], offsets:[dx,dy,dz,...]}. Model-local mm; x fastest. 2–16 samples per axis, zero boundary offsets, at most 12 fields. Values/ranges within -1..1, reset 0. Read mesh-edit-controls.' },
      center: { type: 'array', items: { type: 'number' }, description: 'Three model-local coordinates, mm.' },
      radii: { type: 'array', items: { type: 'number' }, description: 'Three positive extents along U,V,N, mm; for cut these bound the allowed limit, not the plane footprint.' },
      direction: { type: 'array', items: { type: 'number' }, description: 'Three numbers: outward axis. Back of helmet is often [0,1,0]; inspect source.' },
      limit: { type: 'number', description: 'Maximum bulge displacement or cut-height travel either side of center, mm, no larger than the smallest radius.' },
      parts: { type: 'array', items: { type: 'string' }, description: 'Exact mesh names to deform; [] includes all meshes in the soft region.' },
      values: { type: 'object', additionalProperties: true, description: 'Numeric initial values keyed by model parameter name. USD adapters use amount, spread, peakX, peakY, falloff, angle in 0..1.' },
      controls: {
        type: 'array',
        description: 'Labeled controls. Supply for open. Each axis key binds a value; pad axes are horizontal then vertical.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            kind: { type: 'string', required: true, enum: ['slider', 'pad', 'curve'] },
            label: { type: 'string', required: true, description: 'Short label in the user’s language, such as Eye tilt.' },
            axes: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  key: { type: 'string', required: true },
                  ...Object.fromEntries(['min', 'max', 'step', 'reset'].map(key => [key, { type: 'number', required: true }])),
                },
              },
            },
          },
        },
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => {
        const result = JSON.parse(value)
        return [{ type: 'text', text: value }, ...(result.images ?? []).map(image => ({ type: 'image', attachment: image }))]
      },
    },
    presentCall: args => ({ card: 'generic', title: args.action === 'open' ? 'Shape controls' : 'Update shape controls', kind: 'write' }),
    isConcurrencySafe: () => false,
    timeoutMs: (validationConfig?.validationTimeoutMs ?? loadTimeoutMs) * 2 + 15_000,
    async execute(args, exec) {
      const sessionId = exec.agent.session.id, record = sessions.get(sessionId)
      if (!record?.source) throw new Error('Load a model first')
      if (args.action === 'prepare') args = { ...args, action: 'open' }
      if (args.action === 'open' && !args.controls) throw new Error('Declare the labeled controls and their bindings before opening')
      focus.assertSelected(exec.agent, record.selectedModel)
      if (args.action === 'close') {
        if (record.source.controlReview.state()?.id === args.id) record.source.controlReview.clear(args.id)
        else record.source.clearShape(args.id)
        events.notify(sessionId)
        return JSON.stringify({ status: 'closed' })
      }
      const operation = (async () => {
        const identity = () => { const state = record.source.state(); return { path: state.path, revision: state.revision, url: state.url, contentHash: state.contentHash } }
        await record.source.poll({ force: true })
        if (args.action === 'validate') {
          const release = record.source.retainSnapshot()
          try {
            const geometryRequest = record.source.controlReview.geometryRequest(args.id)
            if (geometryRequest) {
              if (!validationConfig) throw new Error('Control geometry validation requires the bundled Blender configuration')
              const geometry = await checkControlGeometry(validationConfig, record.source.snapshotBytes(), geometryRequest, exec.signal)
              await record.source.poll({ force: true })
              const checked = record.source.controlReview.geometry(args.id, geometry)
              if (checked.status === 'needs_revision') {
                events.notify(sessionId)
                return JSON.stringify({ ...checked, message: 'New intersecting triangle pairs block presentation. Existing defects nearby do not excuse new pairs. Protect the region, revise the deformation or range, or repair the source; then prepare and validate again.' })
              }
            }
            const work = record.source.controlReview.validate(args.id, exec.signal, validationConfig?.validationTimeoutMs ?? loadTimeoutMs)
            events.notify(sessionId)
            const result = await work
            exec.signal.throwIfAborted()
            if (result.status !== 'complete') throw new Error(result.message ?? 'Control validation was cancelled')
            const images = [], report = []
            for (const item of result.cases) {
              const { image, ...measurements } = item
              const attachment = await ctx.attachments.saveImage({ data: Buffer.from(image.slice('data:image/png;base64,'.length), 'base64'), mediaType: 'image/png', name: `${item.id}.png` })
              images.push(attachment); report.push({ ...measurements, image: attachment })
            }
            await record.source.poll({ force: true })
            exec.signal.throwIfAborted()
            const review = record.source.controlReview.evidence(args.id, report)
            events.notify(sessionId)
            return JSON.stringify({ ...review, images, message: 'Inspect all attached comparisons. Record an assessment for every axis and the combined extremes before presenting.' })
          } catch (error) { record.source.controlReview.fail(args.id); throw error }
          finally { await release() }
        }
        if (args.action === 'review') {
          const review = record.source.controlReview.review(args.id, args.evidenceId, args.assessments, args.combined)
          events.notify(sessionId)
          return JSON.stringify(review)
        }
        if (args.action === 'save') {
          return serialize(record, async () => {
            await record.source.poll()
            const saved = await record.source.saveParameters(args.id)
            events.notify(sessionId)
            return JSON.stringify({ status: 'saved', ...saved })
          })
        }
        const preparedOrActive = await serialize(record, async () => {
          await record.source.poll()
          if (args.action === 'freeze') record.source.requestShapeFreeze(args.id)
          let fields = args.fields
          if (args.action === 'open' && args.fieldsPath !== undefined) {
            if (args.operation !== 'fields' || fields !== undefined) throw new Error('Use fieldsPath only for fields, without inline fields')
            const target = await realpath(resolve(record.cwd, args.fieldsPath)), part = relative(await realpath(record.cwd), target)
            if (!part || part === '..' || part.startsWith(`..${sep}`) || isAbsolute(part)) throw new Error('Field data must stay inside the project')
            const bytes = await readFile(target)
            if (bytes.length > 2 * 1024 * 1024) throw new Error('Field data exceeds 2 MiB')
            fields = JSON.parse(bytes.toString('utf8'))
          }
          let original = args.original, originalHash, finish = args.finish, edit = args.edit
          if (args.action === 'open' && args.operation === 'parameters') {
            const marker = resolve(dirname(await realpath(resolve(record.cwd, args.path))), '.rumi-preview.json')
            let metadata
            try {
              const target = await realpath(marker), part = relative(await realpath(record.cwd), target)
              if (!part || part === '..' || part.startsWith(`..${sep}`)) throw new Error('Preview marker must stay inside the project')
              const bytes = await readFile(target)
              if (bytes.length > 8192) throw new Error('Preview marker exceeds 8192 bytes')
              metadata = JSON.parse(bytes.toString('utf8'))
            } catch (error) { if (error.code !== 'ENOENT') throw error }
            if (metadata !== undefined) {
              if (!metadata || typeof metadata.original !== 'string' || !metadata.original || typeof metadata.edit !== 'string' || !metadata.edit) throw new Error('Invalid .rumi-preview.json: provide original and edit')
              finish = 'blender'; original = metadata.original; edit = metadata.edit
            }
          }
          if (args.action === 'open' && finish === 'blender') {
            if (typeof original !== 'string' || !original) throw new Error('Provide the preserved original path')
            original = await realpath(resolve(record.cwd, original))
            const inside = relative(await realpath(record.cwd), original)
            if (!inside || inside === '..' || inside.startsWith(`..${sep}`)) throw new Error('Preserved original must be a file inside the project')
            originalHash = createHash('sha256').update(await readFile(original)).digest('hex')
          }
          if (args.action === 'open') {
            const current = identity(), path = await realpath(resolve(record.cwd, args.path))
            if (path !== current.path || args.revision !== current.revision || args.url !== current.url || record.source.state().error) throw new Error('Model changed; read current meshState before preparing controls')
            const review = record.source.controlReview.prepare({ ...args, fields, finish, edit, original, originalHash }, current)
            events.notify(sessionId)
            return { prepared: review }
          }
          const shape = args.action === 'present'
            ? record.source.shape(record.source.controlReview.present(args.id, identity()))
            : record.source.state().analog
          if (!shape) throw new Error('No active controls; prepare, validate, review and present first')
          if (args.action === 'present') record.source.controlReview.clear(args.id)
          const receipt = receipts.wait(sessionId, args.action === 'freeze' ? `${shape.id}:freeze` : shape.id, exec.signal)
          events.notify(sessionId)
          return { shape, receipt }
        })
        if (preparedOrActive.prepared) return JSON.stringify(preparedOrActive.prepared)
        const { shape, receipt } = preparedOrActive
        const status = await receipt
        exec.signal.throwIfAborted()
        if (status !== 'rendered') {
          return JSON.stringify({
            status: 'not_rendered',
            reason: status,
            id: shape.id,
            error: record.source.state().analog?.id === shape.id ? record.source.state().analog.error ?? null : null,
            message: status === 'viewer_hidden'
              ? 'The viewer is hidden. Bring Rumi to the foreground; controls will render when visible. This does not mean the binding is unsupported.'
              : status === 'render_failed'
                ? 'The control preview failed. Correct the reported binding or model error before reopening controls.'
                : 'No rendering acknowledgment arrived. Check viewer visibility and errors before retrying; a timeout does not establish that parameter controls are unsupported.',
          })
        }
        if (args.action === 'freeze') {
          await record.source.poll()
          const recipe = record.source.freezeShape(args.id)
          if (recipe.finish === 'blender' && createHash('sha256').update(await readFile(recipe.original)).digest('hex') !== recipe.originalHash) throw new Error('Preserved original changed; reopen controls with the correct source')
          const directory = resolve(record.cwd, 'artifacts', 'shape-controls')
          await mkdir(directory, { recursive: true })
          const inside = relative(await realpath(record.cwd), await realpath(directory))
          if (inside === '..' || inside.startsWith(`..${sep}`)) throw new Error('Recipe directory must stay inside the project')
          const recipePath = resolve(directory, `${recipe.id}.json`)
          await writeFile(recipePath, `${JSON.stringify(recipe, null, 2)}\n`, { mode: 0o600 })
          events.notify(sessionId)
          return modelContextJson({ status: 'frozen', recipePath, recipe })
        }
        return modelContextJson({ status: 'rendered', controls: record.source.state().analog })
      })()
      captureJobs.add(operation)
      try { return await operation } finally { captureJobs.delete(operation) }
    },
  }, 'print viewer: analog shape controls')

  register({
    name: 'viewer_camera',
    description: 'Frame the source model and orbit the viewer camera without changing the design or its printed orientation.',
    parameters: {
      azimuth: { type: 'number', required: true, description: 'Degrees around the Z axis; zero looks from the front (-Y).' },
      elevation: { type: 'number', required: true, description: 'Degrees above the plate, between -89 and 89.' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    isConcurrencySafe: () => false,
    timeoutMs: 10_000,
    async execute(args, exec) {
      const record = sessions.get(exec.agent?.session.id)
      const source = record && displaySource(record)
      if (!source) throw new Error('Load a validated model with viewer_load first')
      if (!Number.isFinite(args.azimuth) || !Number.isFinite(args.elevation) || Math.abs(args.elevation) > 89) throw new Error('Camera angles must be finite; elevation must be between -89 and 89')
      source.camera(args)
      const { path, revision, url, camera } = source.state()
      return JSON.stringify({ path, revision, url, camera })
    },
  }, 'print viewer: camera')

  register({
    name: 'mesh_open',
    description: 'Open an STL into this conversation’s 3D preview and place it on the plate. Coordinates are millimetres, Z up. '
      + 'Opening the same file again places a second copy: the scene holds objects that share mesh geometry. '
      + 'Pass `buildVolume` when the scene is headed for a printer; fit checks then use it and the preview draws it as a plate. '
      + 'Every check is a measurement. None of them establish print readiness.',
    parameters: {
      path: { type: 'string', required: true, description: 'STL path in the session workspace, or an absolute path.' },
      buildVolume: {
        type: 'object', additionalProperties: false,
        description: 'Printable volume in millimetres for this scene. Omit for a mesh that is only being looked at.',
        properties: {
          x: { type: 'number', required: true, description: 'Width in millimetres.' },
          y: { type: 'number', required: true, description: 'Depth in millimetres.' },
          z: { type: 'number', required: true, description: 'Height in millimetres.' },
        },
      },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    isConcurrencySafe: () => false,
    timeoutMs: 30_000,
    async execute(args, exec) {
      const agent = exec.agent
      if (agent === undefined) throw new Error('Mesh preview requires a conversation')
      if (typeof args.path !== 'string' || args.path.trim() === '') throw new Error('mesh_open requires a file path')
      if (extname(args.path).toLowerCase() !== '.stl') throw new Error('mesh_open accepts an STL file')
      const cwd = await ctx.workingDirectory.ensure(agent, exec.signal)
      const target = await ctx.fs.resolve(args.path, { cwd, signal: exec.signal })
      const source = await ctx.fs.readBytes(target, exec.signal, STL_LIMITS.maxBytes)
      const positions = parseStl(source)
      exec.signal.throwIfAborted()
      if (isClosed()) throw new Error('Mesh preview is closed')
      const record = recordFor(agent.session.id)
      if (args.buildVolume !== undefined) {
        const volume = createHistory().apply({ type: 'setVolume', volume: args.buildVolume }).volume
        if (record.source) await saveSelection(cwd, record.selectedModel, volume)
        record.history.apply({ type: 'setVolume', volume })
        loads.update(agent.session.id, loadIdentity(record))
      }
      const datablockId = datablockFor(record, target.displayPath ?? args.path, positions, encodeStl(positions))
      const scene = record.history.apply({ type: 'addObject', datablockId, name: basename(args.path) })
      refreshMeasurements(record, [scene.objects.at(-1).id])
      return JSON.stringify(sceneReport(record), undefined, 2)
    },
  }, 'print-studio: open mesh tool')

  register({
    name: 'mesh_transform',
    description: 'Place one object in the 3D preview: uniform scale, rotation in degrees about the object’s centre, and position in millimetres. '
      + 'Each part you pass replaces that part and the rest is kept, so a scale stays when you only rotate. '
      + 'This never rewrites the mesh or the file; the scene holds the placement until it is baked for printing. '
      + 'Omit `objectId` when the scene holds exactly one object.',
    parameters: {
      objectId: { type: 'string', description: 'Object to place; defaults to the only object in the scene.' },
      scale: { type: 'number', description: 'Uniform scale greater than zero.' },
      rotate: {
        type: 'object', additionalProperties: false,
        description: 'Rotation in degrees about each axis, applied X then Y then Z, around the object’s centre.',
        properties: {
          x: { type: 'number', description: 'Rotation about X in degrees.' },
          y: { type: 'number', description: 'Rotation about Y in degrees.' },
          z: { type: 'number', description: 'Rotation about Z in degrees.' },
        },
      },
      position: {
        type: 'object', additionalProperties: false,
        description: 'Offset in millimetres on each axis, replacing the current offset.',
        properties: {
          x: { type: 'number', description: 'X offset in millimetres.' },
          y: { type: 'number', description: 'Y offset in millimetres.' },
          z: { type: 'number', description: 'Z offset in millimetres.' },
        },
      },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    isConcurrencySafe: () => false,
    timeoutMs: 15_000,
    async execute(args, exec) {
      const agent = exec.agent
      if (agent === undefined) throw new Error('Mesh preview requires a conversation')
      const record = recordFor(agent.session.id)
      const objectId = args.objectId ?? onlyObject(record, 'mesh_transform')
      record.history.apply({ type: 'setTransform', objectId, scale: args.scale, rotate: args.rotate, position: args.position })
      refreshMeasurements(record, [objectId])
      return JSON.stringify(sceneReport(record), undefined, 2)
    },
  }, 'print-studio: place mesh tool')

  register({
    name: 'mesh_remove',
    description: 'Remove one object from the 3D preview. The mesh geometry stays available to the session, so opening the file again does not read it twice.',
    parameters: {
      objectId: { type: 'string', description: 'Object to remove; defaults to the only object in the scene.' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    isConcurrencySafe: () => false,
    timeoutMs: 15_000,
    async execute(args, exec) {
      const agent = exec.agent
      if (agent === undefined) throw new Error('Mesh preview requires a conversation')
      const record = recordFor(agent.session.id)
      const objectId = args.objectId ?? onlyObject(record, 'mesh_remove')
      record.history.apply({ type: 'removeObject', objectId })
      refreshMeasurements(record)
      return JSON.stringify(sceneReport(record), undefined, 2)
    },
  }, 'print-studio: remove mesh tool')
}
