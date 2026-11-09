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
import { homedir } from 'node:os'
import z from '@deepseek-ai/schemastery'
import * as skillFilesystem from '@deepseek-ai/dsh-skill-filesystem'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createDeveloperMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import {
  DOWNLOAD_URL, MODELS, detectSlicer, discoverPrinters, mqttAuthorized, printStudioNextSteps, reachable, readPrinterConfig, text, writePrinterConfig,
} from './probe.js'
import { loginMessageToken, accessCodeFor, devices as cloudDevices } from './cloud.js'
import { sliceMesh } from './slicer.js'
import { handoffToBambuConnect, hasBambuConnect } from './connect.js'
import { readPrinterStatus } from './monitor.js'
import { applyBlender } from './blender/host.js'
import { applyViewer } from './viewer/host.js'
import { applyContextRetention } from './viewer/context-retention.js'
import * as analogWorkflow from './viewer/analog/workflow.js'
import * as mechanicalWorkflow from './bullet/workflow.js'

/** The plugin row id, also the card identity. */
export const name = 'print-studio'

/** Print Studio diagnostics, validation policy, and app-owned storage paths. */
export const Config = z.object({
  blenderExecutable: z.string().default(''),
  bulletExecutable: z.string().default(''),
  blenderHome: z.string().default(process.env.DSH_RUMI_HOME || join(homedir(), '.rumi')),
  validationStateDirectory: z.string().min(1).default(join(process.env.DSH_RUMI_HOME || join(homedir(), '.rumi'), 'validation')),
  validationRepairAttempts: z.number().step(1).min(0).max(10).default(5),
  validationTimeoutMs: z.number().step(1).min(1000).max(300000).default(60000),
  mechanicsTimeoutMs: z.number().step(1).min(1000).max(600000).default(300000),
  mechanics: z.object({
    maxTotalSteps: z.number().step(1).min(1000).max(10000000).default(2000000),
    retentionWorkers: z.number().step(1).min(1).max(4).default(2),
    gravityMps2: z.tuple([z.number().min(-20).max(20), z.number().min(-20).max(20), z.number().min(-20).max(20)]).default([0, 0, -9.81]),
    friction: z.number().min(0).max(1).default(0.2),
    movementSampleDegrees: z.number().min(1).max(90).default(15),
    movementSampleMm: z.number().min(0.1).max(10).default(2),
    assemblySampleMm: z.number().min(0.01).max(2).default(0.2),
    timeStepSeconds: z.number().min(0.0001).max(0.001).default(0.00025),
    iterations: z.number().step(1).min(10).max(100).default(40),
    restDurationSeconds: z.number().min(0.01).max(0.1).default(0.02),
    retentionDurationSeconds: z.number().min(0.02).max(0.2).default(0.05),
    probeDurationSeconds: z.number().min(0.1).max(2).default(0.5),
    densityKgM3: z.number().min(100).max(20000).default(1250),
    forceN: z.number().min(0.001).max(10).default(1),
    torqueNm: z.number().min(0.000001).max(1).default(0.05),
    linearToleranceMm: z.number().min(0.01).max(2).default(0.5),
    angularToleranceDegrees: z.number().min(0.1).max(10).default(5),
    maxPenetrationMm: z.number().min(0.001).max(0.5).default(0.05),
  }).default({}),
  validation: z.object({
    minimumThicknessMm: z.number().min(0.01).max(10).default(1),
    degenerateThreshold: z.number().min(0.000000001).max(0.1).default(0.000001),
    overhangDegrees: z.number().min(1).max(89).default(45),
    sharpDegrees: z.number().min(1).max(180).default(160),
    distortionDegrees: z.number().min(1).max(89).default(45),
  }).default({}),
  viewerLoadTimeoutMs: z.number().step(1).min(1).max(25000).default(8000),
  viewerDiagnosticsDirectory: z.string().default(join(homedir(), '.rumi', 'viewer-logs')),
})

/** Services this host half reaches. */
export const inject = ['connection', 'tools', 'credentials', 'fs', 'workingDirectory', 'sessionQuery', 'attachments', 'agents']

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
 * What a 3D-printing project adds to the instructions every project carries.
 *
 * The template next to this file becomes part of the project's `AGENTS.md` at
 * creation, beside the frame Rumi's own plugin writes, so a Session starts
 * knowing which project it is in and what the print plugin provides.
 */
const PRINT_TYPE = {
  id: 'print',
  label: '3D printing',
  isDefault: true,
  templates: [join(import.meta.dirname, 'AGENTS_TEMPLATE.md')],
}

/**
 * Register the status tool, the card routes, and the setup skill.
 * @param {object} ctx - host plugin context.
 * @param {object} config - Resolved plugin configuration.
 */
export function apply(ctx, config) {
  ctx.plugin(analogWorkflow)
  ctx.plugin(mechanicalWorkflow)
  applyViewer(ctx, defineTool, config.viewerDiagnosticsDirectory, config.viewerLoadTimeoutMs, config, createUserMessage)
  ctx.inject(['sessionProjections'], scoped => applyContextRetention(scoped, createDeveloperMessage))
  applyBlender(ctx, defineTool, config)
  // A project-type plugin contributes; it does not own the creation flow.
  ctx.inject(['rumiProjectTypes'], (scoped) => {
    scoped.effect(() => scoped.rumiProjectTypes.register(PRINT_TYPE), 'print-studio: project type')
  })
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
