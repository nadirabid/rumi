/** Verified, user-owned installation of Bambu Studio without administrator access. */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, existsSync } from 'node:fs'
import { mkdir, mkdtemp, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { findBambuStudio, managedAppRoot } from './probe.js'

const run = promisify(execFile)
/** Bambu Studio: one universal dmg from the project's GitHub release. */
const studio = {
  appName: 'BambuStudio.app',
  url: 'https://github.com/bambulab/BambuStudio/releases/download/v02.09.01.70/Bambu_Studio_mac-v02.09.01.70-20261103183404.dmg',
  hash: 'e4f42ac1542cb107cb21cbf98717de7b17e735bdb46fd2a18249e30929e3310d',
  requirement: 'anchor apple generic and identifier "com.bambulab.bambu-studio" and certificate leaf[subject.OU] = "T3UBR9Y3B2"',
}

/** Verify the archive before mounting it. @param {string} path @param {string} expected */
export async function verifyArchive(path, expected) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  if (hash.digest('hex') !== expected) throw new Error('Bambu Studio download checksum mismatch')
}

/**
 * Concurrent installation requests share one operation. Disposal waits for installation
 * and staging cleanup. The installer publishes the new app only after verification.
 * @param {{ downloadTimeoutSeconds: number, downloadRetries: number }} config
 * @returns {object} Status, start, and asynchronous disposal methods.
 */
export function createAppSetup(config) {
  let state = { phase: 'idle', error: null }
  let pending = null
  let disposed = false
  const root = managedAppRoot()
  const env = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: process.env.HOME, TMPDIR: process.env.TMPDIR }
  const command = (file, args, timeout = 600000) => run(file, args, { env, timeout, maxBuffer: 1024 * 1024 })
  const stage = phase => {
    if (disposed) throw new Error('Bambu Studio setup stopped')
    state = { phase, error: null }
  }
  async function install() {
    let work
    let mounted = false
    try {
      if (process.platform !== 'darwin') {
        state = { phase: 'failed', error: 'unsupported' }
        return
      }
      if (findBambuStudio() !== null) { state = { phase: 'ready', error: null }; return }
      stage('downloading')
      await mkdir(root, { recursive: true, mode: 0o700 })
      work = await mkdtemp(join(root, '.setup-'))
      const archive = join(work, 'app.dmg')
      const mount = join(work, 'volume')
      await command('/usr/bin/curl', ['--fail', '--location', '--silent', '--show-error', '--proto', '=https', '--proto-redir', '=https',
        '--connect-timeout', '30', '--max-time', String(config.downloadTimeoutSeconds), '--retry', String(config.downloadRetries),
        '--retry-max-time', String(config.downloadTimeoutSeconds), '--output', archive, studio.url], (config.downloadTimeoutSeconds * 2 + 30) * 1000)
      stage('verifying')
      await verifyArchive(archive, studio.hash)
      await mkdir(mount)
      await command('/usr/bin/hdiutil', ['attach', archive, '-readonly', '-nobrowse', '-mountpoint', mount])
      mounted = true
      const app = join(work, studio.appName)
      await command('/usr/bin/ditto', [join(mount, studio.appName), app])
      await command('/usr/bin/codesign', ['--verify', '--deep', '--strict', '-R', `=${studio.requirement}`, app])
      await command('/usr/sbin/spctl', ['--assess', '--type', 'execute', app])
      await command('/usr/bin/hdiutil', ['detach', mount])
      mounted = false
      stage('installing')
      const destination = join(root, studio.appName)
      if (existsSync(destination)) throw Object.assign(new Error('Bambu Studio installation directory already exists'), { code: 'destinationExists' })
      await rename(app, destination)
      state = { phase: 'ready', error: null }
    } catch (error) {
      console.warn('Print Studio: Bambu Studio setup failed', error)
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
    status: () => ({ ...state, installed: findBambuStudio() !== null }),
    start() {
      if (disposed) return
      if (pending === null) pending = install().finally(() => { pending = null })
      return pending
    },
    async dispose() { disposed = true; await pending },
  }
}
