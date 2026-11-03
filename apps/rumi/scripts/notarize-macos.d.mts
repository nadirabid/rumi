/** Notarize with separate upload and wait timings while preserving signature checks and stapling. */
import type { MacOSNotarizationEnvironment } from './desktop-release-environment.mjs'
/**
 * Notarize and staple an App or DMG through the measured notarytool adapter.
 * @param options Validated Apple credentials and artifact path.
 * @param dependencies Signature, submission, stapling, and delay operations.
 * @returns Resolves after acceptance and stapling; failures remain in the packaging journal.
 */
export function notarizeMacOS(options: MacOSNotarizationEnvironment & { appPath: string }, dependencies?: {
  check(options: { appPath: string }): Promise<unknown>
  submit(options: object): Promise<unknown>
  staple(appPath: string): Promise<unknown>
  wait(milliseconds: number): Promise<unknown>
}): Promise<void>
