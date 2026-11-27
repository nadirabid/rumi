/**
 * A millimetre-scale table.
 * @param {object} THREE - Viewer-supplied Three.js module.
 * @returns {object} A new table group with named parts and owned resources.
 */
export function build(THREE) {
  const width = 80, depth = 50, height = 40, thickness = 4, legWidth = 6
  const table = new THREE.Group()
  table.name = 'table'
  const material = new THREE.MeshStandardMaterial({ color: '#d39b63', roughness: 0.7 })
  const top = new THREE.Mesh(new THREE.BoxGeometry(width, depth, thickness), material)
  top.name = 'tabletop'
  top.position.z = height - thickness / 2
  table.add(top)
  const legHeight = height - thickness
  const geometry = new THREE.BoxGeometry(legWidth, legWidth, legHeight)
  for (const x of [-1, 1]) for (const y of [-1, 1]) {
    const leg = new THREE.Mesh(geometry, material)
    leg.name = `leg-${x}-${y}`
    leg.position.set(x * (width - legWidth) / 2, y * (depth - legWidth) / 2, legHeight / 2)
    table.add(leg)
  }
  return table
}
