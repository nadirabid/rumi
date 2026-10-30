/**
 * Print Studio — host half.
 *
 * Detects Bambu Studio and the configured Bambu printer, exposes the result
 * to the Print Studio card and to `print_studio_status`, and ships the
 * `print-studio-setup` skill that walks an adult through whatever is missing.
 * Preview tools publish session-owned meshes to the existing right sidebar.
 *
 * @module @rumi/print-studio
 */

import { join } from 'node:path'
import * as skillFilesystem from '@deepseek-ai/dsh-skill-filesystem'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import {
  DOWNLOAD_URL, MODELS, detectSlicer, discoverPrinters, mqttAuthorized, printStudioNextSteps, reachable, readPrinterConfig, text, writePrinterConfig,
} from './probe.js'
import { loginMessageToken, accessCodeFor, devices as cloudDevices } from './cloud.js'
import { sliceMesh } from './slicer.js'
import { handoffToBambuConnect, hasBambuConnect } from './connect.js'
import { readPrinterStatus } from './monitor.js'
import { applyViewer } from './viewer/host.js'

/** The plugin row id, also the card identity. */
export const name = 'print-studio'

/** Services this host half reaches. */
export const inject = ['connection', 'tools', 'credentials', 'fs', 'workingDirectory']

const ROUTE = '/api/print-studio'
const SKILL_NAME = 'print-studio-setup'
const ACCESS_CODE = credentialRef('BAMBU_LAN_ACCESS_CODE')
const CLOUD_TOKEN = credentialRef('BAMBU_CLOUD_ACCESS_TOKEN')

/** Read the Bambu Cloud token without exposing it. */
async function readCloudToken(ctx) {
  try {
    return (await ctx.credentials.resolve(CLOUD_TOKEN))?.value ?? null
  } catch {
    return null
  }
}

/** Fetch the bound printer's access code and keep the account token. */
async function adoptCloud(ctx, token) {
  const devices = await cloudDevices(token)
  const printer = readPrinterConfig()
  const match = accessCodeFor(devices, printer.serial ?? '')
  if (match === null) throw new Error('Bambu Cloud: no bound printer with an access code')
  await ctx.credentials.set(ACCESS_CODE, match.code)
  await ctx.credentials.set(CLOUD_TOKEN, token)
  return match
}

/** Slice the bundled test tile and hand it to Bambu Connect for a manual Send. */
async function printTestTile(ctx) {
  const printer = readPrinterConfig()
  if (printer.host === null) throw new Error('No printer has been discovered')
  if (!hasBambuConnect()) throw new Error('Bambu Connect is not installed')
  const accessCode = await readAccessCode(ctx)
  if (accessCode === null) throw new Error('The printer access code is not stored')
  const status = await readPrinterStatus({ host: printer.host, serial: printer.serial, accessCode })
  const tray = (status.ams?.trays ?? [])
    .filter(entry => entry.type === 'PLA' && (entry.remain ?? 0) > 5)
    .sort((left, right) => (right.remain ?? 0) - (left.remain ?? 0))[0]
  if (tray === undefined) throw new Error('No loaded PLA AMS tray was found')
  const result = await sliceMesh(join(import.meta.dirname, 'assets', 'test-tile.stl'), {
    bedType: 'supertack_plate',
    jobName: 'print-studio-test-tile',
    filamentColor: `#${String(tray.color).slice(0, 6)}`,
    filamentType: 'PLA',
  })
  const handoff = await handoffToBambuConnect(result.file, 'Print Studio 5 min tile')
  return {
    status: 'awaiting-send',
    file: result.file,
    name: result.name,
    bedType: result.bedType,
    filament: { type: result.filamentType, color: result.filamentColor, tray: tray.id, remain: tray.remain },
    seconds: Math.round(result.seconds),
    handoff,
    instructions: 'Bambu Connect is open. Select the H2D, Supertack Plate, and a PLA tray, then press Send.',
  }
}

/** Resolve the stored LAN access code without exposing it to the caller. */
async function readAccessCode(ctx) {
  try {
    return (await ctx.credentials.resolve(ACCESS_CODE))?.value ?? null
  } catch {
    return null
  }
}

/**
 * Read the complete setup status.
 * @param {object} ctx - host context with credentials.
 * @returns {Promise<object>}
 */
export async function collectStatus(ctx, options = {}) {
  const slicer = detectSlicer()
  let printer = readPrinterConfig()
  const discovered = await discoverPrinters()
  const match = printer.serial === null ? undefined : discovered.find(entry => entry.serial === printer.serial)
  if (printer.host === null && discovered.length === 1) {
    const found = discovered[0]
    printer = { model: found.model ?? 'H2D', host: found.ip, serial: found.serial }
    writePrinterConfig(printer)
  } else if (match !== undefined && match.ip !== printer.host) {
    printer = { ...printer, host: match.ip }
    writePrinterConfig(printer)
  }
  const accessCode = await readAccessCode(ctx)
  const cloudToken = await readCloudToken(ctx)
  const reach = printer.host === null
    ? { mqtt: false, ftps: false }
    : {
      mqtt: accessCode === null ? false : await mqttAuthorized(printer.host, accessCode),
      ftps: await reachable(printer.host, 990),
    }
  const current = discovered.find(entry => entry.serial === printer.serial)
  const profilesReady = printer.model !== 'H2D' || slicer.profiles.h2d
  const ready = slicer.found && profilesReady && printer.host !== null
    && printer.serial !== null && accessCode !== null && reach.mqtt
  const status = {
    ready,
    slicer,
    printer: {
      ...printer,
      name: current?.name ?? null,
      mode: current?.mode ?? null,
      hasAccessCode: accessCode !== null,
      reachable: reach,
    },
    discovered,
    cloud: { signedIn: cloudToken !== null },
    skills: [SKILL_NAME],
    downloadUrl: DOWNLOAD_URL,
    nextSteps: [],
  }
  status.nextSteps = printStudioNextSteps(status)
  return status
}

