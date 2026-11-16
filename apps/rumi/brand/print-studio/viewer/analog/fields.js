/** Data-only displacement lattices, sampled in model-local millimetres. */
/** Validate bounded, continuous lattices. @param {object[]} fields Tool-supplied samples. @param {object} values Declared bindings. @returns {object[]} Independent validated fields. */
export function normalizeFields(fields, values) {
  if (!Array.isArray(fields) || !fields.length || fields.length > 12) throw new Error('Provide 1–12 displacement fields')
  const keys = new Set()
  return fields.map(field => {
    if (!field || !Object.hasOwn(values, field.key) || keys.has(field.key)) throw new Error('Each field needs a distinct control binding')
    keys.add(field.key)
    const vector = (name, valid) => {
      const value = field[name]
      if (!Array.isArray(value) || value.length !== 3 || !value.every(n => Number.isFinite(n) && valid(n))) throw new Error(`Invalid field ${name}`)
      return [...value]
    }
    const origin = vector('origin', n => Math.abs(n) <= 100000)
    const spacing = vector('spacing', n => n >= .01 && n <= 100000)
    const dimensions = vector('dimensions', n => Number.isInteger(n) && n >= 2 && n <= 16)
    const size = dimensions.reduce((a,b) => a*b, 1)*3
    if (!Array.isArray(field.offsets) || field.offsets.length !== size || !field.offsets.every(n => Number.isFinite(n) && Math.abs(n) <= 1000)) throw new Error('Invalid field offsets')
    // Zero boundary samples make the field continuous with the unchanged exterior.
    const [nx,ny,nz] = dimensions
    for (let z=0;z<nz;z++) for(let y=0;y<ny;y++) for(let x=0;x<nx;x++) {
      if(x && y && z && x<nx-1 && y<ny-1 && z<nz-1) continue
      if(field.offsets.slice(((z*ny+y)*nx+x)*3, ((z*ny+y)*nx+x)*3+3).some(n=>n!==0)) throw new Error('Field boundary offsets must be zero')
    }
    return { key: field.key, origin, spacing, dimensions, offsets: [...field.offsets] }
  })
}

/** Sample a field. @param {number[]} point Model-local millimetres. @param {object} field Validated lattice. @returns {number[]} Displacement per control unit. */
export function sampleField(point, field) {
  const q=point.map((p,i)=>(p-field.origin[i])/field.spacing[i]), out=[0,0,0]
  if(q.some((v,i)=>v<0 || v>field.dimensions[i]-1)) return out
  const base=q.map((v,i)=>Math.min(Math.floor(v),field.dimensions[i]-2)), t=q.map((v,i)=>v-base[i])
  for(let z=0;z<2;z++) for(let y=0;y<2;y++) for(let x=0;x<2;x++) {
    const weight=(x?t[0]:1-t[0])*(y?t[1]:1-t[1])*(z?t[2]:1-t[2])
    const index=(((base[2]+z)*field.dimensions[1]+base[1]+y)*field.dimensions[0]+base[0]+x)*3
    for(let a=0;a<3;a++) out[a]+=weight*field.offsets[index+a]
  }
  return out
}
