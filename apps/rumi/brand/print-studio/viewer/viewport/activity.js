/** One uniform-driven animation clock per visible viewport; idle viewers schedule no frames. */
import * as THREE from 'three'

/** Own the activity clock without allocating geometry or rendering hidden viewers.
 * @param {HTMLElement} element Observed viewport container.
 * @param {Function} render Draw the existing scene after changing uniforms.
 * @returns {object} Shared shader uniform, mode setter, and synchronous cleanup.
 */
export function createActivity(element, render) {
  const uniform = { value: new THREE.Vector2(0, 0.5) }
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)')
  let mode = 'idle', visible = false, frame = null, closed = false, last = -Infinity
  const modes = { idle: 0, building: 1, checking: 2 }
  const animated = () => mode !== 'idle' && visible && !document.hidden && !reduced.matches && !closed
  function tick(time) {
    frame = null
    if (!animated()) return
    if (time - last >= 1000 / 30) {
      last = time
      uniform.value.y = (time % 3200) / 3200
      render()
    }
    frame = requestAnimationFrame(tick)
  }
  function sync() {
    if (frame !== null) cancelAnimationFrame(frame)
    frame = null; last = -Infinity
    uniform.value.y = 0.5
    if (!closed && visible && !document.hidden) render()
    if (animated()) frame = requestAnimationFrame(tick)
  }
  const observer = new IntersectionObserver(entries => { visible = entries.some(entry => entry.isIntersecting); sync() })
  observer.observe(element)
  document.addEventListener('visibilitychange', sync)
  reduced.addEventListener('change', sync)
  return {
    uniform,
    get mode() { return mode },
    setMode(next) { if (closed || next === mode) return; mode = next; uniform.value.x = modes[next]; sync() },
    dispose() {
      closed = true
      if (frame !== null) cancelAnimationFrame(frame)
      observer.disconnect()
      document.removeEventListener('visibilitychange', sync)
      reduced.removeEventListener('change', sync)
    },
  }
}
