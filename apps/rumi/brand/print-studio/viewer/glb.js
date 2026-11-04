/** Validate self-contained GLB before either publishing or parsing it. */
export const GLB_MAX_BYTES = 64 * 1024 * 1024

/**
 * Reject truncated containers, external resources and unsupported animated assets.
 * @param {Uint8Array} bytes - Complete GLB file.
 * @returns {object} Parsed glTF manifest.
 */
export function validateGlb(bytes) {
  if (bytes.byteLength < 20 || bytes.byteLength > GLB_MAX_BYTES) throw new Error('GLB must be between 20 bytes and 64 MiB')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (view.getUint32(0, true) !== 0x46546c67 || view.getUint32(4, true) !== 2
    || view.getUint32(8, true) !== bytes.byteLength) throw new Error('Invalid GLB 2 container')
  let manifest
  for (let offset = 12; offset < bytes.byteLength;) {
    if (offset + 8 > bytes.byteLength) throw new Error('Truncated GLB chunk')
    const length = view.getUint32(offset, true), type = view.getUint32(offset + 4, true)
    if (length % 4 || offset + 8 + length > bytes.byteLength) throw new Error('Invalid GLB chunk length')
    if (offset === 12) {
      if (type !== 0x4e4f534a) throw new Error('GLB requires a JSON first chunk')
      manifest = JSON.parse(new TextDecoder().decode(bytes.subarray(offset + 8, offset + 8 + length)))
    }
    offset += 8 + length
  }
  if (manifest?.asset?.version !== '2.0') throw new Error('GLB requires glTF 2.0')
  for (const item of [...(manifest.buffers ?? []), ...(manifest.images ?? [])]) {
    if (item.uri !== undefined) throw new Error('Embed buffers and images in the GLB; external and data URIs are not supported')
  }
  if (manifest.animations?.length || manifest.skins?.length) throw new Error('Export a static GLB without animation or skinning')
  if (manifest.extensionsRequired?.length) throw new Error('Export GLB without required compression or other extensions')
  return manifest
}
