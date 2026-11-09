/** Small standard USD robot used by host, renderer and recorded-session tests. */
import { readFileSync } from 'node:fs'

/** Read an independent copy of the fixture layer. @returns {Uint8Array} USD bytes. */
export function robotUsd() {
  return new Uint8Array(readFileSync(`${import.meta.dirname}/robot.usda`))
}
