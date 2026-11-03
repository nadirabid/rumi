/** Viewer-owned Gaussian surface-to-wireframe treatment on temporary display copies. */
import * as THREE from 'three'

/**
 * Blend the model's shaded surface into teal fill and dark triangle edges before tone mapping.
 * @param {THREE.Object3D} root - Displayed design hierarchy; original resources are retained for restoration.
 * @param {object} highlight - Validated model-local Gaussian regions.
 * @returns {object} Visibility control and disposer restoring the original resources.
 */
export function createHighlight(root, highlight) {
  const enabled = { value: 1 }
  const entries = []
  const inverses = highlight.blobs.map(blob => new THREE.Matrix4().compose(
    new THREE.Vector3(...blob.center),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(...blob.rotationDegrees.map(THREE.MathUtils.degToRad), 'XYZ')),
    new THREE.Vector3(...blob.radii),
  ).invert())
  root.updateWorldMatrix(true, true)
  const unplace = root.parent ? root.parent.matrixWorld.clone().invert() : new THREE.Matrix4()
  const dispose = () => {
    for (const entry of entries.splice(0)) {
      entry.node.geometry = entry.geometry
      entry.node.material = entry.material
      entry.copy.dispose()
      for (const material of entry.materials) material.dispose()
    }
  }
  try {
    root.traverse(node => {
      if (!node.isMesh) return
      const geometry = node.geometry
      const material = node.material
      const copy = geometry.index ? geometry.toNonIndexed() : geometry.clone()
      const entry = { node, geometry, material, copy, materials: [] }
      entries.push(entry)
      const position = copy.getAttribute('position')
      const bary = new Float32Array(position.count * 3)
      const local = new Float32Array(position.count * 3)
      const matrix = unplace.clone().multiply(node.matrixWorld)
      const point = new THREE.Vector3()
      for (let i = 0; i < position.count; i++) {
        bary[i * 3 + i % 3] = 1
        point.fromBufferAttribute(position, i).applyMatrix4(matrix).toArray(local, i * 3)
      }
      copy.setAttribute('rumiBarycentric', new THREE.BufferAttribute(bary, 3))
      copy.setAttribute('rumiLocalPoint', new THREE.BufferAttribute(local, 3))
      entry.materials = (Array.isArray(material) ? material : [material]).map(original => {
        const clone = original.clone()
        clone.onBeforeCompile = (shader, renderer) => {
          original.onBeforeCompile(shader, renderer)
          shader.uniforms.rumiRegions = { value: inverses }
          shader.uniforms.rumiReveal = enabled
          shader.vertexShader = 'attribute vec3 rumiBarycentric; attribute vec3 rumiLocalPoint; varying vec3 rumiBary; varying vec3 rumiPoint;\n' + shader.vertexShader
          shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\nrumiBary = rumiBarycentric; rumiPoint = rumiLocalPoint;')
          shader.fragmentShader = `uniform mat4 rumiRegions[${inverses.length}]; uniform float rumiReveal; varying vec3 rumiBary; varying vec3 rumiPoint;\n` + shader.fragmentShader
          shader.fragmentShader = shader.fragmentShader.replace('#include <opaque_fragment>', `
            float field = 0.0;
            for (int i = 0; i < ${inverses.length}; i++) {
              vec3 q = (rumiRegions[i] * vec4(rumiPoint, 1.0)).xyz;
              field = max(field, exp(-1.5 * dot(q, q)));
            }
            float amount = smoothstep(0.08, 0.42, field) * rumiReveal;
            vec3 edges = smoothstep(vec3(0.0), fwidth(rumiBary) * 1.25, rumiBary);
            float edge = 1.0 - min(min(edges.x, edges.y), edges.z);
            // Linear-light colors belong to this viewer effect, independent of the app theme.
            vec3 underlying = mix(vec3(0.18, 0.40, 0.37), vec3(0.008, 0.05, 0.045), edge);
            outgoingLight = mix(outgoingLight, underlying, amount);
            #include <opaque_fragment>`)
        }
        clone.customProgramCacheKey = () => `${original.customProgramCacheKey()}:rumi-highlight:${inverses.length}`
        return clone
      })
      node.geometry = copy
      node.material = Array.isArray(material) ? entry.materials : entry.materials[0]
    })
  } catch (error) {
    dispose()
    throw error
  }
  return { setVisible(visible) { enabled.value = visible ? 1 : 0 }, dispose }
}
