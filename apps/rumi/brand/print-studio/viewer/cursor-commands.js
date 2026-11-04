/** Exact, non-destructive selection phrases; arbitrary modeling requests remain agent-owned. */
const COMMANDS = new Map([
  ['local patch', 'patch'], ['just here', 'patch'], ['whole panel', 'surface'], ['this surface', 'surface'],
  ['whole surface', 'surface'], ['whole part', 'part'], ['this whole part', 'part'],
  ['just the edge', 'edge'], ['this edge', 'edge'], ['edge', 'edge'],
  ['larger selection', 'larger'], ['smaller selection', 'smaller'],
  ['整个表面', 'surface'], ['整个部件', 'part'], ['只选边缘', 'edge'], ['局部', 'patch'],
  ['扩大选区', 'larger'], ['缩小选区', 'smaller'],
])

/**
 * Recognize a complete short selection phrase, never an embedded editing instruction.
 * @param {string} text - Accumulated transcript of the current spoken request.
 * @returns {string | null} Local selection command, or null for ordinary agent interpretation.
 */
export function cursorCommand(text) {
  return COMMANDS.get(text.trim().toLowerCase().replace(/[.!。！]+$/u, '').trim()) ?? null
}
