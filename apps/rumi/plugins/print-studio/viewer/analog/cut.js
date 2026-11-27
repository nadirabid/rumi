/** GPU half-space clipping with stencil cross-sections; input geometry stays untouched. */
import * as THREE from 'three'
import { cutPlane } from './spec.js'

/** Mount an adjustable, capped cut in model millimetres. @param {THREE.Object3D} root Loaded model under its placement root. @param {object} spec Validated cut recipe. @returns {object} Uniform-only update and owned-resource disposal. */
export function createCutPreview(root, spec) {
  const plane = { value: new THREE.Vector4() }, guide = { value: spec.frozen ? 0 : 1 }
  const entries = [], caps = [], materials = []
  const display = new THREE.Group()
  const parent = root.parent ?? root
  root.updateWorldMatrix(true, true)
  const inverse = parent.matrixWorld.clone().invert()
  const nodes = []
  root.traverseVisible(node => {
    if (node.isMesh && (!spec.parts.length || spec.parts.includes(node.name))) nodes.push(node)
  })
  if (!nodes.length) throw new Error('No visible mesh matches the cut parts')
  const capGeometry = new THREE.PlaneGeometry(1, 1)
  function clip(material, matrix, showGuide = false) {
    const original = material.onBeforeCompile, key = material.customProgramCacheKey()
    material.onBeforeCompile = (shader, renderer) => {
      original.call(material, shader, renderer)
      shader.uniforms.rumiCutPlane = plane
      shader.uniforms.rumiCutGuide = guide
      shader.uniforms.rumiCutToModel = { value: matrix }
      shader.vertexShader = 'uniform mat4 rumiCutToModel; varying vec3 rumiCutPoint;\n' + shader.vertexShader
      shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\nrumiCutPoint = (rumiCutToModel * vec4(position, 1.)).xyz;')
      shader.fragmentShader = 'uniform vec4 rumiCutPlane; uniform float rumiCutGuide; varying vec3 rumiCutPoint;\n' + shader.fragmentShader
      shader.fragmentShader = shader.fragmentShader.replace('#include <clipping_planes_fragment>', '#include <clipping_planes_fragment>\nif(dot(rumiCutPlane.xyz, rumiCutPoint) + rumiCutPlane.w < 0.) discard;')
      if (showGuide) shader.fragmentShader = shader.fragmentShader.replace('#include <opaque_fragment>', `
        float cutDistance = dot(rumiCutPlane.xyz, rumiCutPoint) + rumiCutPlane.w;
        float cutWidth = max(fwidth(cutDistance) * 2.0, 0.15);
        float cutLine = (1.0 - smoothstep(cutWidth, cutWidth * 2.0, cutDistance)) * rumiCutGuide;
        outgoingLight = mix(outgoingLight, vec3(0.04, 0.65, 0.48), cutLine);
        #include <opaque_fragment>`)

    }
    material.customProgramCacheKey = () => key + ':rumi-cut-v2:' + showGuide
    materials.push(material)
    return material
  }
  const dispose = () => {
    display.removeFromParent()
    for (const entry of entries) entry.node.material = entry.source
    for (const material of materials) material.dispose()
    capGeometry.dispose()
  }
  try {
    nodes.forEach((node, index) => {
      const matrix = inverse.clone().multiply(node.matrixWorld), source = node.material
      const originals = Array.isArray(source) ? source : [source]
      const copies = originals.map(original => {
        const copy = original.clone()
        copy.onBeforeCompile = original.onBeforeCompile
        copy.customProgramCacheKey = original.customProgramCacheKey.bind(original)
        return clip(copy, matrix, true)
      })
      entries.push({ node, source })
      node.material = Array.isArray(source) ? copies : copies[0]
      const order = index * 3 + 10
      for (const [side, operation] of [[THREE.BackSide, THREE.IncrementWrapStencilOp], [THREE.FrontSide, THREE.DecrementWrapStencilOp]]) {
        const mask = clip(new THREE.MeshBasicMaterial({ side, depthTest: false, depthWrite: false, colorWrite: false,
          stencilWrite: true, stencilFunc: THREE.AlwaysStencilFunc, stencilFail: operation, stencilZFail: operation, stencilZPass: operation }), matrix)
        const mesh = new THREE.Mesh(node.geometry, mask)
        mesh.matrixAutoUpdate = false; mesh.matrix.copy(matrix); mesh.frustumCulled = false; mesh.renderOrder = order
        display.add(mesh)
      }
      const base = originals[0]
      const surface = new THREE.MeshStandardMaterial({ color: base.color, metalness: base.metalness ?? 0, roughness: base.roughness ?? .5,
        side: THREE.DoubleSide, stencilWrite: true, stencilRef: 0, stencilFunc: THREE.NotEqualStencilFunc,
        stencilFail: THREE.ReplaceStencilOp, stencilZFail: THREE.ReplaceStencilOp, stencilZPass: THREE.ReplaceStencilOp })
      materials.push(surface)
      const cap = new THREE.Mesh(capGeometry, surface)
      node.geometry.computeBoundingBox()
      const bounds = node.geometry.boundingBox.clone().applyMatrix4(matrix)
      const size = bounds.getSize(new THREE.Vector3()).length() + bounds.getCenter(new THREE.Vector3()).distanceTo(new THREE.Vector3(...spec.center)) + spec.limit
      cap.scale.setScalar(size * 4); cap.frustumCulled = false; cap.renderOrder = order + 1
      cap.onAfterRender = renderer => renderer.clearStencil()
      caps.push(cap); display.add(cap)
    })
    parent.add(display)
    function update(values) {
      const next = cutPlane({ ...spec, values })
      plane.value.set(...next.normal, next.constant)
      const outward = new THREE.Vector3(...next.normal).negate()
      for (const cap of caps) {
        cap.position.fromArray(next.point)
        cap.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), outward)
      }
    }
    update(spec.values)
    return { update, setGuideVisible(visible) { guide.value = visible ? 1 : 0 }, dispose }
  } catch (error) { dispose(); throw error }
}
