/** Write a standard 3MF with one build item per physical part and solid colors per face. */
import { zipSync, strToU8 } from 'three/addons/libs/fflate.module.js'
import { STL_LIMITS } from '../stl.js'
import { PRINT_FACE_BYTES } from './plate-payload.js'

const modelPath = '3D/3dmodel.model'
const xml = '<?xml version="1.0" encoding="UTF-8"?>'
const contentTypes = `${xml}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>`
const relationships = `${xml}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/${modelPath}" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>`
const modelStart = `${xml}<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:m="http://schemas.microsoft.com/3dmanufacturing/material/2015/02" recommendedextensions="m">`

function escapeName(name) {
  return name.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
}

function meshXml(faces, volume, palette) {
  const vertices = new Map(), triangles = []
  const offsets = [volume.x / 2, volume.y / 2, 0]
  const limits = [volume.x, volume.y, volume.z]
  let defaultColor
  for (let face = 0; face < faces.byteLength; face += PRINT_FACE_BYTES) {
    const color = faces.getUint32(face + 36, true)
    if (color > 0xffffff) throw new Error('layoutFailed')
    if (!palette.has(color)) palette.set(color, palette.size)
    const p = palette.get(color)
    defaultColor ??= p
    const indices = []
    for (let corner = 0; corner < 3; corner++) {
      const point = offsets.map((offset, axis) => faces.getFloat32(face + (corner * 3 + axis) * 4, true) + offset)
      if (point.some((value, axis) => !Number.isFinite(value) || value < -.001 || value > limits[axis] + .001)) {
        throw new Error('layoutOutside')
      }
      // Share vertex indices across material seams so each part retains its mesh connectivity.
      const key = `<vertex x="${point[0]}" y="${point[1]}" z="${point[2]}"/>`
      if (!vertices.has(key)) vertices.set(key, vertices.size)
      indices.push(vertices.get(key))
    }
    triangles.push(`<triangle v1="${indices[0]}" v2="${indices[1]}" v3="${indices[2]}" pid="1" p1="${p}" p2="${p}" p3="${p}"/>`)
  }
  return { defaultColor, xml: `<mesh><vertices>${[...vertices.keys()].join('')}</vertices><triangles>${triangles.join('')}</triangles></mesh>` }
}

/** Validate renderer geometry and package only model data for slicer import.
 * @param {FormData} payload Paired part names and binary face records in plate order.
 * @param {{x:number,y:number,z:number}} volume Build envelope in millimetres.
 * @returns {Promise<Uint8Array>} 3MF archive with no printer or process settings.
 * @throws {Error} Malformed, oversized or out-of-bounds plate data.
 */
export async function makePrint3mf(payload, volume) {
  const names = payload.getAll('name'), meshes = payload.getAll('mesh')
  if (meshes.length === 0 || meshes.length > 128 || names.length !== meshes.length) throw new Error('layoutFailed')
  let totalFaces = 0
  for (const [index, mesh] of meshes.entries()) {
    const name = names[index]
    if (typeof name !== 'string' || name.length > 2048 || /[\u0000-\u001f\ufffe\uffff]/u.test(name)
      || typeof mesh === 'string' || !mesh.size || mesh.size % PRINT_FACE_BYTES !== 0) throw new Error('layoutFailed')
    totalFaces += mesh.size / PRINT_FACE_BYTES
  }
  if (totalFaces > STL_LIMITS.maxTriangles) throw new Error('layoutFailed')
  const palette = new Map(), objects = [], items = []
  for (const [index, mesh] of meshes.entries()) {
    const id = index + 2
    const name = escapeName(names[index] || 'Assembly')
    const { defaultColor, xml: geometry } = meshXml(new DataView(await mesh.arrayBuffer()), volume, palette)
    objects.push(`<object id="${id}" type="model" name="${name}" pid="1" pindex="${defaultColor}">${geometry}</object>`)
    items.push(`<item objectid="${id}"/>`)
  }
  const colors = [...palette.keys()].map(color => `<m:color color="#${color.toString(16).padStart(6, '0').toUpperCase()}"/>`).join('')
  const model = `${modelStart}<resources><m:colorgroup id="1">${colors}</m:colorgroup>${objects.join('')}</resources><build>${items.join('')}</build></model>`
  return zipSync({
    '[Content_Types].xml': strToU8(contentTypes),
    '_rels/.rels': strToU8(relationships),
    [modelPath]: strToU8(model),
  }, { level: 1 })
}
