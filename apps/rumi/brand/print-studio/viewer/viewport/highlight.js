/** Viewer-owned Gaussian surface-to-wireframe treatment on temporary display copies. */
import * as THREE from 'three'
import { CURSOR_FALLOFF } from './cursor-geometry.js'
import { createSurfaceIndex, partPath } from './surfaces.js'

/**
 * Blend the model's shaded surface into teal fill and dark triangle edges before tone mapping.
 * @param {THREE.Object3D} root - Displayed design hierarchy; original resources are retained for restoration.
 * @param {object} highlight - Validated model-local Gaussian regions.
 * @param {object | null} hover - Shared world-space sphere uniform; null disables cursor reveal.
 * @param {object | null} activity Shared mode/phase uniform; null disables activity treatment.
 * @param {object} [editPick] Shared render-mode uniform for sampling a live edit.
 * @returns {object} Visibility, suspend/resume controls retaining prepared display resources, and a disposer restoring originals.
 */
export function createHighlight(root, highlight, hover = null, activity = null, editPick = { value: false }) {
  const activityUniform = activity ?? { value: new THREE.Vector2() }
  const activityBounds = { value: new THREE.Vector2() }
  const activityMin = { value: new THREE.Vector3() }
  const activitySize = { value: new THREE.Vector3(1, 1, 1) }
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, low = Infinity, high = -Infinity
  const enabled = { value: 1 }
  const entries = []
  const hoverSphere = hover?.sphere ?? hover ?? { value: new THREE.Vector4() }
  const inverses = Array.from({ length: 8 }, () => new THREE.Matrix4())
  const count = { value: 0 }
  let selection = null
  const agentModes = { patch: 0, surface: 1, part: 2, edge: 3 }
  function update(next) {
    selection = next.selection ?? null
    if (selection && entries.length && !entries.some(entry => JSON.stringify(selection.partPath) === JSON.stringify(partPath(entry.node, root))
      && entry.copy.userData.rumiSurfaceIndex.ids.includes(selection.surfaceId))) throw new Error('Cursor selection does not match this model revision')
    for (const entry of entries) updateSelection(entry)
    count.value = next.blobs.length
    next.blobs.forEach((blob, index) => inverses[index].compose(
      new THREE.Vector3(...blob.center),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(...blob.rotationDegrees.map(THREE.MathUtils.degToRad), 'XYZ')),
      new THREE.Vector3(...blob.radii),
    ).invert())
  }
  function updateSelection(entry) {
    entry.agentMesh.value = !selection || JSON.stringify(selection.partPath) === JSON.stringify(partPath(entry.node, root)) ? 1 : 0
    entry.agentSurface.value = selection?.surfaceId ?? -1
    entry.agentMode.value = selection ? agentModes[selection.mode] : -1
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
      const entry = { node, geometry, material, copy, materials: [], agentMesh: { value: 1 }, agentSurface: { value: -1 }, agentMode: { value: -1 } }
      updateSelection(entry)
      const spatial = createSurfaceIndex(copy)
      copy.userData.rumiSurfaceIndex = spatial
      copy.setAttribute('rumiSurface', new THREE.BufferAttribute(spatial.ids, 1))
      copy.setAttribute('rumiBoundary', new THREE.BufferAttribute(spatial.boundary, 3))
      entries.push(entry)
      const position = copy.getAttribute('position')
      const bary = new Float32Array(position.count * 3)
      const local = new Float32Array(position.count * 3)
      const matrix = unplace.clone().multiply(node.matrixWorld)
      const point = new THREE.Vector3()
      for (let i = 0; i < position.count; i++) {
        bary[i * 3 + i % 3] = 1
        point.fromBufferAttribute(position, i).applyMatrix4(matrix).toArray(local, i * 3)
        minX = Math.min(minX, point.x); maxX = Math.max(maxX, point.x)
        minY = Math.min(minY, point.y); maxY = Math.max(maxY, point.y)
        low = Math.min(low, point.z); high = Math.max(high, point.z)
      }
      copy.setAttribute('rumiBarycentric', new THREE.BufferAttribute(bary, 3))
      copy.setAttribute('rumiLocalPoint', new THREE.BufferAttribute(local, 3))
      copy.computeBoundingBox()
      copy.computeBoundingSphere()
      entry.materials = (Array.isArray(material) ? material : [material]).map(original => {
        const clone = original.clone()
        clone.onBeforeCompile = (shader, renderer) => {
          original.onBeforeCompile(shader, renderer)
          shader.uniforms.rumiActivity = activityUniform
          shader.uniforms.rumiActivityBounds = activityBounds
          shader.uniforms.rumiActivityMin = activityMin
          shader.uniforms.rumiActivitySize = activitySize
          shader.uniforms.rumiRegions = { value: inverses }
          shader.uniforms.rumiRegionCount = count
          shader.uniforms.rumiHover = hoverSphere
          shader.uniforms.rumiReveal = enabled
          shader.uniforms.rumiCursorMesh = hover?.mesh ?? { value: -1 }
          shader.uniforms.rumiCursorSurface = hover?.surface ?? { value: -1 }
          shader.uniforms.rumiCursorMode = hover?.mode ?? { value: 0 }
          shader.uniforms.rumiEditPick = editPick
          shader.uniforms.rumiMeshId = { value: node.id }
          shader.uniforms.rumiAgentMesh = entry.agentMesh
          shader.uniforms.rumiAgentSurface = entry.agentSurface
          shader.uniforms.rumiAgentMode = entry.agentMode
          shader.vertexShader = 'attribute float rumiSurface; attribute vec3 rumiBoundary; varying float rumiSurfaceId; varying vec3 rumiBorder; attribute vec3 rumiBarycentric; attribute vec3 rumiLocalPoint; varying vec3 rumiBary; varying vec3 rumiPoint; varying vec3 rumiWorldPoint;\n' + shader.vertexShader
          shader.vertexShader = shader.vertexShader.replace('#include <project_vertex>', '#include <project_vertex>\nrumiSurfaceId = rumiSurface; rumiBorder = rumiBoundary; rumiBary = rumiBarycentric; rumiPoint = rumiLocalPoint; rumiWorldPoint = (modelMatrix * vec4(transformed, 1.0)).xyz;')
          shader.fragmentShader = `uniform bool rumiEditPick; uniform vec2 rumiActivity, rumiActivityBounds; uniform vec3 rumiActivityMin, rumiActivitySize; uniform float rumiCursorMesh, rumiCursorSurface, rumiCursorMode, rumiMeshId, rumiAgentMesh, rumiAgentSurface, rumiAgentMode; varying float rumiSurfaceId; varying vec3 rumiBorder; uniform mat4 rumiRegions[8]; uniform int rumiRegionCount; uniform float rumiReveal; uniform vec4 rumiHover; varying vec3 rumiBary; varying vec3 rumiPoint; varying vec3 rumiWorldPoint;\n` + shader.fragmentShader
          shader.fragmentShader = shader.fragmentShader.replace('#include <alphatest_fragment>', `#include <alphatest_fragment>
            if (rumiEditPick) {
              if (diffuseColor.a <= 0.0) discard;
              gl_FragColor = vec4(rumiMeshId, rumiSurfaceId, distance(rumiWorldPoint, cameraPosition), 2.0);
              return;
            }`)
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
              cursorAmount = smoothstep(${CURSOR_FALLOFF.threshold}, 0.42, exp(-${CURSOR_FALLOFF.exponent} * dot(q, q)));
            }
            vec3 edges = smoothstep(vec3(0.0), fwidth(rumiBary) * 1.25, rumiBary);
            float edge = 1.0 - min(min(edges.x, edges.y), edges.z);
            vec3 borderEdges = (1.0 - smoothstep(vec3(0.0), fwidth(rumiBary) * 5.0, rumiBary)) * rumiBorder;
            float border = max(max(borderEdges.x, borderEdges.y), borderEdges.z);
            float sameSurface = abs(rumiSurfaceId - rumiCursorSurface) < 0.5 ? 1.0 : 0.0;
            if (rumiCursorMode == 1.0 || rumiCursorMode == 2.0) cursorAmount = rumiHover.w > 0.0 ? 0.85 : 0.0;
            if (rumiCursorMode != 2.0) cursorAmount *= sameSurface;
            if (rumiCursorMode == 3.0) cursorAmount *= border;
            cursorAmount *= abs(rumiCursorMesh - rumiMeshId) < 0.5 ? 1.0 : 0.0;
            if (rumiAgentMode >= 0.0) {
              if (rumiAgentMode == 1.0 || rumiAgentMode == 2.0) amount = 0.85 * rumiReveal;
              if (rumiAgentMode != 2.0) amount *= abs(rumiSurfaceId - rumiAgentSurface) < 0.5 ? 1.0 : 0.0;
              if (rumiAgentMode == 3.0) amount *= border;
              amount *= rumiAgentMesh;
            }
            // Linear-light colors belong to this viewer effect, independent of the app theme.
            vec3 underlying = mix(vec3(0.18, 0.40, 0.37), vec3(0.008, 0.05, 0.045), edge);
            outgoingLight = mix(outgoingLight, underlying, amount);
            if (rumiActivity.x > 0.5) {
              float phase = rumiActivity.y * 6.2831853;
              float level = clamp((rumiPoint.z - rumiActivityBounds.x) / max(rumiActivityBounds.y, 0.001), 0.0, 1.0);
              vec3 normPos = clamp((rumiPoint - rumiActivityMin) / rumiActivitySize, 0.0, 1.0);
              vec3 faceNormal = normalize(cross(dFdx(rumiWorldPoint), dFdy(rumiWorldPoint)));
              vec3 viewDir = normalize(cameraPosition - rumiWorldPoint);
              float rim = pow(1.0 - abs(dot(faceNormal, viewDir)), 3.0);
              if (rumiActivity.x < 1.5) {
                float wave = 0.5 + 0.5 * sin(level * 6.2831853 - phase);
                outgoingLight = mix(outgoingLight, vec3(0.12, 0.72, 0.60), 0.12 + 0.30 * wave * wave + 0.18 * rim);
              } else if (rumiActivity.x < 2.5) {
                float scanCenter = 0.5 - 0.5 * cos(phase);
                float scan = 1.0 - smoothstep(0.035, 0.18, abs(level - scanCenter));
                outgoingLight = mix(outgoingLight, vec3(0.12, 0.72, 0.60), 0.12 + scan * 0.55 + 0.12 * rim);
              } else if (rumiActivity.x < 3.5) {
                float diag = normPos.x * 0.35 + normPos.y * 0.65 + normPos.z * 0.95;
                float forgeWave = 0.5 + 0.5 * sin(diag * 7.5 - phase);
                float crest = pow(forgeWave, 4.0);
                vec3 forgeColor = mix(vec3(0.10, 0.44, 0.92), vec3(0.54, 0.86, 1.0), crest * 0.65 + rim * 0.35);
                outgoingLight = mix(outgoingLight, forgeColor, 0.12 + 0.34 * forgeWave * forgeWave + 0.24 * rim);
              } else if (rumiActivity.x < 4.5) {
                float bucket = mod(floor(rumiSurfaceId + 0.5) + mod(rumiMeshId, 17.0) * 3.0, 6.0);
                float activeBucket = rumiActivity.y * 6.0;
                float bDist = min(abs(bucket - activeBucket), 6.0 - abs(bucket - activeBucket));
                float partLit = 1.0 - smoothstep(0.18, 1.05, bDist);
                float luma = dot(outgoingLight, vec3(0.2126, 0.7152, 0.0722));
                vec3 calmBase = mix(outgoingLight, vec3(luma) * vec3(0.88, 0.90, 1.02), 0.38 * (1.0 - partLit));
                vec3 auraColor = mix(vec3(0.40, 0.24, 0.92), vec3(0.76, 0.64, 1.0), rim * 0.55);
                outgoingLight = mix(calmBase, auraColor, partLit * (0.36 + 0.32 * rim) + 0.10 * rim);
              } else if (rumiActivity.x < 5.5) {
                float luma = dot(outgoingLight, vec3(0.2126, 0.7152, 0.0722));
                vec3 shieldBase = mix(vec3(0.06, 0.16, 0.32), vec3(0.32, 0.68, 0.98), clamp(luma * 0.9 + rim * 0.75, 0.0, 1.0));
                float pulse = 0.5 + 0.5 * sin(phase * 2.0 - level * 5.0);
                float seamProximity = clamp(border * 0.85 + pow(1.0 - abs(dot(faceNormal, viewDir)), 1.6) * 0.18, 0.0, 1.0);
                vec3 shieldTint = mix(shieldBase, vec3(0.96, 0.54, 0.06), seamProximity * (0.42 + 0.45 * pulse));
                outgoingLight = mix(outgoingLight, shieldTint, 0.48 + 0.28 * rim + seamProximity * 0.24);
              } else if (rumiActivity.x < 6.5) {
                float frontier = rumiActivity.y;
                float below = smoothstep(frontier + 0.06, frontier - 0.06, level);
                float frontierBand = exp(-pow((level - frontier) / 0.075, 2.0));
                float layerRipple = 0.5 + 0.5 * sin(level * 44.0);
                float overhang = smoothstep(-0.28, -0.72, faceNormal.z);
                vec3 emTint = mix(vec3(0.06, 0.68, 0.44), vec3(0.45, 0.98, 0.76), frontierBand);
                outgoingLight = mix(outgoingLight, emTint, below * (0.12 + 0.14 * layerRipple) + frontierBand * 0.58 + 0.12 * rim);
                outgoingLight = mix(outgoingLight, vec3(0.94, 0.28, 0.08), overhang * (0.34 + 0.38 * below));
              } else if (rumiActivity.x < 7.5) {
                vec2 centered = normPos.xy - vec2(0.5);
                float angle = length(centered) > 0.0001 ? atan(centered.y, centered.x) : 0.0;
                float swirl = 0.5 + 0.5 * sin(angle * 2.0 + level * 4.0 - phase * 2.0);
                vec3 kineticColor = mix(vec3(0.05, 0.68, 0.74), vec3(0.48, 0.96, 0.92), rim * 0.55 + swirl * 0.35);
                outgoingLight = mix(outgoingLight, kineticColor, 0.14 + 0.24 * swirl + 0.30 * rim);
              } else if (rumiActivity.x < 8.5) {
                vec3 orbDir = normalize(vec3(cos(phase), sin(phase), 0.38));
                float keyDiff = max(dot(faceNormal, orbDir), 0.0);
                vec3 halfVec = normalize(orbDir + viewDir);
                float keySpec = pow(max(dot(faceNormal, halfVec), 0.0), 14.0);
                float align = clamp(0.5 + dot(normalize(vec3(normPos.xy - vec2(0.5), 0.001)), orbDir) * 0.5, 0.0, 1.0);
                vec3 litBase = outgoingLight * (0.64 + 0.52 * keyDiff);
                float bloom = clamp(keySpec * 0.65 + keyDiff * align * 0.34 + rim * align * 0.42, 0.0, 0.85);
                outgoingLight = mix(litBase, vec3(0.32, 0.76, 1.0), bloom);
              } else {
                float distCenter = length(normPos - vec3(0.5));
                float focusMask = rumiRegionCount > 0 ? smoothstep(0.04, 0.45, field) : exp(-2.2 * distCenter * distCenter);
                float ringWave = 0.5 + 0.5 * sin(distCenter * 18.0 - phase * 2.0);
                vec3 roseColor = mix(vec3(0.90, 0.20, 0.42), vec3(1.0, 0.64, 0.76), ringWave * 0.45 + rim * 0.4);
                outgoingLight = mix(outgoingLight, roseColor, 0.08 + focusMask * (0.28 + 0.32 * ringWave) + 0.20 * rim);
              }
            }
            vec3 cursorColor = vec3(0.48, 0.65, 0.86);
            outgoingLight = mix(outgoingLight, cursorColor, 0.62 * cursorAmount * (1.0 - step(0.01, amount)));
            #include <opaque_fragment>`)
        }
        clone.customProgramCacheKey = () => `${original.customProgramCacheKey()}:rumi-highlight:activity-5`
        return clone
      })
      node.geometry = copy
      node.material = Array.isArray(material) ? entry.materials : entry.materials[0]
    })
    if (!Number.isFinite(low)) { low = 0; high = 0; minX = 0; maxX = 0; minY = 0; maxY = 0 }
    activityBounds.value.set(low, Math.max(high - low, 0.001))
    activityMin.value.set(minX, minY, low)
    activitySize.value.set(Math.max(maxX - minX, 0.001), Math.max(maxY - minY, 0.001), Math.max(high - low, 0.001))
    update(highlight)
  } catch (error) {
    dispose()
    throw error
  }
  return {
    update,
    setVisible(visible) { enabled.value = visible ? 1 : 0 },
    suspend() {
      for (const entry of entries) { entry.node.geometry = entry.geometry; entry.node.material = entry.material }
    },
    resume() {
      for (const entry of entries) {
        entry.node.geometry = entry.copy
        entry.node.material = Array.isArray(entry.material) ? entry.materials : entry.materials[0]
      }
    },
    dispose,
  }
}
