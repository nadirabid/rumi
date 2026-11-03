/** Viewer-owned Gaussian surface-to-wireframe treatment on temporary display copies. */
import * as THREE from 'three'

/**
 * Blend the model's shaded surface into teal fill and dark triangle edges before tone mapping.
 * @param {THREE.Object3D} root - Displayed design hierarchy; original resources are retained for restoration.
 * @param {object} highlight - Validated model-local Gaussian regions.
 * @param {object | null} hover - Shared world-space sphere uniform; null disables cursor reveal.
 * @returns {object} Visibility control and disposer restoring the original resources.
 */
export function createHighlight(root, highlight, hover = null) {
  const enabled = { value: 1 }
  const entries = []
  const hoverSphere = hover ?? { value: new THREE.Vector4() }
  const inverses = Array.from({ length: 8 }, () => new THREE.Matrix4())
  const count = { value: 0 }
  function update(next) {
    count.value = next.blobs.length
    next.blobs.forEach((blob, index) => inverses[index].compose(
      new THREE.Vector3(...blob.center),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(...blob.rotationDegrees.map(THREE.MathUtils.degToRad), 'XYZ')),
      new THREE.Vector3(...blob.radii),
    ).invert())
  }
  update(highlight)
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
      copy.computeBoundingBox()
      copy.computeBoundingSphere()
      entry.materials = (Array.isArray(material) ? material : [material]).map(original => {
        const clone = original.clone()
        clone.onBeforeCompile = (shader, renderer) => {
          original.onBeforeCompile(shader, renderer)
          shader.uniforms.rumiRegions = { value: inverses }
          shader.uniforms.rumiRegionCount = count
          shader.uniforms.rumiHover = hoverSphere
          shader.uniforms.rumiReveal = enabled
          shader.vertexShader = 'attribute vec3 rumiBarycentric; attribute vec3 rumiLocalPoint; varying vec3 rumiBary; varying vec3 rumiPoint; varying vec3 rumiWorldPoint;\n' + shader.vertexShader
          shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\nrumiBary = rumiBarycentric; rumiPoint = rumiLocalPoint; rumiWorldPoint = (modelMatrix * vec4(position, 1.0)).xyz;')
          shader.fragmentShader = `uniform mat4 rumiRegions[8]; uniform int rumiRegionCount; uniform float rumiReveal; uniform vec4 rumiHover; varying vec3 rumiBary; varying vec3 rumiPoint; varying vec3 rumiWorldPoint;\n` + shader.fragmentShader
          shader.fragmentShader = shader.fragmentShader.replace('#include <opaque_fragment>', `
            float field = 0.0;
            for (int i = 0; i < 8; i++) {
              if (i >= rumiRegionCount) break;
              vec3 q = (rumiRegions[i] * vec4(rumiPoint, 1.0)).xyz;
              field = max(field, exp(-1.5 * dot(q, q)));
            }
            float amount = smoothstep(0.08, 0.42, field) * rumiReveal;
            float cursorAmount = 0.0;
            if (rumiHover.w > 0.0) {
              vec3 q = (rumiWorldPoint - rumiHover.xyz) / rumiHover.w;
              cursorAmount = smoothstep(0.08, 0.42, exp(-1.5 * dot(q, q)));
            }
            vec3 edges = smoothstep(vec3(0.0), fwidth(rumiBary) * 1.25, rumiBary);
            float edge = 1.0 - min(min(edges.x, edges.y), edges.z);
            // Linear-light colors belong to this viewer effect, independent of the app theme.
            vec3 underlying = mix(vec3(0.18, 0.40, 0.37), vec3(0.008, 0.05, 0.045), edge);
            outgoingLight = mix(outgoingLight, underlying, amount);
            vec3 cursorColor = mix(vec3(0.12, 0.32, 0.75), vec3(0.005, 0.025, 0.12), edge);
            outgoingLight = mix(outgoingLight, cursorColor, cursorAmount);
            #include <opaque_fragment>`)
        }
        clone.customProgramCacheKey = () => `${original.customProgramCacheKey()}:rumi-highlight:8`
        return clone
      })
      node.geometry = copy
      node.material = Array.isArray(material) ? entry.materials : entry.materials[0]
    })
  } catch (error) {
    dispose()
    throw error
  }
  return { update, setVisible(visible) { enabled.value = visible ? 1 : 0 }, dispose }
}
