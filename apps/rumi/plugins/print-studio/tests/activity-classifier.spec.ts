/** Composable tool-call classification and passive session activity tracking. */
import { describe, expect, it, vi } from 'vitest'
import {
  classifyToolCall,
  createActivityTracker,
  DEFAULT_CLASSIFIER_RULES,
  VIEWER_ACTIVITIES,
} from '../viewer/activity-classifier.js'

function createFakeContext() {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>()
  const disposers: (() => void)[] = []
  return {
    on(event: string, listener: (...args: unknown[]) => void) {
      let set = listeners.get(event)
      if (!set) { set = new Set(); listeners.set(event, set) }
      set.add(listener)
      return () => set?.delete(listener)
    },
    effect(setup: () => void | (() => void)) {
      const cleanup = setup()
      if (typeof cleanup === 'function') disposers.push(cleanup)
    },
    emit(event: string, ...args: unknown[]) {
      for (const listener of listeners.get(event) ?? []) listener(...args)
    },
    dispose() {
      for (const cleanup of disposers.splice(0)) cleanup()
    },
  }
}

describe('classifyToolCall', () => {
  it('classifies dedicated viewer, validation, skill, and image calls deterministically', () => {
    expect(classifyToolCall('viewer_analyze_surfaces', {})).toBe('regions')
    expect(classifyToolCall('validation_assembly', {})).toBe('collision')
    expect(classifyToolCall('validation_geometry', {})).toBe('fdm')
    expect(classifyToolCall('validation_fit', {})).toBe('fdm')
    expect(classifyToolCall('validation_mechanics', {})).toBe('mechanics')
    expect(classifyToolCall('viewer_controls', { action: 'prepare' })).toBe('controls')
    expect(classifyToolCall('viewer_camera', { azimuth: 45 })).toBe('look')
    expect(classifyToolCall('viewer_cursor_snapshot', {})).toBe('look')
    expect(classifyToolCall('viewer_load', { path: 'models/kart/model.usda' })).toBe('sculpt')
    expect(classifyToolCall('viewer_highlight', { regionId: 'roof' })).toBe('regions')
    expect(classifyToolCall('viewer_highlight', { blobs: [] })).toBe('look')
    expect(classifyToolCall('skill', { name: 'name-model-regions' })).toBe('regions')
    expect(classifyToolCall('skill', { name: 'fdm-design' })).toBe('fdm')
    expect(classifyToolCall('skill', { name: 'printable-joints' })).toBe('mechanics')
    expect(classifyToolCall('skill', { name: 'mesh-edit-controls' })).toBe('controls')
    expect(classifyToolCall('read_image', { path: 'artifacts/front_preview.png' })).toBe('look')
    expect(classifyToolCall('read_image', { path: 'artifacts/region_audit_roof.png' })).toBe('regions')
    expect(classifyToolCall('read_image', { path: 'artifacts/door_hinge_clearance.png' })).toBe('collision')
  })

  it('classifies Blender and Python bash commands while absorbing workspace plumbing', () => {
    expect(classifyToolCall('bash', { command: 'blender --background --python source/build_kart.py' })).toBe('sculpt')
    expect(classifyToolCall('bash', { command: 'blender --background --python source/render_views.py' })).toBe('look')
    expect(classifyToolCall('bash', { command: 'blender --background --python source/check_collision.py' })).toBe('collision')
    expect(classifyToolCall('bash', { command: 'blender --background --python validate.py' })).toBe('fdm')
    expect(classifyToolCall('bash', { command: 'blender --background --python source/hinge_sweep.py' })).toBe('mechanics')
    expect(classifyToolCall('bash', { command: 'blender --background --python source/map_regions.py' })).toBe('regions')
    expect(classifyToolCall('bash', { command: 'blender --background --python source/nose_field_controls.py' })).toBe('controls')
    expect(classifyToolCall('bash', { command: 'ls -la models/ && pwd' })).toBeNull()
    expect(classifyToolCall('bash', { command: 'mkdir -p .rumi/tmp && cp a b' })).toBeNull()
    expect(classifyToolCall('blender_status', {})).toBeNull()
    expect(classifyToolCall('viewer_working_model', { path: 'models/kart/model.usda' })).toBeNull()
    expect(classifyToolCall('glob', { pattern: '**/*.py' })).toBeNull()
  })

  it('classifies file edits by target role and tolerates malformed JSON arguments', () => {
    expect(classifyToolCall('write', '{"path":"models/kart/model.regions.json"}')).toBe('regions')
    expect(classifyToolCall('edit', { path: 'source/build_kart.py' })).toBe('sculpt')
    expect(classifyToolCall('write', { path: 'source/nose_controls.py' })).toBe('controls')
    expect(classifyToolCall('write', { path: 'source/render_preview.py' })).toBe('look')
    expect(classifyToolCall('bash', '{not-valid-json')).toBeNull()
    expect(classifyToolCall('', {})).toBeNull()
  })

  it('supports composing custom classifier rules ahead of defaults', () => {
    const customRule = ({ name }: { name: string }) => (name === 'custom_sensor' ? 'look' : null)
    expect(classifyToolCall('custom_sensor', {}, [customRule, ...DEFAULT_CLASSIFIER_RULES])).toBe('look')
    expect(classifyToolCall('validation_mechanics', {}, [customRule, ...DEFAULT_CLASSIFIER_RULES])).toBe('mechanics')
    expect(VIEWER_ACTIVITIES).toContain('sculpt')
    expect(VIEWER_ACTIVITIES).toContain('look')
  })
})

