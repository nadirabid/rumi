/** STL decoding rejects unbounded files, and the published encoding round-trips. */
import { expect, it } from 'vitest'
import { encodeStl, parseStl, STL_LIMITS } from '../viewer/stl.js'

const ascii = `solid tile
facet normal 0 0 1
outer loop
vertex 0 0 0
vertex 12 0 0
vertex 0 12 0
endloop
endfacet
endsolid tile
`

const second = `solid other
facet normal 0 0 1
outer loop
vertex 0 0 0
vertex 0 12 0
vertex 0 0 12
endloop
endfacet
endsolid other
`

it('decodes ASCII triangles in millimetres', () => {
  expect([...parseStl(new TextEncoder().encode(ascii))]).toEqual([0, 0, 0, 12, 0, 0, 0, 12, 0])
})

it('decodes every solid in a multi-solid ASCII file', () => {
  expect(parseStl(new TextEncoder().encode(ascii + second)).length).toBe(18)
})

it('recognizes binary STL even when its header begins with solid', () => {
  const bytes = new Uint8Array(134)
  bytes.set(new TextEncoder().encode('solid binary'))
  const view = new DataView(bytes.buffer)
  view.setUint32(80, 1, true)
  view.setFloat32(100, 12, true)
  expect(parseStl(bytes)[1]).toBe(12)
  expect(parseStl(bytes).length).toBe(9)
})

it('round-trips through the encoding the host publishes', () => {
  const positions = parseStl(new TextEncoder().encode(ascii))
  const encoded = encodeStl(positions)
  expect(encoded.byteLength).toBe(84 + 50)
  expect([...parseStl(encoded)]).toEqual([...positions])
})

it('writes an outward facet normal so a published file is valid on its own', () => {
  const encoded = encodeStl(parseStl(new TextEncoder().encode(ascii)))
  expect([...new Float32Array(encoded, 84, 3)]).toEqual([0, 0, 1])
})

it('rejects incomplete facets, non-finite coordinates and empty files', () => {
  for (const content of ['', ascii.replace('endfacet', ''), ascii.replace('12', 'NaN'), ascii.replace('12', '1e100')]) {
    expect(() => parseStl(new TextEncoder().encode(content))).toThrow()
  }
})

it('rejects a mismatched binary triangle count and oversized byte input', () => {
  const bytes = new Uint8Array(134)
  new DataView(bytes.buffer).setUint32(80, 2, true)
  expect(() => parseStl(bytes)).toThrow('invalid_stl')
  expect(() => parseStl(new Uint8Array(STL_LIMITS.maxBytes + 1))).toThrow('file_too_large')
})

it('honors byte offsets when decoding a view into a larger buffer', () => {
  const bytes = new Uint8Array(150)
  const view = new DataView(bytes.buffer, 8, 134)
  view.setUint32(80, 1, true)
  view.setFloat32(100, 12, true)
  expect(parseStl(bytes.subarray(8, 142))[1]).toBe(12)
})

it('refuses to encode anything that is not whole triangles', () => {
  expect(() => encodeStl([0, 0, 0])).toThrow(RangeError)
  expect(() => encodeStl(new Float32Array((STL_LIMITS.maxTriangles + 1) * 9))).toThrow(RangeError)
})
