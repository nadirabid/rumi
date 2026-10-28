/** The hosted-login bridge must ship alongside the desktop entry that opens it. */
import { expect, it } from 'vitest'
import { createElectronBuilderConfig } from '../scripts/electron-builder-config.mjs'

it('includes the Bambu login preload in the installed app', () => {
  const config = createElectronBuilderConfig({ DSH_DESKTOP_APP_ID: 'com.nadirmuzaffar.rumi', DSH_DESKTOP_UNSIGNED: '1' }, 'darwin', 'arm64')
  expect(config.files).toContain('lib/preload-bambu.cjs')
  expect(config.mac.extendInfo.NSLocalNetworkUsageDescription).toContain('3D printer')
  expect(config.mac.extendInfo.NSMicrophoneUsageDescription).toContain('microphone')
  expect(config.mac.extendInfo.CFBundleLocalizations).toEqual(['en', 'zh_CN'])
})
