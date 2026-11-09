/** Rumi sessions cannot widen their filesystem policy through saved presets or tool overrides. */

/** Bind the provider to the shipped service definitions. @param {object} dependencies Service bases and schemas. @returns {Function} Cordis provider. */
export function createProjectPolicy({ SandboxPolicyService }) {
  return class ProjectPolicy extends SandboxPolicyService {
    static inject = ['sessionProjections', 'rumiProjectScope']
    constructor(ctx, config) { super(ctx, { ...config, mode: 'workspace-write' }) }
    /** Resolve the immutable project limit. @param {object} request Calling session and requested override. @returns {object} Confined policy. */
    resolve(request = {}) {
      const root = request.session ? this.ctx.rumiProjectScope.rootFor(request.session) : this.ctx.rumiProjectScope.activeRoot()
      if (!root) throw new Error('Project isolation requires a project session')
      return { mode: 'workspace-write', workspaceRoot: root, ...(request.session ? { sessionId: request.session.id } : {}) }
    }
    /** Saved broader modes do not override project isolation. @returns {string} Enforced mode. */
    overrideOf() { return 'workspace-write' }
  }
}
