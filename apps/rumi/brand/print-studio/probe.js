/** Print Studio probes: slicer detection, printer profile storage, and setup steps. */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { connect } from 'node:net'
import dgram from 'node:dgram'
import { connect as tlsConnect } from 'node:tls'
import { randomBytes } from 'node:crypto'

/** Where Bambu Studio can be installed on this Mac. */
export const DOWNLOAD_URL = 'https://bambulab.com/en/download/studio'

/** Printer profiles Print Studio knows how to configure. */
export const MODELS = ['H2D', 'X1C', 'X1E', 'P1S', 'P1P', 'A1', 'A1 mini', 'H2S', 'X2D']

const BAMBU_APPS = ['/Applications/BambuStudio.app', join(homedir(), 'Applications', 'BambuStudio.app')]

/** @param {unknown} value @returns {string | null} */
export function text(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

/** @param {string} path @param {string} key @returns {string | null} */
function plistValue(path, key) {
  try {
    return text(execFileSync('/usr/bin/plutil', ['-extract', key, 'raw', path], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }))
  } catch {
    return null
  }
}

/** Walk a directory without following links; returns absolute file paths. */
function filesUnder(root, depth = 4) {
  /** @type {string[]} */
  const files = []
  if (!existsSync(root)) return files
  /** @param {string} directory @param {number} level */
  const visit = (directory, level) => {
    if (level > depth) return
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) visit(path, level + 1)
      else if (entry.isFile()) files.push(path)
    }
  }
  visit(root, 0)
  return files
}

/** Profile counts and H2D presence for one slicer installation. */
function profileReport(appPath) {
  const root = join(appPath, 'Contents', 'Resources', 'profiles')
  const files = filesUnder(root, 5)
  const json = files.filter(file => file.endsWith('.json'))
  const inFolder = (folder) => json.filter(file => file.split('/').includes(folder)).length
  return {
    root: existsSync(root) ? root : null,
    h2d: files.some(file => /h2d/i.test(file)),
    machines: inFolder('machine'),
    processes: inFolder('process'),
    filaments: inFolder('filament'),
  }
}

/** Detect one slicer application. */
function detectApp(candidate, binary, displayName, id) {
  for (const appPath of candidate) {
    const executable = join(appPath, 'Contents', 'MacOS', binary)
    if (!existsSync(executable)) continue
    return {
      id,
      name: displayName,
      found: true,
      path: appPath,
      executable,
      version: plistValue(join(appPath, 'Contents', 'Info.plist'), 'CFBundleShortVersionString'),
      profiles: profileReport(appPath),
    }
  }
  return {
    id,
    name: displayName,
    found: false,
    path: null,
    executable: null,
    version: null,
    profiles: { root: null, h2d: false, machines: 0, processes: 0, filaments: 0 },
  }
}

/**
 * Detect the installed Bambu Studio.
 * @param {{ bambuApps?: readonly string[] }} [options]
 * @returns {object} Bambu Studio installation and profile report.
 */
export function detectSlicer(options = {}) {
  return detectApp(options.bambuApps ?? BAMBU_APPS, 'BambuStudio', 'Bambu Studio', 'bambu')
}

/** Harness home used when the caller does not supply one. */
function defaultHome() {
  const configured = process.env.DSH_HOME?.trim()
  return configured === undefined || configured === '' ? join(homedir(), '.rumi') : configured
}

/** Where the printer profile is stored, owner-only. */
export function printerConfigPath(home = defaultHome()) {
  return join(home, 'print-studio', 'printer.json')
}

/** Read the saved printer profile, or empty values when absent or invalid. */
export function readPrinterConfig(home = defaultHome()) {
  try {
    const value = JSON.parse(readFileSync(printerConfigPath(home), 'utf8'))
    return {
      model: text(value?.model) ?? 'H2D',
      host: text(value?.host),
      serial: text(value?.serial),
    }
  } catch {
    return { model: 'H2D', host: null, serial: null }
  }
}

/** Write the printer profile owner-only. */
export function writePrinterConfig(config, home = defaultHome()) {
  const path = printerConfigPath(home)
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(path, `${JSON.stringify(config, undefined, 2)}\n`, { mode: 0o600 })
}

/** Model code to Print Studio's printer profile name. */
const MODEL_BY_PREFIX = { '094': 'H2D' }

/** Normalize one SSDP response from a Bambu printer. */
export function parsePrinterResponse(response, ip) {
  if (!/bambulab|bambu/i.test(response)) return null
  const serial = /USN:\s*(?:uuid:)?([^\s\r\n]+)/i.exec(response)?.[1]?.trim()
  if (serial === undefined || serial === '') return null
  const header = (name) => new RegExp(`${name}\\.bambu\\.com:\\s*(.+?)(?:\\r\\n|\\n|$)`, 'i').exec(response)?.[1]?.trim() ?? null
  const devModel = header('DevModel')
  const name = header('DevName') ?? serial
  const mode = (header('DevConnect') ?? '').toLowerCase() || null
  const model = MODEL_BY_PREFIX[serial.slice(0, 3)]
    ?? (devModel !== null && MODELS.includes(devModel) ? devModel : null)
  return { serial, name, ip, devModel, model, mode }
}

/**
 * Discover Bambu printers on the local network with SSDP.
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<object[]>} printers keyed by serial.
 */
