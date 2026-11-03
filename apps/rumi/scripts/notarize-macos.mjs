/** Preserve electron-notarize's validation and submission with bounded ticket-download recovery. */
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { setTimeout } from 'node:timers/promises'
import { checkSignatures } from '@electron/notarize/lib/check-signature.js'
import { notarizeAndWaitForNotaryTool } from '@electron/notarize/lib/notarytool.js'
import { packagingStep } from './packaging-step.mjs'

const exec = promisify(execFile)
const operations = {
  check: checkSignatures,
  submit: notarizeAndWaitForNotaryTool,
  staple: appPath => exec('/usr/bin/xcrun', ['stapler', 'staple', '-v', appPath], { timeout: 120_000 }),
  wait: setTimeout,
}

/**
 * Notarize and staple one App or DMG through the pinned electron-notarize adapters.
 * @param {object} options Validated credentials and appPath accepted by electron-notarize.
 * @param {object} dependencies Signature, submission, stapling, and delay operations.
 * @returns {Promise<void>} Resolves only after Apple acceptance and stapling; exhausted retries reject.
 */
export async function notarizeMacOS(options, dependencies = operations) {
  const secrets = Object.entries(options).filter(([name]) => /password|key|appleId/iu.test(name)).map(([, value]) => String(value))
  await packagingStep(process.env.DSH_DESKTOP_PACKAGING_RUN_DIR, 'notarize-and-staple', async () => {
    await dependencies.check({ appPath: options.appPath })
    await dependencies.submit({ ...options, notarytoolPath: fileURLToPath(new URL('./logged-notarytool.mjs', import.meta.url)) })
    for (let attempt = 0; ; attempt++) {
      try {
        await dependencies.staple(options.appPath)
        return
      } catch (error) {
        // EX_NOHOST (68) means Apple's ticket service was unavailable; stapling the accepted artifact is idempotent.
        if (error.code !== 68 || attempt === 3) throw error
        console.log(`desktop notarization: ticket download unavailable; retry ${attempt + 1}/3`)
        await dependencies.wait(15_000 * 2 ** attempt)
      }
    }
  }, secrets)
}
