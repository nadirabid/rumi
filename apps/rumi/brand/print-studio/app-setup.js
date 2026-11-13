/** Verified, user-owned installation of Bambu apps; no administrator access is required. */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, existsSync } from 'node:fs'
import { mkdir, mkdtemp, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { managedAppRoot, findBambuConnect } from './connect.js'
import { findBambuStudio } from './probe.js'

const run = promisify(execFile)
const connectVersion = '2.5.0-beta.15'
const connectHashes = {
  arm64: '3f3398d1fc3f087f0317e82cf788b741b7ac83c9461a7ac3755d011a1f1890b6',
  x64: 'ec3fca35f3d655451cb44b6ca5a7429fbabd9ff6df7cf30ac2b8aa070f1eaa33',
}
const studioHash = 'cf648a95858fb630e1353c4987038df60d6caab693f18411fb95fb809f2d6926'
const bambuTeam = 'T3UBR9Y3B2'

/** Bambu Connect: one dmg per architecture from Bambu's CDN. */
export const connectSpec = {
  label: 'Bambu Connect',
  appName: 'Bambu Connect.app',
  url: arch => `https://public-cdn.bblmw.com/upgrade/bambu-connect/updates/versions/${connectVersion}/bambu-connect-v${connectVersion}-darwin-${arch}.dmg`,
  hash: arch => connectHashes[arch],
  requirement: `anchor apple generic and identifier "com.bambulab.bambu-connect" and certificate leaf[subject.OU] = "${bambuTeam}"`,
  find: findBambuConnect,
}

/** Bambu Studio: one universal dmg from the project's GitHub release. */
export const studioSpec = {
  label: 'Bambu Studio',
  appName: 'BambuStudio.app',
  url: () => 'https://github.com/bambulab/BambuStudio/releases/download/v02.08.02.61/Bambu_Studio_mac-v02.08.02.61-20260820225108.dmg',
  hash: () => studioHash,
  requirement: `anchor apple generic and identifier "com.bambulab.bambu-studio" and certificate leaf[subject.OU] = "${bambuTeam}"`,
  find: findBambuStudio,
}

/** Verify the archive before mounting it. @param {string} path @param {string} expected */
export async function verifyArchive(path, expected, label = 'Bambu') {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  if (hash.digest('hex') !== expected) throw new Error(`${label} download checksum mismatch`)
}

/**
 * Create one plugin-owned installer for one app. Concurrent requests share one operation;
 * disposal waits for bounded subprocesses and cleanup. Failure leaves existing apps untouched.
 * @param {{ label: string, appName: string, url: (arch: string) => string, hash: (arch: string) => string | undefined,
 *   requirement: string, find: () => string | null }} spec - the application to install.
 * @param {{ downloadTimeoutSeconds: number, downloadRetries: number }} config
 * @returns {object} Status, start, and asynchronous disposal methods.
 */
export function createAppSetup(spec, config) {
  let state = { phase: 'idle', error: null }
  let pending = null
  let disposed = false
  const root = managedAppRoot()
  const env = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: process.env.HOME, TMPDIR: process.env.TMPDIR }
  const command = (file, args, timeout = 600000) => run(file, args, { env, timeout, maxBuffer: 1024 * 1024 })
  const stage = phase => {
    if (disposed) throw new Error(`${spec.label} setup stopped`)
    state = { phase, error: null }
  }
  async function install() {
    let work
    let mounted = false
    try {
      if (process.platform !== 'darwin' || spec.hash(process.arch) === undefined) {
        state = { phase: 'failed', error: 'unsupported' }
        return
      }
      if (spec.find() !== null) { state = { phase: 'ready', error: null }; return }
      stage('downloading')
      await mkdir(root, { recursive: true, mode: 0o700 })
      work = await mkdtemp(join(root, '.setup-'))
      const archive = join(work, 'app.dmg')
      const mount = join(work, 'volume')
      const url = spec.url(process.arch)
      await command('/usr/bin/curl', ['--fail', '--location', '--silent', '--show-error', '--proto', '=https', '--proto-redir', '=https',
        '--connect-timeout', '30', '--max-time', String(config.downloadTimeoutSeconds), '--retry', String(config.downloadRetries),
        '--retry-max-time', String(config.downloadTimeoutSeconds), '--output', archive, url], (config.downloadTimeoutSeconds * 2 + 30) * 1000)
      stage('verifying')
      await verifyArchive(archive, spec.hash(process.arch), spec.label)
      await mkdir(mount)
      await command('/usr/bin/hdiutil', ['attach', archive, '-readonly', '-nobrowse', '-mountpoint', mount])
      mounted = true
      const app = join(work, spec.appName)
      await command('/usr/bin/ditto', [join(mount, spec.appName), app])
      await command('/usr/bin/codesign', ['--verify', '--deep', '--strict', '-R', `=${spec.requirement}`, app])
      await command('/usr/sbin/spctl', ['--assess', '--type', 'execute', app])
      await command('/usr/bin/hdiutil', ['detach', mount])
      mounted = false
      stage('installing')
      const destination = join(root, spec.appName)
      if (existsSync(destination)) throw Object.assign(new Error(`${spec.label} installation directory already exists`), { code: 'destinationExists' })
      await rename(app, destination)
      state = { phase: 'ready', error: null }
    } catch (error) {
      console.warn(`Print Studio: ${spec.label} setup failed`, error)
      // A failed setup never publishes its staged app; callers receive a stable error code.
      state = { phase: 'failed', error: disposed ? 'stopped' : error.code === 'destinationExists' ? 'destinationExists' : 'setupFailed' }
    } finally {
      if (mounted) {
        try { await command('/usr/bin/hdiutil', ['detach', join(work, 'volume')]) }
        catch (error) {
          // Retain the private staging directory while the volume remains mounted.
          state = { phase: 'failed', error: 'cleanupFailed' }
          return
        }
      }
      if (work !== undefined) {
        try { await rm(work, { recursive: true, force: true }) }
        catch (error) { state = { phase: 'failed', error: 'cleanupFailed' } }
      }
    }
  }
  return {
    status: () => ({ ...state, installed: spec.find() !== null }),
    start() {
      if (disposed) return
      if (pending === null) pending = install().finally(() => { pending = null })
      return pending
    },
    async dispose() { disposed = true; await pending },
  }
}
