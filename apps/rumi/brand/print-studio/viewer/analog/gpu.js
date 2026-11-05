/** Material-preserving analytic deformations; drags update uniforms only. */
import * as THREE from 'three'
import { createCutPreview } from './cut.js'
import { shapeFrame, OPERATIONS } from './spec.js'

const shader = `
uniform mat4 shapeToModel, shapeToObject;
uniform vec3 shapeCenter, shapeRadii, shapeU, shapeV, shapeN;
uniform float shapeAmount, shapeSpread, shapePeakX, shapePeakY, shapeFalloff, shapeAngle, shapeLimit, shapeOperation;
vec3 shapePoint(vec3 p) {
 vec3 center=shapeCenter+shapeU*(shapePeakX-.5)*shapeRadii.x+shapeV*(shapePeakY-.5)*shapeRadii.y;
 vec3 d=p-center;
 vec3 q=vec3(dot(d,shapeU),dot(d,shapeV),dot(d,shapeN));
 vec3 r=q/(shapeRadii*(.5+shapeSpread));
 float w=pow(max(0.,1.-dot(r,r)),1.5+4.*shapeFalloff), a=shapeAmount*2.-1.;
 vec3 o=q;
 if(shapeOperation<.5){float t=(shapeAngle-.5)*2.09439510239;o.y+=sin(t)*a*shapeLimit*w;o.z+=cos(t)*a*shapeLimit*w;}
 else if(shapeOperation>2.5){o.xy*=1.+a*.6*w;}
 else {float t=a*1.57079632679*w*(shapeOperation<1.5?q.y/shapeRadii.y:q.z/shapeRadii.z),c=cos(t),s=sin(t);if(shapeOperation>1.5){o.x=c*q.x-s*q.y;o.y=s*q.x+c*q.y;}else{o.y=c*q.y-s*q.z;o.z=s*q.y+c*q.z;}}
 return p+shapeU*(o.x-q.x)+shapeV*(o.y-q.y)+shapeN*(o.z-q.z);
}
vec3 shapeObject(vec3 p){return (shapeToObject*vec4(shapePoint((shapeToModel*vec4(p,1.)).xyz),1.)).xyz;}
`

/** Attach owned shader materials without changing source geometry. @param {object} root Model root. @param {object} spec Validated operation. @returns {object} Update and dispose controls. */
export function createShapeDeformer(root, spec) {
  if (spec.operation === 'cut') return createCutPreview(root, spec)
  const [u,v,n]=shapeFrame(spec.direction)
  const uniform={ shapeCenter:{value:new THREE.Vector3(...spec.center)},shapeRadii:{value:new THREE.Vector3(...spec.radii)},shapeU:{value:new THREE.Vector3(...u)},shapeV:{value:new THREE.Vector3(...v)},shapeN:{value:new THREE.Vector3(...n)},shapeLimit:{value:spec.limit},shapeOperation:{value:OPERATIONS.indexOf(spec.operation)} }
  for(const key of Object.keys(spec.values)) uniform['shape'+key[0].toUpperCase()+key.slice(1)]={value:spec.values[key]}
  const owned=[]
  root.updateWorldMatrix(true,true)
  const parentInverse=root.parent?root.parent.matrixWorld.clone().invert():new THREE.Matrix4()
  root.traverseVisible(node=>{
    if(!node.isMesh || (spec.parts.length && !spec.parts.includes(node.name)))return
    const source=node.material, matrix=parentInverse.clone().multiply(node.matrixWorld), inverse=matrix.clone().invert()
    const clone=material=>{
      const result=material.clone()
      result.onBeforeCompile=(program, renderer)=>{
        material.onBeforeCompile(program, renderer)
        Object.assign(program.uniforms,uniform,{shapeToModel:{value:matrix},shapeToObject:{value:inverse}})
        program.vertexShader=shader+program.vertexShader
        program.vertexShader=program.vertexShader.replace('#include <beginnormal_vertex>', `
          vec3 objectNormal=vec3(normal);
          vec3 shapeTangent=normalize(cross(objectNormal,abs(objectNormal.z)<.9?vec3(0.,0.,1.):vec3(0.,1.,0.)));
          vec3 bitangent=normalize(cross(objectNormal,shapeTangent));
          float eps=0.01/max(length(shapeToModel[0].xyz),0.00001);
          vec3 origin=shapeObject(position);
          objectNormal=normalize(cross(shapeObject(position+shapeTangent*eps)-origin,shapeObject(position+bitangent*eps)-origin));
          #ifdef USE_TANGENT
            vec3 objectTangent=vec3(tangent);
          #endif
        `).replace('#include <begin_vertex>','vec3 transformed=shapeObject(position);')
      }
      result.customProgramCacheKey=()=> material.customProgramCacheKey()+':rumi-analog-shape-v1'
      return result
    }
    const materials=Array.isArray(source)?source.map(clone):clone(source)
    owned.push({node,source,materials,culled:node.frustumCulled})
    node.material=materials;node.frustumCulled=false
  })
  if(!owned.length)throw new Error('No visible mesh matches the shape control parts')
  return {
    update(values){for(const [key,value] of Object.entries(values))uniform['shape'+key[0].toUpperCase()+key.slice(1)].value=value},
    dispose(){for(const {node,source,materials,culled} of owned){node.material=source;node.frustumCulled=culled;for(const material of Array.isArray(materials)?materials:[materials])material.dispose()}},
  }
}
