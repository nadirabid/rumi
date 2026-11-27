/** One uniform-driven animation clock per visible viewport; idle viewers schedule no frames. */
import * as THREE from 'three'

/** Canonical shader mode indices shared by the activity clock and mesh highlight shader. */
export const ACTIVITY_MODES = Object.freeze({
  idle: 0,
  building: 1,
  checking: 2,
  sculpt: 3,
  regions: 4,
  collision: 5,
  fdm: 6,
  mechanics: 7,
  look: 8,
  controls: 9,
})

/** Own the activity clock without allocating geometry or rendering hidden viewers.
 * @param {HTMLElement} element Observed viewport container.
 * @param {Function} render Draw the existing scene after changing uniforms.
 * @returns {object} Shared shader uniform, mode setter, and synchronous cleanup.
 */
export function createActivity(element, render) {
  const uniform = { value: new THREE.Vector2(0, 0.5) }
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)')
  let mode = 'idle', visible = false, frame = null, closed = false, last = -Infinity
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
    setMode(next) {
      const resolved = Object.hasOwn(ACTIVITY_MODES, next) ? next : 'building'
      if (closed || resolved === mode) return
      mode = resolved
      uniform.value.x = ACTIVITY_MODES[resolved]
      sync()
    },
    dispose() {
      closed = true
      if (frame !== null) cancelAnimationFrame(frame)
      observer.disconnect()
      document.removeEventListener('visibilitychange', sync)
      reduced.removeEventListener('change', sync)
    },
  }
}
