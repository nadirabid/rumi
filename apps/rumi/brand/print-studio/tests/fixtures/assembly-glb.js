/** A nested GLB assembly exercises metre/Y-up imports and saved-world joint coordinates. */
export const assembly = {
  version: 1, root: 'body',
  parts: [{ id: 'body', mesh: 'Body' }, { id: 'door', mesh: 'Door.Right' }, { id: 'slide', mesh: 'Slide' }, { id: 'cap', mesh: 'Cap' }],
  connections: [
    { id: 'slide', parent: 'door', child: 'slide', kind: 'prismatic', axis: [1, 0, 0], pivot: [12, 20, 30], range: [0, 10] },
    { id: 'door', parent: 'body', child: 'door', kind: 'revolute', axis: [0, 0, 1], pivot: [10, 20, 30], range: [-90, 90], control: 'Right door' },
    { id: 'cap', parent: 'slide', child: 'cap', kind: 'fixed' },
  ], manufacturing: { mode: 'print-in-place' },
}

/** Build a self-contained GLB with optional manifest overrides. @param {object} overrides glTF JSON overrides. @returns {Uint8Array} GLB bytes. */
export function assemblyGlb(overrides = {}) {
  const positions = new Float32Array([.001, 0, 0, 0, .001, 0, 0, 0, .001])
  const manifest = { asset: { version: '2.0', extras: { rumiAssembly: assembly } }, scene: 0,
    scenes: [{ nodes: [0, 1] }], nodes: [
      { name: 'Body', mesh: 0 },
      { name: 'Door.Right', mesh: 0, translation: [.01, .03, -.02], children: [2] },
      { name: 'Slide', mesh: 0, translation: [.002, 0, 0], children: [3] },
      { name: 'Cap', mesh: 0, translation: [.001, 0, 0] },
    ],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    buffers: [{ byteLength: positions.byteLength }], bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: positions.byteLength }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [.001, .001, .001] }], ...overrides }
  const json = new TextEncoder().encode(JSON.stringify(manifest)), padded = Math.ceil(json.length / 4) * 4
  const bytes = new Uint8Array(28 + padded + positions.byteLength), view = new DataView(bytes.buffer)
  ;[0x46546c67, 2, bytes.length, padded, 0x4e4f534a].forEach((value, i) => view.setUint32(i * 4, value, true))
  bytes.fill(32, 20, 20 + padded); bytes.set(json, 20)
  view.setUint32(20 + padded, positions.byteLength, true); view.setUint32(24 + padded, 0x004e4942, true)
  bytes.set(new Uint8Array(positions.buffer), 28 + padded)
  return bytes
}
