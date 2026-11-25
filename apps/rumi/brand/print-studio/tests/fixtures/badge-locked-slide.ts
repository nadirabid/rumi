/** A separate guide saved with a fixed joint for its locked pose. */
export function lockedSlide(flared = true) {
  function mesh(name: string, profile: number[][], cap: number[][]) {
    const count = profile.length
    const points = [0, .012].flatMap(z => profile.map(([x, y]) => `(${x! / 1000},${y! / 1000},${z})`))
    const sides = profile.flatMap((_, left) => {
      const right = (left + 1) % count
      return [[left, right, left + count], [right, right + count, left + count]]
    })
    const triangles = [...cap, ...sides, ...cap.map(face => face.map(index => index + count).reverse())]
    return `def Mesh "${name}" {
    int[] faceVertexCounts = [${triangles.map(() => 3).join(', ')}]
    int[] faceVertexIndices = [${triangles.flat().join(', ')}]
    point3f[] points = [${points.join(', ')}]
}`
  }
  const flare = flared ? 3 : 0
  const insert = mesh('Insert', [[-4, -2], [4, -2], [4 + flare, 3], [-4 - flare, 3]], [[0, 1, 2], [0, 2, 3]])
  const base = mesh('Base', [[-17, -2], [-4.5, -2], [-4.5 - flare, 3.5], [4.5 + flare, 3.5],
    [4.5, -2], [17, -2], [17, 7], [-17, 7]], [[0, 1, 2], [0, 2, 7], [2, 3, 7], [3, 6, 7], [3, 4, 5], [3, 5, 6]])
  return new Uint8Array(Buffer.from(`#usda 1.0
(
    defaultPrim = "Model"
    metersPerUnit = 1
    upAxis = "Z"
)
def Xform "Model" {
    string rumi:disassembly = '[{"part":"Insert","path":[[0,0,0],[0,0,14]]}]'
    ${insert}
    ${base}
    def PhysicsFixedJoint "DovetailLock" {
        rel physics:body0 = </Model/Base>
        rel physics:body1 = </Model/Insert>
    }
}
`))
}
