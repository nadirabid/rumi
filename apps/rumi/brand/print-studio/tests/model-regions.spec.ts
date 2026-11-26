/** Feature metadata binds names and their geometry to one saved model. */

import { expect, it } from 'vitest'
import { findModelRegion, mentionedModelRegions, readModelRegions } from '../viewer/model-regions.js'

const hash = 'a'.repeat(64)
const bounds = [[-1, -2, -3, 1, 2, 3]]
const surface = {
  id: 'grip', name: 'Grip', description: '  Where you hold the tool.  ', aliases: ['Handle'],
  location: { kind: 'surface', parts: [{ partPath: ['Body', 'Left grip'], surfaceIds: [7], faceRanges: [[0, 2]] },
    { partPath: ['Body', 'Right grip'] }] },
}
const curve = { id: 'opening-rim', name: 'Opening rim', aliases: ['Lip'], location: {
  kind: 'curve', points: [[0, 0, 0], [1, 0, 0], [0, 1, 0]], closed: true,
} }
const volume = { id: 'clearance', name: 'Clearance', location: { kind: 'volume', boxes: bounds } }
const point = { id: 'pivot', name: 'Pivot', location: { kind: 'point', point: [0, 2, 3] } }

function map(...regions: object[]) {
  return readModelRegions({ sourceHash: hash, regions }, hash)!
}

it('loads surface, curve, and point locations for the saved revision', () => {
  const regions = [surface, curve, point]
  const loaded = map(...regions)
  expect(loaded).toEqual({ regions: [{ ...surface, description: 'Where you hold the tool.' }, curve, point], remainder: null })
  expect(readModelRegions({ sourceHash: hash, regions }, 'b'.repeat(64))).toBeNull()
})

it('accepts nested surface details in any order and resolves each name directly', () => {
  const tip = { ...surface, id: 'tip', name: 'Grip tip', parentId: 'grip-edge' }
  const edge = { ...surface, id: 'grip-edge', name: 'Grip edge', parentId: 'grip' }
  const loaded = map(tip, surface, edge)
  expect(loaded.regions.map(region => [region.id, region.parentId])).toEqual([
    ['tip', 'grip-edge'], ['grip', undefined], ['grip-edge', 'grip'],
  ])
  expect(findModelRegion(loaded, 'Grip')).toMatchObject({ status: 'found', region: { id: 'grip' } })
  expect(findModelRegion(loaded, 'Grip tip')).toMatchObject({ status: 'found', region: { id: 'tip', parentId: 'grip-edge' } })
})

it('rejects invalid region parent links', () => {
  const detail = { ...surface, id: 'detail' }
  expect(() => map(surface, { ...detail, parentId: 2 })).toThrow(/set parentId/)
  expect(() => map(surface, { ...detail, parentId: 'missing' })).toThrow(/refer to a saved region/)
  expect(() => map(surface, { ...point, parentId: 'grip' })).toThrow(/both select surfaces/)
  expect(() => map(point, { ...detail, parentId: 'pivot' })).toThrow(/both select surfaces/)
  expect(() => map({ ...surface, parentId: 'grip' })).toThrow(/cycle/)
  expect(() => map({ ...surface, parentId: 'detail' }, { ...detail, parentId: 'grip' })).toThrow(/cycle/)
})

it('loads large feature hierarchies and reports the limit when a map exceeds it', () => {
  const details = Array.from({ length: 255 }, (_, i) => ({
    ...surface, id: `detail-${i}`, name: `Detail ${i}`, parentId: surface.id,
  }))
  const loaded = map(surface, ...details)
  expect(findModelRegion(loaded, 'Detail 254')).toMatchObject({ status: 'found', region: { parentId: 'grip' } })
  expect(() => map(surface, ...details, point)).toThrow('between 1 and 256 named features')
})

it('rejects a mixed map when one feature lacks a location', () => {
  expect(() => map(surface, { id: 'tail', name: 'Tail', boxes: bounds })).toThrow(/tail.*location/)
})

it('resolves exact IDs and normalized names while reporting ambiguous aliases', () => {
  const second = { ...point, aliases: ['Lip'] }
  const loaded = map(surface, curve, second)
  expect(findModelRegion(loaded, 'grip')).toMatchObject({ status: 'found', region: { id: 'grip' } })
  expect(findModelRegion(loaded, '  ＨＡＮＤＬＥ ')).toMatchObject({ status: 'found', region: { id: 'grip' } })
  expect(findModelRegion(loaded, 'opening  rim')).toMatchObject({ status: 'found', region: { id: 'opening-rim' } })
  expect(findModelRegion(loaded, 'lip')).toEqual({
    status: 'ambiguous', matches: [{ id: 'opening-rim', name: 'Opening rim' }, { id: 'pivot', name: 'Pivot' }],
  })
  expect(findModelRegion(loaded, 'open')).toEqual({ status: 'unknown' })
})

it('finds whole named phrases without promoting a shorter or ambiguous alias', () => {
  const short = { ...point, id: 'rim', name: 'Rim' }
  const competing = { ...point, id: 'other', aliases: ['Lip'] }
  const eastAsian = { ...point, id: 'window', name: '窗口' }
  const loaded = map(short, competing, curve, eastAsian, surface)
  expect(mentionedModelRegions(loaded, 'Show the opening rim, the HANDLE, and the Lip. Trim first.').map(region => region.id))
    .toEqual(['opening-rim', 'grip'])
  expect(mentionedModelRegions(loaded, '请突出显示窗口。').map(region => region.id)).toEqual(['window'])
})

it('reports unknown names and no mentions when a model has no feature map', () => {
  expect(findModelRegion(undefined, 'Rim')).toEqual({ status: 'unknown' })
  expect(mentionedModelRegions(null, 'Show the rim')).toEqual([])
})

it.each([
  { ...surface, boxes: bounds },
  { ...volume, location: { kind: 'volume', boxes: [[0, 0, 0, 0, 2, 3]] } },
  { ...point, location: { kind: 'point', point: [0, Infinity, 0] } },
  { ...curve, location: { kind: 'curve', points: [[0, 0, 0], [0, 0, 0]] } },
  { ...surface, location: { kind: 'surface', parts: [{ partPath: ['Body'], faceRanges: [[0, 0]] }] } },
  { ...surface, location: { kind: 'surface', parts: [{ partPath: ['Body'], surfaceIds: [0] }] } },
  { ...surface, location: { kind: 'surface', parts: [{ partPath: ['Body'], surfaceIds: [] }] } },
  { ...surface, location: { kind: 'surface', parts: [{ partPath: ['Body'] }, { partPath: ['Body'], surfaceIds: [7] }] } },
])('rejects an invalid feature location', (invalid) => {
  expect(() => map(invalid)).toThrow()
})