export function discoverPrinters(options = {}) {
  const timeoutMs = options.timeoutMs ?? 2200
  return new Promise((resolve) => {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true })
    const found = new Map()
    let settled = false
    let timer
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { socket.close() } catch { /* already closed */ }
      resolve([...found.values()])
    }
    socket.on('message', (message, rinfo) => {
      const printer = parsePrinterResponse(message.toString('utf8'), rinfo.address)
      if (printer === null) return
      found.set(printer.serial, printer)
      // One printer is enough to answer; keep a short window for a second one.
      clearTimeout(timer)
      timer = setTimeout(finish, 350)
    })
    socket.on('error', finish)
    socket.bind(0, () => {
      socket.setBroadcast(true)
      const search = 'M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:2021\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: urn:bambulab-com:device:3dprinter:1\r\n\r\n'
      const sent = () => {}
      try { socket.send(search, 2021, '239.255.255.250', sent) } catch { /* best-effort multicast */ }
      try { socket.send(search, 2021, '255.255.255.255', sent) } catch { /* best-effort broadcast */ }
      timer = setTimeout(finish, timeoutMs)
    })
  })
}



/** Remaining-length varint for one MQTT control packet. */
function remainingLength(value) {
  const bytes = []
  let length = value
  do {
    let byte = length % 128
    length = Math.floor(length / 128)
    if (length > 0) byte |= 0x80
    bytes.push(byte)
  } while (length > 0)
  return Buffer.from(bytes)
}

/** A minimal MQTT 3.1.1 CONNECT for Bambu's `bblp` user. */
export function mqttConnectPacket(accessCode, clientId = `print-studio-${randomBytes(4).toString('hex')}`) {
  const protocol = Buffer.from([0x00, 0x04, 0x4d, 0x51, 0x54, 0x54, 0x04, 0xc2, 0x00, 0x1e])
  const payload = (value) => Buffer.concat([Buffer.from([value.length >> 8, value.length & 0xff]), Buffer.from(value)])
  const body = Buffer.concat([protocol, payload(clientId), payload('bblp'), payload(accessCode)])
  return Buffer.concat([Buffer.from([0x10]), remainingLength(body.length), body])
}

/**
 * Check that the printer accepts the LAN access code over MQTT.
 * @param {string} host - printer address.
 * @param {string} accessCode - LAN access code.
 * @param {number} [timeoutMs] - TLS and CONNACK deadline.
 * @returns {Promise<boolean>} whether the printer returned a successful CONNACK.
 */
export function mqttAuthorized(host, accessCode, timeoutMs = 2500) {
  return new Promise((resolve) => {
    let settled = false
    let socket
    try {
      socket = tlsConnect({ host, port: 8883, rejectUnauthorized: false })
    } catch {
      resolve(false)
      return
    }
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      resolve(value)
    }
    const timer = setTimeout(() => finish(false), timeoutMs)
    socket.once('secureConnect', () => {
      socket.write(mqttConnectPacket(accessCode))
    })
    socket.once('data', (data) => {
      // CONNACK: 0x20, length 2, session-present, return code 0.
      const ok = data.length >= 4 && data[0] === 0x20 && data[1] === 0x02 && data[3] === 0x00
      if (ok) socket.write(Buffer.from([0xe0, 0x00]))
      finish(ok)
    })
    socket.once('error', () => finish(false))
  })
}

/** A short TCP reachability probe for one printer port. */
export function reachable(host, port, timeoutMs = 1200) {
  return new Promise((resolve) => {
    const socket = connect({ host, port })
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
  })
}

/**
 * Turn a status report into the ordered setup steps a person should see.
 * @param {object} status - result of the host status collector.
 * @returns {{ id: string, title: string, detail: string }[]}
 */
export function printStudioNextSteps(status) {
  const steps = []
  const discovered = status.discovered ?? []
  const slicer = status.slicer
  if (!slicer.found) {
    steps.push({ id: 'install-bambu', title: 'Install Bambu Studio', detail: `Download it from ${DOWNLOAD_URL}, open it once, and add the printer.` })
  } else if (status.printer.model === 'H2D' && !slicer.profiles.h2d) {
    steps.push({ id: 'missing-profiles', title: 'Add the H2D in Bambu Studio', detail: 'Open Bambu Studio once with the H2D selected so it writes the H2D profiles, then check again.' })
  }
  if (status.printer.host === null && discovered.length === 0) {
    steps.push({ id: 'find-printer', title: 'Turn the printer on', detail: 'Print Studio looks for the printer on this network automatically. Check that it is on and joined to the same Wi-Fi, then scan again.' })
  } else if (status.printer.host === null && discovered.length > 1) {
    steps.push({ id: 'choose-printer', title: 'Choose the printer', detail: 'More than one Bambu printer is on this network. Pick the one to use.' })
  }
  if (status.printer.host !== null && !status.printer.hasAccessCode) {
    steps.push(status.cloud?.signedIn
      ? { id: 'cloud-no-printer', title: 'No bound printer found', detail: 'Sign in with the Bambu account that owns this printer, or enter the printer code manually.' }
      : { id: 'cloud-sign-in', title: 'Sign in with your Bambu account', detail: 'Print Studio uses the account only to fetch the printer’s access code. The code is stored in the app credentials.' })
  } else if (status.printer.host !== null && !status.printer.reachable.mqtt) {
    steps.push({ id: 'auth-failed', title: 'Could not connect to the printer', detail: 'Check that the printer is on and on the same network. On macOS, allow Rumi in Privacy & Security → Local Network. If the printer is reachable, check its LAN access code and LAN or Developer Mode settings.' })
  }
  return steps
}
