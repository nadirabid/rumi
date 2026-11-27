/**
 * The mesh preview capability: wires session state, HTTP routes, agent tools,
 * system-prompt context injection, validation, print layout, and Live Voice capture.
 */
import { usdRequiresSeparatePrint } from './usd.js'
import { registerPrintLayout } from './print-layout/host.js'
import { createViewerDiagnostics } from './diagnostics.js'
import { createHighlightReceipts } from './receipts.js'
import { createLoadReceipts } from './load-receipts.js'
import { createViewerEvents } from './events.js'
import { createCursorRequests, saveCursorMesh } from './cursor.js'
import { createModelFocus } from './model-focus.js'
import { createActivityTracker } from './activity-classifier.js'
import { createValidation } from './validation.js'
import { registerValidationTools } from './validation-tools.js'
import { registerSurfaceAnalysis } from './surface-analysis-tool.js'
import { summarizeValidationState } from './validation-summary.js'
import { createViewerSessions, designIdentity, modelContextJson, sceneReport } from './host-state.js'
import { registerViewerRoutes } from './host-routes.js'
import { registerViewerTools } from './host-tools.js'

/**
 * Register the preview routes, prompt context, voice hook, and scene tools.
 * @param {object} ctx - Cordis host context with connection, tools, fs, and workingDirectory.
 * @param {Function} defineTool - DSH's schema-validating tool factory from the host entrypoint.
 * @param {string} diagnosticsDirectory - Private local journal directory.
 * @param {number} loadTimeoutMs - Maximum renderer acknowledgment wait, in milliseconds.
 * @param {object} [validationConfig] Resolved validator settings; omitted by isolated viewer fixtures.
 * @returns {void}
 */
