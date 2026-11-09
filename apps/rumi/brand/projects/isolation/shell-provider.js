/** Shell execution cannot widen its project scope, including direct calls and background jobs. */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { checkedPath } from './paths.js'

/** Bind the provider to the shipped service definitions. @param {object} dependencies Service bases and schemas. @returns {Function} Cordis provider. */
export function createProjectShell({ SandboxBashExecutor }) {
  return class ProjectShell extends SandboxBashExecutor {
    static inject = ['subprocess', 'sandbox', 'sandboxPolicy', 'rumiProjectScope']
    /** Resolve all paths and environment before admission. @param {object} request Shell request. @returns {object} Project-confined execution spec. */
    resolve(request) {
      const root = this.ctx.rumiProjectScope.activeRoot()
      if (!root) throw new Error('Project isolation requires a project-owned command')
      const workdir = checkedPath(root, request.workdir || root, true, [])
      const temporary = checkedPath(root, '.rumi/tmp', true, [])
      mkdirSync(temporary, { recursive: true, mode: 0o700 })
      const policy = this.ctx.sandboxPolicy.resolve()
      return super.resolve({ ...request, workdir, sandboxPolicy: policy,
        dshEnv: { ...request.dshEnv, TMPDIR: temporary, TMP: temporary, TEMP: temporary, HOME: root,
          XDG_CACHE_HOME: join(temporary, 'cache'), PYTHONDONTWRITEBYTECODE: '1' } })
    }
    /** Recheck the scope at execution, so hand-built specs cannot disable confinement. @param {object} spec Resolved request. @returns {Promise<object>} Existing owned execution handle. */
    execute(spec) {
      const root = this.ctx.rumiProjectScope.activeRoot()
      if (!root || spec.sandboxPolicy?.mode !== 'workspace-write' || spec.sandboxPolicy.workspaceRoot !== root) throw new Error('Project isolation rejected an unrestricted command')
      checkedPath(root, spec.workdir, true, [])
      return super.execute(spec)
    }
  }
}
