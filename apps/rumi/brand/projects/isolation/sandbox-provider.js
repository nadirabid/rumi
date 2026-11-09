/** Kernel confinement for model-controlled processes and all of their descendants. */
import { canonical, seatbeltProfile } from './paths.js'

/** Bind the provider to the shipped service definitions. @param {object} dependencies Service bases and schemas. @returns {Function} Cordis provider. */
export function createProjectSandbox({ SandboxProvider }) {
  return class ProjectSandbox extends SandboxProvider {
    static inject = ['rumiProjectScope']
    /** Wrap one process. @param {string[]} argv Child command. @param {object} policy Resolved project policy. @param {AbortSignal} signal Cancellation. @returns {Promise<object>} Enforcing argv and denial diagnostics. */
    async confine(argv, policy, signal) {
      signal?.throwIfAborted()
      const root = this.ctx.rumiProjectScope.activeRoot()
      if (!root || canonical(policy.workspaceRoot) !== root || policy.mode !== 'workspace-write') throw new Error('Project isolation rejected an unbound process')
      return { argv: ['/usr/bin/sandbox-exec', '-p', seatbeltProfile(root, this.ctx.rumiProjectScope.runtimeRoots), ...argv],
        enforcement: 'full', denialSignatures: ['operation not permitted', 'permission denied'],
        runnerFailureRules: [{ fatalSignatures: ['sandbox-exec: sandbox_apply:', 'sandbox-exec: execvp:', 'sandbox-exec: invalid profile'] }] }
    }
  }
}
