/** Actual-mesh displacement measurements used alongside rendered control comparisons. */
import * as THREE from 'three'
import { createFieldPreview } from './field-preview.js'
import { createSurfacePreview } from './surface.js'
import { deformPoint, cutPlane } from './spec.js'

/** Capture visible surface vertices. @param {object} root Owned model. @param {object} spec Validated recipe. @param {object|null} values Values to apply, or null for the original. @returns {object[]} Model-local millimetre samples including part transforms. */
export function meshSamples(root, spec, values) {
  let preview
  try {
    if (values && spec.operation === 'fields') { preview = createFieldPreview(root, spec); preview.update(values) }
    else if (values && spec.operation === 'surface') { preview = createSurfacePreview(root, spec); preview.update(values) }
    root.updateWorldMatrix(true, true)
    const samples = []
    root.traverseVisible(node => {
      if (!node.isMesh) return
      const selected = !spec.parts.length || spec.parts.includes(node.name)
      const points = [], attribute = node.geometry.getAttribute('position')
      for (let i = 0; i < attribute.count; i++) {
        let point = new THREE.Vector3().fromBufferAttribute(attribute, i).applyMatrix4(node.matrixWorld).toArray()
        if (values && selected && !['fields', 'surface', 'cut'].includes(spec.operation)) point = deformPoint(point, { ...spec, values })
        points.push(point)
      }
      samples.push({ node, selected, points })
    })
    return samples
  } finally { preview?.dispose() }
}

/** Compare surfaces; cut reports removal rather than displacement. @param {object} root Owned model. @param {object} spec Validated recipe. @param {object} test Baseline and endpoint values. @returns {object} Surface samples and displacement measurements. */
export function measureControlCase(root, spec, test) {
  const before = meshSamples(root, spec, test.baseline), after = meshSamples(root, spec, test.values)
  if (spec.operation === 'surface') {
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3()
    const normal = (points, ids) => {
      a.fromArray(points[ids[0]]); b.fromArray(points[ids[1]]); c.fromArray(points[ids[2]])
      return b.sub(a).cross(c.sub(a)).clone()
    }
    for (let m = 0; m < before.length; m++) {
      if (!before[m].selected) continue
      const index = before[m].node.geometry.index
      for (let i = 0; i < (index?.count ?? before[m].points.length); i += 3) {
        const ids = [0, 1, 2].map(j => index ? index.getX(i + j) : i + j)
        const original = normal(before[m].points, ids), changed = normal(after[m].points, ids)
        // Below this area, Float32 export noise dominates orientation.
        if (original.length() <= .0001) continue
        if (changed.length() <= .00001 || original.dot(changed) <= 0) {
          throw new Error(`Surface controls collapse or invert a triangle in ${before[m].node.name}; reduce the range, protect this region, or repair the source mesh before validating again`)
        }
      }
    }
  }
  const plane = spec.operation === 'cut' ? cutPlane({ ...spec, values: test.values }) : null
  let count = 0, affected = 0, sum = 0, max = 0
  const meshes = after.map((item, index) => {
    const distances = item.points.map((point, vertex) => {
      const d = plane ? (item.selected && point.reduce((s, p, i) => s + p * plane.normal[i], plane.constant) < 0 ? 1 : 0)
        : Math.hypot(...point.map((p, i) => p - before[index].points[vertex][i]))
      if (!Number.isFinite(d)) throw new Error('Control produced non-finite geometry')
      count++; if (d > 1e-6) affected++
      sum += d * d; max = Math.max(max, d)
      return d
    })
    return { ...item, distances }
  })
  if (!count) throw new Error('Control validation requires visible mesh vertices')
  return { meshes, metrics: { maxDisplacementMm: plane ? 0 : max, rmsDisplacementMm: plane ? 0 : Math.sqrt(sum / count), affectedFraction: affected / count,
    ...(plane ? { measurement: 'removed vertices', removedFraction: affected / count } : {}),
    warning: affected === 0 ? 'No surface vertices changed in this case.' : null } }
}