/** Read a JSON request body; malformed input is an empty object. */
async function readJson(request) {
  try {
    return await request.json()
  } catch {
    return {}
  }
}

/** JSON response helper. */
function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
}

/**
 * Publish this package's `skills/` directory as a skill provider.
 *
 * The stock provider keeps `includeDefaultRoots` off so this instance serves
 * only the files below, and a distinct `providerName` keeps it from colliding
 * with the profile's own provider. Mounting it as a child plugin ties the
 * provider's lifetime to this one.
 */
function mountSkills(ctx) {
  ctx.plugin(skillFilesystem, {
    providerName: 'rumi-print-studio',
    includeDefaultRoots: false,
    customSkillDirs: [join(import.meta.dirname, 'skills')],
  })
}

/**
 * Register the status tool, the card routes, and the setup skill.
 * @param {object} ctx - host plugin context.
 */
export function apply(ctx) {
  applyViewer(ctx, defineTool)
  const register = (path, methods, fetch) => {
    ctx.effect(() => ctx.connection.fetch.register({
      path: `${ROUTE}${path}`,
      methods,
      requestBody: 'buffered',
      fetch,
    }), `print-studio: ${ROUTE}${path}`)
  }

  register('/status', ['GET'], async (request) => {
    const refresh = new URL(request.url).searchParams.get('refresh') === '1'
    return json(await collectStatus(ctx, { refresh }))
  })

  register('/print/status', ['GET'], async () => {
    const printer = readPrinterConfig()
    const accessCode = await readAccessCode(ctx)
    if (printer.host === null || printer.serial === null) return json({ error: 'print-studio: no printer has been discovered' }, 400)
    if (accessCode === null) return json({ error: 'print-studio: the printer access code is not stored' }, 400)
    try {
      return json(await readPrinterStatus({ host: printer.host, serial: printer.serial, accessCode }))
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : String(error) }, 502)
    }
  })

  register('/print/test', ['POST'], async () => {
    try {
      return json(await printTestTile(ctx))
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : String(error) }, 502)
    }
  })

  register('/config', ['POST'], async (request) => {
    const body = await readJson(request)
    const current = readPrinterConfig()
    const model = text(body.model) ?? current.model
    const host = text(body.host) ?? current.host
    const serial = text(body.serial) ?? current.serial
    const accessCode = text(body.accessCode)
    if (!MODELS.includes(model)) return json({ error: `print-studio: unknown printer model ${model}` }, 400)
    if (host === null || serial === null) return json({ error: 'print-studio: no printer has been discovered yet' }, 400)
    if (!/^[A-Za-z0-9.-]+$/.test(host)) return json({ error: 'print-studio: printer address must be an IP address or hostname' }, 400)
    if (!/^[A-Za-z0-9]+$/.test(serial)) return json({ error: 'print-studio: printer serial must be letters and digits' }, 400)
    try {
      if (accessCode !== null) await ctx.credentials.set(ACCESS_CODE, accessCode)
    } catch (error) {
      return json({ error: `print-studio: could not store the access code: ${error instanceof Error ? error.message : String(error)}` }, 500)
    }
    writePrinterConfig({ model, host, serial })
    return json(await collectStatus(ctx))
  })

  register('/cloud/refresh', ['POST'], async () => {
    const token = await readCloudToken(ctx)
    if (token === null) return json({ error: 'print-studio: not signed in' }, 400)
    try {
      await adoptCloud(ctx, token)
      return json(await collectStatus(ctx))
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : String(error) }, 502)
    }
  })

  register('/cloud/complete', ['POST'], async (request) => {
    const body = await readJson(request)
    try {
      const token = await loginMessageToken(body.message)
      await adoptCloud(ctx, token)
      return json(await collectStatus(ctx))
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : String(error) }, 502)
    }
  })

  register('/cloud/signout', ['POST'], async () => {
    await ctx.credentials.unset(CLOUD_TOKEN)
    return json(await collectStatus(ctx))
  })

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'print_studio_status',
    description: 'Report Print Studio setup: the installed Bambu Studio and H2D profiles, the configured Bambu printer, LAN reachability, and the next setup step. Call this before guiding anyone through 3D printing setup.',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    isConcurrencySafe: () => true,
    timeoutMs: 20_000,
    execute: async () => JSON.stringify(await collectStatus(ctx), undefined, 2),
  })), 'print-studio: status tool')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'print_studio_print_test',
    description: 'Slice a bundled five-minute test tile for the configured Bambu H2D and open Bambu Connect for the adult to confirm Send. Use only after print_studio_status reports ready.',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    isConcurrencySafe: () => false,
    timeoutMs: 120_000,
    execute: async () => JSON.stringify(await printTestTile(ctx), undefined, 2),
  })), 'print-studio: test print tool')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'print_studio_progress',
    description: 'Read the live print state, progress, layers, remaining time, temperatures, AMS trays, and errors from the configured Bambu printer.',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    isConcurrencySafe: () => true,
    timeoutMs: 15_000,
    execute: async () => {
      const printer = readPrinterConfig()
      const accessCode = await readAccessCode(ctx)
      if (printer.host === null || printer.serial === null || accessCode === null) throw new Error('Print Studio has no configured printer')
      return JSON.stringify(await readPrinterStatus({ host: printer.host, serial: printer.serial, accessCode }), undefined, 2)
    },
  })), 'print-studio: progress tool')

  mountSkills(ctx)
}
