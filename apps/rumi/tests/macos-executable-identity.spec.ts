/** Rumi and other Electron apps must not share executable identities for network permissions. */
import { describe, expect, it } from 'vitest'
import { scopeExecutableUuid } from '../scripts/macos-executable-identity.mjs'

function executable(): Buffer {
  const image = Buffer.alloc(64)
  image.writeUInt32LE(0xfeedfacf, 0)
  image.writeUInt32LE(1, 16)
  image.writeUInt32LE(24, 20)
  image.writeUInt32LE(0x1b, 32)
  image.writeUInt32LE(24, 36)
  Buffer.from('4c4c44af55553144a1e77e571b4f50e9', 'hex').copy(image, 40)
  return image
}

describe('macOS executable identity', () => {
  it('changes only the UUID and gives each product a reproducible, distinct identity', () => {
    const original = executable()
    const rumi = scopeExecutableUuid(original, 'com.nadirmuzaffar.rumi')
    const other = scopeExecutableUuid(original, 'com.example.other')
    expect(original).toEqual(executable())
    expect(rumi.subarray(0, 40)).toEqual(original.subarray(0, 40))
    expect(rumi.subarray(56)).toEqual(original.subarray(56))
    expect(rumi.subarray(40, 56)).not.toEqual(original.subarray(40, 56))
    expect(rumi).not.toEqual(other)
    expect(rumi).toEqual(scopeExecutableUuid(original, 'com.nadirmuzaffar.rumi'))
  })

  it.each(['unsupported', 'truncated', 'missing', 'duplicate', 'bad-size'] as const)('rejects %s images before changing any bytes', kind => {
    let image = executable()
    if (kind === 'unsupported') image.writeUInt32LE(0xcafebabe, 0)
    if (kind === 'truncated') image = image.subarray(0, 50)
    if (kind === 'missing') image.writeUInt32LE(0x19, 32)
    if (kind === 'bad-size') image.writeUInt32LE(0, 36)
    if (kind === 'duplicate') {
      image = Buffer.concat([image.subarray(0, 56), image.subarray(32, 56)])
      image.writeUInt32LE(2, 16)
      image.writeUInt32LE(48, 20)
    }
    const before = Buffer.from(image)
    expect(() => scopeExecutableUuid(image, 'com.nadirmuzaffar.rumi')).toThrow()
    expect(image).toEqual(before)
  })
})
