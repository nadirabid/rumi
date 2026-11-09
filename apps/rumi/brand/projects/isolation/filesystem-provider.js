/** File tools enforce the same owning-project boundary on reads as on writes. */
import { resolve } from 'node:path'

/** Bind the provider to the shipped service definitions. @param {object} dependencies Service bases and schemas. @returns {Function} Cordis provider. */
export function createProjectFileSystem({ LocalFileSystem }) {
  return class ProjectFileSystem extends LocalFileSystem {
    static inject = ['rumiProjectScope']
    /** Advertise confined execution. @returns {string} Standing file policy. */
    get sandboxMode() { return 'workspace-write' }
    /** Canonicalize and check before disclosing a target. @param {string} path Candidate. @param {object} options Resolution options. @returns {Promise<object>} Checked target. */
    async resolve(path, options) {
      const target = await super.resolve(path, options)
      this.ctx.rumiProjectScope.check(String(target.targetKey), false)
      return target
    }
    /** Refresh filesystem identity immediately before an operation. @param {object} target Original target. @param {boolean} write Mutation flag. @returns {Promise<object>} Checked target. */
    async checked(target, write) {
      const fresh = await super.resolve(String(target.targetKey))
      this.ctx.rumiProjectScope.check(String(fresh.targetKey), write)
      return fresh
    }
    async stat(target, signal) { return super.stat(await this.checked(target, false), signal) }
    async lstat(path, options, signal) {
      this.ctx.rumiProjectScope.check(resolve(options?.cwd || this.config.cwd, path), false)
      return super.lstat(path, options, signal)
    }
    async readText(target, signal) { return super.readText(await this.checked(target, false), signal) }
    async streamText(target, signal) { return super.streamText(await this.checked(target, false), signal) }
    async readBytes(target, signal, maxBytes) { return super.readBytes(await this.checked(target, false), signal, maxBytes) }
    async readByteRange(target, range, signal) { return super.readByteRange(await this.checked(target, false), range, signal) }
    async listDir(target, signal) {
      const entries = await super.listDir(await this.checked(target, false), signal)
      return entries.filter(entry => {
        try { this.ctx.rumiProjectScope.check(String(entry.target.targetKey), false); return true }
        catch (error) { if (error.code === 'RUMI_PROJECT_ACCESS_DENIED') return false; throw error }
      })
    }
    async writeText(target, content, expected, signal) { return super.writeText(await this.checked(target, true), content, expected, signal) }
    async editText(target, edit, expected, signal) { return super.editText(await this.checked(target, true), edit, expected, signal) }
    async watch(target, changed, signal) { return super.watch(await this.checked(target, false), changed, signal) }
    processPath(target) { this.ctx.rumiProjectScope.check(String(target.targetKey), false); return super.processPath(target) }
    processPathFromHostPath(path) { this.ctx.rumiProjectScope.check(path, false); return super.processPathFromHostPath(path) }
  }
}
