/** Print-layout interaction controller: plate previews, part dragging, undo stack, and plate export. */
import * as THREE from 'three'
import { arrangePrintParts, createPrintPreview, layoutIssues, printParts } from './print-layout.js'
import { printLayoutIdentity } from '../print-layout/state.js'

/**
 * Own print-layout preview state and canvas drag gestures for a Three.js viewport.
 * @param {object} host Viewport hooks and shared Three.js objects.
 * @returns {object} Print layout lifecycle and editing operations.
 */
export function createPrintController(host) {
  let preview = null, parts = null, layout = null, plate = 0, selected = null, drag = null, frameId = null
  const undoStack = []
  const ray = new THREE.Raycaster()
  const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0)

  const snapshot = () => ({
    active: Boolean(preview),
    manufacturingMode: host.getDesign()?.robot?.assembly?.manufacturing.mode ?? null,
    layout: layout ? structuredClone(layout) : null,
    plate,
    selected,
    parts: parts?.map(part => ({ id: part.id, name: part.name })) ?? [],
    issues: layout && parts ? layoutIssues(parts, layout) : [],
    canUndo: undoStack.length > 0,
  })
  const publish = () => host.onPrintLayout(snapshot())
  const draw = () => { preview.apply(layout, plate, selected); host.render() }

  function intersectPoint(event) {
    const rect = host.renderer.domElement.getBoundingClientRect()
    ray.setFromCamera(new THREE.Vector2((event.clientX - rect.left) / rect.width * 2 - 1, 1 - (event.clientY - rect.top) / rect.height * 2), host.camera)
    return ray.ray.intersectPlane(plane, new THREE.Vector3())
  }

  function onDown(event) {
    if (host.activity.mode !== 'idle' || !preview || drag || event.button !== 0) return
    const point = intersectPoint(event)
    const hit = ray.intersectObjects(preview.root.children.filter(node => node.visible), true)[0]
    if (!hit || !point) return
    let node = hit.object
    while (node && !node.userData.printPart) node = node.parent
    if (!node) return
    selected = node.userData.printPart
    const placement = layout.parts.find(part => part.id === selected)
    drag = { pointerId: event.pointerId, origin: point, position: [...placement.position], previous: structuredClone(layout) }
    host.controls.enabled = false
    host.renderer.domElement.setPointerCapture(event.pointerId)
    event.stopImmediatePropagation()
    publish()
  }

  function onMove(event) {
    if (!drag || event.pointerId !== drag.pointerId) return
    const point = intersectPoint(event)
    if (!point) return
    const placement = layout.parts.find(part => part.id === selected)
    placement.position = [drag.position[0] + point.x - drag.origin.x, drag.position[1] + point.y - drag.origin.y]
    if (frameId === null) {
      frameId = requestAnimationFrame(() => {
        frameId = null
        if (!host.isClosed() && preview) draw()
      })
    }
    event.stopImmediatePropagation()
  }

  function onUp(event) {
    if (!drag || event.pointerId !== drag.pointerId) return
    if (frameId !== null) cancelAnimationFrame(frameId)
    frameId = null
    if (event.type !== 'pointerup') layout = drag.previous
    else { undoStack.push(drag.previous); if (undoStack.length > 32) undoStack.shift() }
    drag = null
    host.controls.enabled = true
    if (host.renderer.domElement.hasPointerCapture(event.pointerId)) host.renderer.domElement.releasePointerCapture(event.pointerId)
    draw()
    publish()
    event.stopImmediatePropagation()
  }

  const listeners = [['pointerdown', onDown], ['pointermove', onMove], ['pointerup', onUp], ['pointercancel', onUp], ['lostpointercapture', onUp]]
  for (const [name, listener] of listeners) host.renderer.domElement.addEventListener(name, listener, true)

  function clear(forget = false, restore = true) {
    if (frameId !== null) cancelAnimationFrame(frameId)
    frameId = null
    preview?.dispose(); preview = null
    host.designRoot.visible = true
    const pointerId = drag?.pointerId
    if (drag) layout = drag.previous
    drag = null
    if (pointerId !== undefined && host.renderer.domElement.hasPointerCapture(pointerId)) host.renderer.domElement.releasePointerCapture(pointerId)
    if (host.controls) host.controls.enabled = true
    if (forget) { parts = null; layout = null; undoStack.length = 0; selected = null; plate = 0 }
    if (restore) {
      host.onRestoreVolume()
      publish()
    }
  }

  return {
    get active() { return Boolean(preview) },
    get root() { return preview?.root ?? null },
    get layout() { return layout },
    snapshot,
    clear,
    cancelDrag() {
      if (drag) onUp({ type: 'pointercancel', pointerId: drag.pointerId, stopImmediatePropagation() {} })
    },
    open(saved, options) {
      const design = host.getDesign()
      const spec = host.getDesignSpec()
      if (host.activity.mode !== 'idle' || !design || host.getDesignUrl() !== spec?.url || host.hasShape() || host.hasObjects()) {
        throw new Error('Load a canonical model and finish editing before arranging')
      }
      host.onBeforeOpen()
      try {
        if (!parts) parts = printParts(design)
        const identity = printLayoutIdentity(spec, options.volume)
        const candidate = saved ?? layout ?? arrangePrintParts(parts, { ...options, identity })
        if (candidate.identity !== identity) throw new Error('Print layout belongs to another model revision')
        const next = createPrintPreview(parts, host.scene, host.solidMaterial.color)
        try { next.apply(candidate, plate) } catch (error) { next.dispose(); throw error }
        preview?.dispose(); preview = next; layout = structuredClone(candidate)
        selected = layout.parts[0].id
        host.designRoot.visible = false
        host.setVolume(options.volume)
        host.hover.clear()
        host.frame()
        draw()
        publish()
        return snapshot()
      } catch (error) {
        host.onOpenFailed()
        throw error
      }
    },
    selectPart(id) {
      selected = id
      plate = layout.parts.find(part => part.id === id).plate
      draw()
      publish()
    },
    selectPlate(nextPlate) {
      plate = nextPlate
      selected = layout.parts.find(part => part.plate === nextPlate)?.id ?? selected
      draw()
      publish()
    },
    editPart(change) {
      if (host.activity.mode !== 'idle' || !preview || !selected) return
      const next = structuredClone(layout), part = next.parts.find(item => item.id === selected)
      if (change.move) part.position = part.position.map((n, i) => n + change.move[i])
      if (change.rotate !== undefined) part.rotation[change.rotate] = (part.rotation[change.rotate] + 90) % 360
      if (change.plate !== undefined) { part.plate = change.plate; plate = change.plate }
      preview.apply(next, plate, selected)
      undoStack.push(layout); if (undoStack.length > 32) undoStack.shift()
      layout = next
      host.render()
      publish()
    },
    rearrange(options) {
      if (host.activity.mode !== 'idle') return
      const next = arrangePrintParts(parts, { ...options, identity: layout.identity })
      undoStack.push(layout); if (undoStack.length > 32) undoStack.shift()
      layout = next; plate = 0
      draw()
      publish()
    },
    undo() {
      if (host.activity.mode === 'idle' && undoStack.length) {
        layout = undoStack.pop(); plate = 0
        draw()
        publish()
      }
    },
    exportPlate() {
      if (host.activity.mode !== 'idle') throw new Error('Model work is in progress')
      return preview.exportPlate()
    },
    dispose() {
      clear(true, false)
      for (const [name, listener] of listeners) host.renderer.domElement.removeEventListener(name, listener, true)
    },
  }
}
