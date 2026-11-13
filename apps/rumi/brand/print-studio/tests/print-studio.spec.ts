/** Print Studio setup detection and profile storage. */

import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import {
  detectSlicer, parsePrinterResponse, printerConfigPath, printStudioNextSteps, readPrinterConfig, writePrinterConfig,
} from '../probe.js'

const roots: string[] = []

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'rumi-print-studio-'))
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fakeBambu(root: string): string {
  const app = join(root, 'BambuStudio.app')
  mkdirSync(join(app, 'Contents', 'MacOS'), { recursive: true })
  writeFileSync(join(app, 'Contents', 'MacOS', 'BambuStudio'), '')
  const profiles = join(app, 'Contents', 'Resources', 'profiles', 'BBL')
  for (const folder of ['machine', 'process', 'filament']) {
    mkdirSync(join(profiles, folder), { recursive: true })
  }
  writeFileSync(join(profiles, 'machine', 'Bambu Lab H2D 0.4 nozzle.json'), '{}')
  writeFileSync(join(profiles, 'process', '0.20mm Standard.json'), '{}')
  writeFileSync(join(profiles, 'filament', 'Bambu PLA Basic.json'), '{}')
  return app
}

it('detects Bambu Studio and its H2D profiles', () => {
  const root = temporaryRoot()
  const app = fakeBambu(root)
  const bambu = detectSlicer({ bambuApps: [app] })
  expect(bambu.found).toBe(true)
  expect(bambu.executable).toBe(join(app, 'Contents', 'MacOS', 'BambuStudio'))
  expect(bambu.profiles.h2d).toBe(true)
  expect(bambu.profiles.machines).toBe(1)
  expect(bambu.profiles.processes).toBe(1)
  expect(bambu.profiles.filaments).toBe(1)
})

it('detects a Bambu Studio installed in the Rumi-owned applications folder first', () => {
  const root = temporaryRoot()
  const previous = process.env.DSH_RUMI_HOME
  process.env.DSH_RUMI_HOME = root
  try {
    const app = fakeBambu(join(root, 'print-studio', 'applications'))
    expect(detectSlicer().path).toBe(app)
  } finally {
    if (previous === undefined) delete process.env.DSH_RUMI_HOME
    else process.env.DSH_RUMI_HOME = previous
  }
})

it('reports Bambu Studio missing when the application directory is absent', () => {
  const root = temporaryRoot()
  const bambu = detectSlicer({ bambuApps: [join(root, 'missing.app')] })
  expect(bambu.found).toBe(false)
})

it('stores the printer profile owner-only and reads it back', () => {
  const root = temporaryRoot()
  const config = { model: 'H2D', host: '192.168.1.50', serial: '01S00A' }
  writePrinterConfig(config, root)
  expect(readPrinterConfig(root)).toEqual(config)
  expect(statSync(printerConfigPath(root)).mode & 0o777).toBe(0o600)
})

it('returns the H2D default when no printer profile exists', () => {
  const root = temporaryRoot()
  expect(readPrinterConfig(root)).toEqual({ model: 'H2D', host: null, serial: null })
})

it('orders the setup steps from installed Bambu Studio to reachable printer', () => {
  const empty = {
    slicer: { found: false, profiles: { h2d: false } },
    printer: { model: 'H2D', host: null, serial: null, hasAccessCode: false, reachable: { mqtt: false } },
  }
  expect(printStudioNextSteps(empty).map(step => step.id)).toEqual(['install-bambu', 'find-printer'])

  const missingProfiles = {
    ...empty,
    slicer: { found: true, profiles: { h2d: false } },
  }
  expect(printStudioNextSteps(missingProfiles).map(step => step.id)).toEqual(['missing-profiles', 'find-printer'])

  const ready = {
    slicer: { found: true, profiles: { h2d: true } },
    printer: { model: 'H2D', host: '192.168.1.50', serial: '01S00A', hasAccessCode: true, reachable: { mqtt: true } },
  }
  expect(printStudioNextSteps(ready)).toEqual([])
})

it('normalizes a Bambu SSDP response into a printer', () => {
  const response = [
    'HTTP/1.1 200 OK',
    'ST: urn:bambulab-com:device:3dprinter:1',
    'USN: 0948AD532400782',
    'DevModel.bambu.com: O1D',
    'DevName.bambu.com: FarmerEngineer',
    'DevConnect.bambu.com: cloud',
    '',
  ].join('\r\n')
  expect(parsePrinterResponse(response, '192.168.68.71')).toEqual({
    serial: '0948AD532400782',
    name: 'FarmerEngineer',
    ip: '192.168.68.71',
    devModel: 'O1D',
    model: 'H2D',
    mode: 'cloud',
  })
})

it('asks for a Bambu sign-in when the printer is in cloud mode without an access code', () => {
  const status = {
    slicer: { found: true, profiles: { h2d: true } },
    printer: { model: 'H2D', host: '192.168.68.71', serial: '0948AD532400782', mode: 'cloud', hasAccessCode: false, reachable: { mqtt: false } },
    discovered: [{ serial: '0948AD532400782', mode: 'cloud' }],
  }
  expect(printStudioNextSteps(status).map(step => step.id)).toEqual(['cloud-sign-in'])
})

it('asks for a bound-printer fix after a cloud sign-in without a code, and survives a server error', () => {
  const base = {
    slicer: { found: true, profiles: { h2d: true } },
    printer: { model: 'H2D', host: '192.168.68.71', serial: '0948AD532400782', mode: 'cloud', hasAccessCode: false, reachable: { mqtt: false } },
    discovered: [{ serial: '0948AD532400782', mode: 'cloud' }],
    cloud: { signedIn: true },
  }
  expect(printStudioNextSteps(base).map(step => step.id)).toEqual(['cloud-no-printer'])
  const rejected = {
    ...base,
    printer: { ...base.printer, hasAccessCode: true },
  }
  expect(printStudioNextSteps(rejected).map(step => step.id)).toEqual(['auth-failed'])
})
