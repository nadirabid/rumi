import * as React from 'react'

const SVG_NS = 'http://www.w3.org/2000/svg'
let lensCount = 0

/**
 * Give a glass element a rounded-rectangle refraction SVG filter exposed as `--rumi-lens`.
 * Without a 2D canvas or a size the element retains its plain CSS blur fallback.
 */
export function lens(element: HTMLElement, blur: number): () => void {
  const width = Math.round(element.offsetWidth)
  const height = Math.round(element.offsetHeight)
  if (!width || !height) return () => {}
  const radius = Math.min(parseFloat(getComputedStyle(element).borderRadius) || 0, width / 2, height / 2)
  const bevel = Math.min(11, radius, height / 2)
  const render = () => {
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d')
    if (!context) return null
    const image = context.createImageData(width, height)
    const data = image.data
    const halfX = width / 2 - radius
    const halfY = height / 2 - radius
    for (let j = 0; j < height; j++) {
      for (let i = 0; i < width; i++) {
        const px = i + 0.5 - width / 2
        const py = j + 0.5 - height / 2
        const qx = Math.abs(px) - halfX
        const qy = Math.abs(py) - halfY
        let nx = 0
        let ny = 0
        let distance: number
        if (qx > 0 && qy > 0) {
          const length = Math.hypot(qx, qy) || 1
          distance = length - radius
          nx = qx / length
          ny = qy / length
        } else if (qx > qy) {
          distance = qx - radius
          nx = 1
        } else {
          distance = qy - radius
          ny = 1
        }
        nx *= Math.sign(px) || 1
        ny *= Math.sign(py) || 1
        const t = Math.max(0, 1 + distance / bevel)
        const strength = t * t * t
        const offset = (j * width + i) * 4
        data[offset] = 128 - nx * strength * 127
        data[offset + 1] = 128 - ny * strength * 127
        data[offset + 2] = 128
        data[offset + 3] = 255
      }
    }
    context.putImageData(image, 0, 0)
    return canvas.toDataURL()
  }
  let url: string | null = null
  try {
    url = render()
  } catch {
    // Canvas refused to draw or export; CSS blur fallback applies.
  }
  if (url === null) return () => {}
  const id = `rumi-lens-${lensCount++}`
  const host = document.createElementNS(SVG_NS, 'svg')
  host.setAttribute('width', '0')
  host.setAttribute('height', '0')
  host.setAttribute('aria-hidden', 'true')
  host.style.position = 'absolute'
  const filter = document.createElementNS(SVG_NS, 'filter')
  filter.setAttribute('id', id)
  filter.setAttribute('x', '0')
  filter.setAttribute('y', '0')
  filter.setAttribute('width', '100%')
  filter.setAttribute('height', '100%')
  filter.setAttribute('color-interpolation-filters', 'sRGB')
  filter.innerHTML = `<feGaussianBlur in="SourceGraphic" stdDeviation="${blur}" result="b"/><feImage href="${url}" x="0" y="0" width="${width}" height="${height}" preserveAspectRatio="none" result="m"/><feDisplacementMap in="b" in2="m" scale="${bevel * 2}" xChannelSelector="R" yChannelSelector="G"/>`
  const defs = document.createElementNS(SVG_NS, 'defs')
  defs.append(filter)
  host.append(defs)
  document.body.append(host)
  element.style.setProperty('--rumi-lens', `url(#${id})`)
  return () => {
    host.remove()
    element.style.removeProperty('--rumi-lens')
  }
}

/** Apply `lens` to `ref` for as long as the element stays mounted. */
export function useLens(ref: React.RefObject<HTMLElement | null>, blur: number): void {
  React.useLayoutEffect(() => (ref.current ? lens(ref.current, blur) : undefined), [ref, blur])
}
