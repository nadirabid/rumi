/** Owned preview geometry for data-only model-specific deformations. */
import * as THREE from 'three'
import { sampleField } from './fields.js'
import { controlValues } from './control-spec.js'

/** Attach a reversible field preview. @param {object} root Saved model. @param {object} spec Validated field recipe. @returns {object} Update and disposal methods. */
export function createFieldPreview(root, spec) {
  const owned=[]
  root.updateWorldMatrix(true,true)
  const parentInverse=root.parent?root.parent.matrixWorld.clone().invert():new THREE.Matrix4()
  try {
    root.traverseVisible(node=>{
      if(!node.isMesh || !spec.parts.includes(node.name)) return
      const source=node.geometry, geometry=source.clone(), matrix=parentInverse.clone().multiply(node.matrixWorld), inverse=matrix.clone().invert()
      const position=geometry.getAttribute('position'), baseline=position.array.slice(), deltas=spec.fields.map(()=>new Float32Array(position.count*3))
      owned.push({node,source,geometry,baseline,deltas})
      const point=new THREE.Vector3(), moved=new THREE.Vector3()
      for(let i=0;i<position.count;i++) {
        point.fromBufferAttribute(position,i).applyMatrix4(matrix)
        spec.fields.forEach((field,k)=>{
          const d=sampleField(point.toArray(),field)
          moved.copy(point).add(new THREE.Vector3(...d)).applyMatrix4(inverse)
          for(let a=0;a<3;a++) deltas[k][i*3+a]=moved.getComponent(a)-baseline[i*3+a]
        })
      }
    })
    if(!owned.length || spec.parts.some(name=>!owned.some(item=>item.node.name===name))) throw new Error('Field parts must match visible meshes exactly')
  } catch(error) { for(const item of owned) item.geometry.dispose(); throw error }
  for(const item of owned) item.node.geometry=item.geometry
  return {
    update(values) {
      const checked=controlValues(spec,values)
      for(const {geometry,baseline,deltas} of owned) {
        const position=geometry.getAttribute('position')
        position.array.set(baseline)
        spec.fields.forEach((field,k)=>{for(let i=0;i<baseline.length;i++)position.array[i]+=deltas[k][i]*checked[field.key]})
        position.needsUpdate=true; geometry.computeVertexNormals(); geometry.computeBoundingBox(); geometry.computeBoundingSphere()
      }
      return true
    },
    dispose() { for(const {node,source,geometry} of owned){node.geometry=source;geometry.dispose()} },
  }
}
