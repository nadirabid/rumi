/** Give Rumi's copied Electron executables distinct build UUIDs before signing. */
import { createHash } from 'node:crypto'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Scope a fresh Electron image's UUID to its application bundle.
 * Supports the thin little-endian Mach-O 64-bit images used by mac-arm64 and mac-x64.
 * Rejects unsupported or malformed images without changing the input. Sign the result afterwards.
 * @param {Buffer} image - Original executable bytes, before product-specific UUID rewriting.
 * @param {string} bundleId - Unique identity for this executable's application bundle.
 * @returns {Buffer} Copy with only the LC_UUID payload changed.
 */
export function scopeExecutableUuid(image, bundleId) {
  if (image.length < 32 || image.readUInt32LE(0) !== 0xfeedfacf) {
    throw new Error('Rumi packaging requires a thin 64-bit Mach-O executable')
  }
  const count = image.readUInt32LE(16)
  const end = 32 + image.readUInt32LE(20)
  if (end > image.length) throw new Error('Mach-O load commands exceed the executable size')
  let offset = 32
  let uuidOffset
  for (let index = 0; index < count; index++) {
    if (offset + 8 > end) throw new Error('Truncated Mach-O load command')
    const command = image.readUInt32LE(offset)
    const size = image.readUInt32LE(offset + 4)
    if (size < 8 || size % 8 !== 0 || offset + size > end) throw new Error('Invalid Mach-O load command size')
    if (command === 0x1b) {
      if (size !== 24 || uuidOffset !== undefined) throw new Error('Invalid or duplicate Mach-O UUID command')
      uuidOffset = offset + 8
    }
    offset += size
  }
  if (offset !== end || uuidOffset === undefined) throw new Error('Mach-O executable must contain one build UUID')
  const uuid = createHash('sha256').update(bundleId).update('\0').update(image.subarray(uuidOffset, uuidOffset + 16)).digest().subarray(0, 16)
  uuid[6] = (uuid[6] & 0x0f) | 0x80
  uuid[8] = (uuid[8] & 0x3f) | 0x80
  const result = Buffer.from(image)
  uuid.copy(result, uuidOffset)
  return result
}

/**
 * Rewrite only the packaged app and helper executables; shared Electron inputs stay untouched.
 * Run once after each fresh copy and before signing. UUIDs also identify debug symbols, so any
 * corresponding executable dSYM must receive the same UUID before distributing debug symbols.
 * @param {string} appPath - Freshly packaged macOS application directory.
 * @param {string} executableName - Main executable name.
 * @param {string} bundleId - Rumi's bundle identifier.
 * @returns {Promise<void>} Resolves after all executable UUIDs have been written.
 */
export async function scopeMacOSExecutableIdentities(appPath, executableName, bundleId) {
  const executables = [[join(appPath, 'Contents', 'MacOS', executableName), bundleId]]
  const frameworks = join(appPath, 'Contents', 'Frameworks')
  for (const entry of await readdir(frameworks, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.endsWith('.app')) continue
    const name = entry.name.slice(0, -4)
    executables.push([join(frameworks, entry.name, 'Contents', 'MacOS', name), `${bundleId}:${name}`])
  }
  for (const [path, identity] of executables) {
    await writeFile(path, scopeExecutableUuid(await readFile(path), identity))
  }
}
