/** Parse USD once for scene composition and robot metadata without copying marker-free text. */
import { USDAParser } from 'three/addons/loaders/usd/USDAParser.js'

/** The pinned Three parser owns syntax handling; absent markers need no rewriting. */
class ModelUsdParser extends USDAParser {
  _stripBlockComments(text) {
    return text.includes('/*') ? super._stripBlockComments(text) : text
  }

  _collapseTripleQuotedStrings(text) {
    return text.includes('"""') || text.includes("'''") ? super._collapseTripleQuotedStrings(text) : text
  }
}

/**
 * Parse a self-contained ASCII USD document using Three's syntax and value semantics.
 * @param {string} text Validated ASCII USD text.
 * @returns {object} Parsed layer shared by scene composition and robot metadata.
 */
export function parseUsdData(text) {
  return new ModelUsdParser().parseData(text)
}
