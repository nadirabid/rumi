/** Pinned Three syntax remains identical when marker-free preprocessing is omitted. */
import { expect, it, vi } from 'vitest'
import { USDAParser } from 'three/addons/loaders/usd/USDAParser.js'
import { parseUsdData } from '../viewer/viewport/usd-parser.js'
import { parseUsdModel } from '../viewer/viewport/usd.js'
import { disposeModel } from '../viewer/viewport/model.js'
import { robotUsd } from './fixtures/robot-usd.js'

it.each([
  ['plain arrays', 'point3f[] points = [(0, 0, 0), (1, 0, 0), (0, 1, 0)]'],
  ['multiline arrays', 'point3f[] points = [\n (0, 0, 0),\n (1, 0, 0),\n (0, 1, 0)\n]'],
  ['block comments', '/* across\n lines */\nstring label = "Model"'],
  ['unterminated block comments', 'string label = "Model"\n/* unfinished'],
  ['double triple quotes', 'string label = """first\nsecond\r\nthird"""'],
  ['single triple quotes', "string label = '''first\nsecond\r\nthird'''"],
  ['inline comment and quoted hash', 'string label = "a#b" # comment'],
  ['markers inside ordinary quotes', 'string label = "a/*b*/c"'],
  ['comment exposing quotes', 'string label = "/* removed */""first\nsecond"""'],
])('preserves Three parsing for %s', (_name, declaration) => {
  const text = `#usda 1.0\n(\n defaultPrim = "Model"\n)\ndef Xform "Model"\n{\n${declaration}\n}\n`
  expect(parseUsdData(text)).toEqual(new USDAParser().parseData(text))
})

it('composes geometry and robot metadata from one parse without rewriting marker-free source', async () => {
  const parse = vi.spyOn(USDAParser.prototype, 'parseData')
  const strip = vi.spyOn(USDAParser.prototype, '_stripBlockComments')
  const collapse = vi.spyOn(USDAParser.prototype, '_collapseTripleQuotedStrings')
  try {
    const model = await parseUsdModel(robotUsd().buffer)
    try {
      expect(model.positions.length).toBeGreaterThan(0)
      expect(model.robot.assembly.connections[0].id).toBe('DoorHinge')
      expect(parse).toHaveBeenCalledTimes(1)
      expect(strip).not.toHaveBeenCalled()
      expect(collapse).not.toHaveBeenCalled()
    } finally { disposeModel(model.root) }
  } finally {
    parse.mockRestore()
    strip.mockRestore()
    collapse.mockRestore()
  }
})