export function applyViewer(ctx, defineTool, diagnosticsDirectory, loadTimeoutMs, validationConfig) {
  registerSurfaceAnalysis(ctx, defineTool)
  const diagnostics = createViewerDiagnostics(diagnosticsDirectory)
  const receipts = createHighlightReceipts()
  const loads = createLoadReceipts(loadTimeoutMs)
  const events = createViewerEvents()
  const cursors = createCursorRequests(sessionId => events.notify(sessionId))
  const loadJobs = new Set(), captureJobs = new Set()

  let store
  const focus = createModelFocus(ctx, { read: id => store.sessions.get(id), notify: id => events.notify(id) })
  const activity = createActivityTracker(ctx, { notify: id => events.notify(id) })
  const validation = validationConfig ? createValidation(ctx, validationConfig, {
    notify: id => events.notify(id),
    view: id => {
      const record = store.sessions.get(id), scene = record?.history.current(), design = record?.source?.state()
      return {
        selectedModel: record?.selectedModel,
        transform: design?.transform,
        sourceHash: design?.contentHash,
        analog: design?.analog,
        volume: scene?.volume ?? null,
        meshes: (scene?.objects ?? []).filter(object => object.visible).map(object => ({
          path: `stl:${object.id}`,
          bytes: new Uint8Array(record.datablocks.get(object.datablockId).bytes),
          transform: object.transform,
        })),
      }
    },
  }) : null
  if (validation) registerValidationTools(ctx, defineTool, validation, validationConfig)

  store = createViewerSessions({ ctx, loads, receipts, events, cursors, focus, validation })

  ctx.inject(['systemPrompt'], scoped => {
    scoped.effect(() => scoped.systemPrompt.section({
      name: 'rumi:naming-model-regions',
      order: scoped.systemPrompt.getSectionOrder('TOOL_WORKFLOW'),
      text: 'For every model listed in missingRegionMaps, follow name-model-regions and recreate its named regions during this turn. Finish requested model edits first. Bind physical features to measured triangles and audit the saved map for each final revision you keep.',
    }), 'print viewer: name model features')

    scoped.effect(() => scoped.systemPrompt.context({
      name: 'rumi:mesh-state',
      order: scoped.systemPrompt.getContextOrder('WEB_SURFACE'),
      interpolate: false,
      required: true,
      text: ({ agent }) => {
        if (!agent) return ''
        const record = store.sessions.get(agent.session.id)
        return modelContextJson({
          meshState: record
            ? {
                ...sceneReport(record),
                ...(validation ? { displayedDesign: designIdentity(record.source?.state()) } : {}),
                validation: summarizeValidationState(validation?.read(agent.session.id)),
                workingModels: focus.paths(agent.session.id),
              }
            : {
                status: 'unavailable',
                reason: 'viewer_not_initialized',
                validation: summarizeValidationState(validation?.read(agent.session.id)),
              },
        })
      },
    }), 'print viewer: live mesh context')

    scoped.effect(() => scoped.systemPrompt.context({
      name: 'rumi:active-shape',
      order: scoped.systemPrompt.getContextOrder('WEB_SURFACE'),
      interpolate: false,
      required: true,
      text: context => {
        const source = store.sessions.get(context.agent?.session.id)?.source
        const shape = source?.state().analog
        const review = source?.controlReview.state()
        if (review) return `Pending mesh control review: ${JSON.stringify(review)}. Do not claim controls are ready before presenting reviewed controls. Validation renders are evidence, not an automatic quality pass. Inspect every comparison for the expected effect, unwanted movement, pinching, intersections, and part fit.`
        if (!shape) return source ? 'No temporary mesh controls are staged or presented.' : ''
        return `Unresolved model edit: ${JSON.stringify({ id: shape.id, label: shape.label, operation: shape.operation, controls: shape.controls, values: shape.values, frozen: shape.frozen, finish: shape.finish, original: shape.original, edit: shape.edit })}. Keep controls open while the person explores. Satisfaction or moving to another task resolves the current edit first: freeze the latest visible values, then ${shape.operation === 'parameters' && shape.finish !== 'blender' ? 'call viewer_controls save with the frozen id' : 'apply the captured recipe in Blender, publish and load the revision'}. If already frozen, finish saving. Explicit cancel uses close. Read mesh-edit-controls; do not require a special phrase.`
      },
    }), 'print-studio active edit context')
  })

  ctx.effect(() => async () => {
    store.close()
    await validation?.dispose()
    await Promise.allSettled([...store.evictions])
    loads.dispose()
    receipts.dispose()
    events.dispose()
    cursors.dispose()
    await Promise.allSettled([...loadJobs])
    await Promise.allSettled([...captureJobs])
    await Promise.all([...store.sessions.values()].map(record => record.pending))
    store.sessions.clear()
    diagnostics.close()
  }, 'print-studio: preview scenes')

  if (validationConfig?.printLayout) {
    registerPrintLayout(ctx, (sessionId, operation) => {
      const record = store.recordFor(sessionId)
      return store.serialize(record, async () => {
        await store.discover(sessionId, record)
        const design = record.source?.state()
        if (!design || design.error?.kind === 'source') throw new Error('Load a model before arranging it')
        return operation({
          design,
          requiresSeparatePrint: usdRequiresSeparatePrint(record.source.snapshotBytes()),
          cwd: await store.directoryFor(sessionId, record),
          model: record.selectedModel,
          volume: record.history.current().volume,
        })
      })
    }, validationConfig.printLayout)
  }

  async function captureReference(sessionId, signal) {
    if (store.isClosed()) return JSON.stringify({ status: 'viewer_unavailable', reason: 'viewer_closed' })
    const capture = (async () => {
      const record = store.sessions.get(sessionId)
      if (!record) return JSON.stringify({ status: 'viewer_unavailable', reason: 'viewer_not_open' })
      const identity = await store.serialize(record, async () => {
        await record.source?.poll()
        return store.displayIdentity(record)
      })
      if (store.displaySource(record)?.state().error) return JSON.stringify({ status: 'stale_view' })
      const result = await cursors.request(sessionId, identity, signal)
      signal.throwIfAborted()
      if (result.status !== 'captured') return JSON.stringify(result)
      const { image: imageData, meshBytes, ...snapshot } = result
      let image
      try {
        image = await ctx.attachments.saveImage({
          data: Buffer.from(imageData.slice('data:image/png;base64,'.length), 'base64'),
          mediaType: 'image/png',
          name: 'Cursor region.png',
        })
      } catch (_error) {
        signal.throwIfAborted()
        return JSON.stringify({ status: 'capture_failed', message: 'The cursor image could not be stored. Retry the snapshot before interpreting the region.' })
      }
      signal.throwIfAborted()
      if (meshBytes) {
        try { snapshot.mesh = await saveCursorMesh(record.cwd, meshBytes, signal) }
        catch (_error) {
          signal.throwIfAborted()
          snapshot.meshUnavailable = 'storage_failed'
        }
      }
      return JSON.stringify({ ...snapshot, image })
    })()
    captureJobs.add(capture)
    try { return await capture }
    finally { captureJobs.delete(capture) }
  }

  ctx.inject(['liveVoice'], scoped => {
    scoped.effect(() => scoped.liveVoice.register({
      id: 'print-studio-pointing',
      instructions: () => 'Delegate all requests about what to highlight or change in the model, including ambiguous requests. Pass spoken feature names through as said. The modeling assistant can use a captured geometry reference for pointing, ask for clarification, and confirm the requested highlight using viewer_highlight. Wait for the rendered result before describing a visible highlight. When mesh shaping controls are active, delegate satisfaction, completion, cancellation, and changes of topic so the modeling assistant can resolve the current edit and clear its controls and highlight before proceeding. Do not merely acknowledge that it is done.',
      captureRequest: async ({ sessionId, requestedAt, signal }) => {
        if (!store.sessions.has(sessionId)) return []
        const record = store.sessions.get(sessionId)
        const displayed = store.displaySource(record)?.state()
        const selectionAtSpeech = { path: record.selectedModel ?? null, revision: displayed?.revision ?? null }
        const { image, ...snapshot } = JSON.parse(await captureReference(sessionId, signal))
        return [{
          type: 'text',
          text: JSON.stringify({
            reference: 'cursor-at-start-of-spoken-request',
            requestedAt,
            selectionAtSpeech,
            snapshot,
            instruction: 'Use the captured geometry for pointing in this request. Resolve named regions from the person’s words. Highlight the intended area and ask for clarification when needed.',
          }),
        }, ...(image ? [{ type: 'image', attachment: image }] : [])]
      },
    }), 'print viewer: spoken pointing references')
  })

  registerViewerRoutes({ ctx, store, diagnostics, receipts, loads, events, cursors, focus, activity, validation })
  registerViewerTools({
    ctx, defineTool, store, diagnostics, receipts, loads, events, focus,
    loadTimeoutMs, validationConfig, loadJobs, captureJobs, captureReference,
  })
}
