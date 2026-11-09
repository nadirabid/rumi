/** Restrict project USD to a self-contained static layer before any asset resolver runs. */
export const USD_MAX_BYTES = 64 * 1024 * 1024

/** Validate the supported portable USD profile without resolving references.
 * @param {Uint8Array} bytes Complete ASCII USD layer.
 * @returns {string} UTF-8 layer ready for the USD parser.
 */
export function validateUsd(bytes) {
  if (bytes.byteLength < 10 || bytes.byteLength > USD_MAX_BYTES) throw new Error('USD must be between 10 bytes and 64 MiB')
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  if (!text.startsWith('#usda 1.0')) throw new Error('Export a self-contained ASCII USD layer as model.usda')
  // Reject even quoted occurrences: a project layer may never resolve another file or URL.
  if (text.includes('@') || /\b(subLayers|references|payload|variants|variantSet|inherits|specializes|timeSamples|clips)\b/.test(text)) {
    throw new Error('Flatten USD into one static layer without asset paths, references, variants or animation')
  }
  return text
}
