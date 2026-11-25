/** A closed pair of panels with a continuous folding web.
 * @param webThickness Thickness of the center web in millimetres.
 * @returns USD bytes for the connected mesh.
 */
export function foldedPanels(webThickness = .6) {
  const outline = [[-22, 0], [22, 0], [22, 4], [4, 4], [1, webThickness], [-1, webThickness], [-4, 4], [-22, 4]]
  const cap = [[0, 1, 4], [1, 2, 3], [1, 3, 4], [0, 4, 5], [0, 5, 6], [0, 6, 7]]
  const sides = outline.flatMap((_, left) => {
    const right = (left + 1) % outline.length
    return [[left, right, left + outline.length], [right, right + outline.length, left + outline.length]]
  })
  const triangles = [...cap, ...sides, ...cap.map(face => face.map(index => index + outline.length).reverse())]
  const points = [0, .024].flatMap(depth => outline.map(([x, z]) => `(${x! / 1000}, ${depth}, ${z! / 1000})`))
  return new Uint8Array(Buffer.from(`#usda 1.0
(
    defaultPrim = "Model"
    metersPerUnit = 1
    upAxis = "Z"
)
def Xform "Model" {
    def Mesh "Fold" {
        float3[] extent = [(-0.022, 0, 0), (0.022, 0.024, 0.004)]
        int[] faceVertexCounts = [${triangles.map(() => 3).join(', ')}]
        int[] faceVertexIndices = [${triangles.flat().join(', ')}]
        point3f[] points = [${points.join(', ')}]
    }
}
`))
}
