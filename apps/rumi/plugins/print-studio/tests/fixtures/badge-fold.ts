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

/**
 * Model two rectangular panels with relief slots at the ends of their seam.
 * @param webThickness Thickness of the center web in millimetres. Zero leaves the seam open.
 * @returns A triangulated USD mesh with only the exposed faces.
 */
export function slottedPanels(webThickness: number) {
  const columns = [-22, -2, 2, 22]
  const rows = [0, 10, 28, 40]
  const heights = webThickness > 0 ? [0, webThickness, 4] : [0, 4]
  const points = new Map<string, number>()
  const triangles: number[][] = []
  const dimensions = [columns, rows, heights]
  const solid = (x: number, y: number, z: number) =>
    x >= 0 && x < columns.length - 1 && y >= 0 && y < rows.length - 1 && z >= 0 && z < heights.length - 1
    && (x !== 1 || (y === 1 && heights[z]! < webThickness))
  for (let x = 0; x < columns.length - 1; x++) {
    for (let y = 0; y < rows.length - 1; y++) {
      for (let z = 0; z < heights.length - 1; z++) {
        if (!solid(x, y, z)) continue
        for (const axis of [0, 1, 2]) {
          const across = (axis + 1) % 3
          const up = (axis + 2) % 3
          for (const side of [-1, 1]) {
            const neighbor = [x, y, z]
            neighbor[axis]! += side
            if (solid(neighbor[0]!, neighbor[1]!, neighbor[2]!)) continue
            const face = [[0, 0], [1, 0], [1, 1], [0, 1]].map(([a, b]) => {
              const point = [x, y, z]
              point[axis]! += side > 0 ? 1 : 0
              point[across]! += a!
              point[up]! += b!
              const key = `(${point.map((index, i) => dimensions[i]![index]! / 1000).join(', ')})`
              if (!points.has(key)) points.set(key, points.size)
              return points.get(key)!
            })
            if (side < 0) face.reverse()
            triangles.push([face[0]!, face[1]!, face[2]!], [face[0]!, face[2]!, face[3]!])
          }
        }
      }
    }
  }
  return new Uint8Array(Buffer.from(`#usda 1.0
(
    defaultPrim = "Model"
    metersPerUnit = 1
    upAxis = "Z"
)
def Xform "Model" {
    def Mesh "SlottedPanels" {
        float3[] extent = [(-0.022, 0, 0), (0.022, 0.04, 0.004)]
        int[] faceVertexCounts = [${triangles.map(() => 3).join(', ')}]
        int[] faceVertexIndices = [${triangles.flat().join(', ')}]
        point3f[] points = [${[...points.keys()].join(', ')}]
    }
}
`))
}