describe('createActivityTracker', () => {
  it('absorbs plumbing, coalesces rapid transitions via minDwellMs, and clears on idle/turn-end/dispose', () => {
    const ctx = createFakeContext()
    const notify = vi.fn()
    let clock = 1000
    const timers = new Map<ReturnType<typeof setTimeout>, { due: number; fn: () => void }>()
    let nextId = 1
    const tracker = createActivityTracker(ctx, {
      notify,
      minDwellMs: 900,
      now: () => clock,
      setTimer: (fn: () => void, ms?: number) => {
        const id = nextId++ as never
        timers.set(id, { due: clock + (ms ?? 0), fn })
        return id
      },
      clearTimer: (id?: ReturnType<typeof setTimeout>) => {
        if (id !== undefined) timers.delete(id)
      },
    })
    const flushTimers = (advanceTo: number) => {
      clock = advanceTo
      for (const [id, entry] of [...timers.entries()]) {
        if (entry.due <= clock) {
          timers.delete(id)
          entry.fn()
        }
      }
    }

    const session = { id: 'session-1' }
    const agent = { session }

    ctx.emit('agent/status', { agent, status: 'running' })
    expect(tracker.read('session-1')).toBeNull()

    // Plumbing before any classified stage stays null (viewer falls back to generic building).
    ctx.emit('session/event', session, { type: 'tool/call', data: { name: 'blender_status', arguments: '{}' } })
    expect(tracker.read('session-1')).toBeNull()

    // First classified stage publishes immediately.
    ctx.emit('session/event', session, { type: 'tool/call', data: { name: 'write', arguments: '{"path":"source/build.py"}' } })
    expect(tracker.read('session-1')).toBe('sculpt')
    expect(notify).toHaveBeenCalledTimes(1)

    // Plumbing during an active stage never flickers or clears it.
    clock += 100
    ctx.emit('session/event', session, { type: 'tool/call', data: { name: 'bash', arguments: '{"command":"ls -la"}' } })
    expect(tracker.read('session-1')).toBe('sculpt')
    expect(notify).toHaveBeenCalledTimes(1)

    // Rapid transitions within minDwellMs coalesce onto the latest stage.
    clock += 100
    ctx.emit('session/event', session, { type: 'tool/call', data: { name: 'read_image', arguments: '{"path":"artifacts/view.png"}' } })
    expect(tracker.read('session-1')).toBe('sculpt')
    clock += 100
    ctx.emit('session/event', session, { type: 'tool/call', data: { name: 'validation_assembly', arguments: '{}' } })
    expect(tracker.read('session-1')).toBe('sculpt')
    expect(timers.size).toBe(1)

    // After minDwellMs elapses, the latest coalesced stage commits once.
    flushTimers(1950)
    expect(tracker.read('session-1')).toBe('collision')
    expect(notify).toHaveBeenCalledTimes(2)

    // Turn end clears immediately and notifies.
    ctx.emit('session/event', session, { type: 'turn/end', data: {} })
    expect(tracker.read('session-1')).toBeNull()
    expect(notify).toHaveBeenCalledTimes(3)

    // Pending transition is cancelled cleanly if agent goes idle before dwell expires.
    ctx.emit('session/event', session, { type: 'tool/call', data: { name: 'validation_geometry', arguments: '{}' } })
    expect(tracker.read('session-1')).toBe('fdm')
    clock += 100
    ctx.emit('session/event', session, { type: 'tool/call', data: { name: 'viewer_analyze_surfaces', arguments: '{}' } })
    expect(timers.size).toBe(1)
    ctx.emit('agent/status', { agent, status: 'idle' })
    expect(tracker.read('session-1')).toBeNull()
    expect(timers.size).toBe(0)

    // Dispose cleans up active timers.
    ctx.emit('session/event', session, { type: 'tool/call', data: { name: 'validation_mechanics', arguments: '{}' } })
    clock += 100
    ctx.emit('session/event', session, { type: 'tool/call', data: { name: 'viewer_controls', arguments: '{}' } })
    expect(timers.size).toBe(1)
    ctx.dispose()
    expect(timers.size).toBe(0)
    expect(tracker.read('session-1')).toBeNull()
  })
})
