/** Example parameterized plate with two mirrored eye openings; dimensions are millimetres. */
export const parameters = { eyeTilt: 10, eyeWidth: 24, eyeHeight: 9 }

/** Build both eye cutouts from the same parameters. @param {object} THREE Viewer geometry library. @param {object} p Numeric model parameters. @returns {object} New owned mesh. */
export function build(THREE, p) {
  const outline = new THREE.Shape()
  outline.moveTo(-50, -30); outline.lineTo(50, -30); outline.lineTo(50, 30); outline.lineTo(-50, 30); outline.closePath()
  for (const side of [-1, 1]) {
    const angle = side * p.eyeTilt * Math.PI / 180, hole = new THREE.Path()
    for (const [i, [x, y]] of [[-1, -1], [-1, 1], [1, 1], [1, -1]].entries()) {
      const u = x * p.eyeWidth / 2, v = y * p.eyeHeight / 2
      const a = side * 23 + Math.cos(angle) * u - Math.sin(angle) * v
      const b = 8 + Math.sin(angle) * u + Math.cos(angle) * v
      if (i === 0) hole.moveTo(a, b); else hole.lineTo(a, b)
    }
    hole.closePath(); outline.holes.push(hole)
  }
  const geometry = new THREE.ExtrudeGeometry(outline, { depth: 4, bevelEnabled: false })
  geometry.rotateX(Math.PI / 2); geometry.translate(0, 0, 30)
  const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: 0xc6a64b, roughness: .5 }))
  mesh.name = 'faceplate'
  return mesh
}
