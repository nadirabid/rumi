/** Agent-controlled validation shares revision receipts and never starts follow-up turns. */
const tools = {
  mechanics: ['Test physical mechanics',
    'Run the whole-assembly Bullet contact, retention, movement, sequence and declared removal-path probes for the saved model at `path`. First runs any missing Blender checks (assembly declarations, Toolbox geometry, clearance and printer fit) for the current revision and stops with their findings, without starting Bullet, if one has a blocking error. Call once, after the design is ready and the latest publish prints no blocking RUMI_CHECKS. Can take up to the configured mechanics timeout (normally ten minutes); results are cached per revision. Returns `path` and `fingerprint` for validation_accept.',
    { path: { type: 'string', required: true, description: 'Saved model path, for example models/car/model.usda.' } }],
  accept: ['Record validation acceptance',
    'Check that the exact revision returned by validation_mechanics has passing assembly, geometry, fit and complete mechanical results and preserved movement intent, then save its accepted snapshot. Runs no Blender or Bullet; reports what is missing instead of running it. Acceptance does not certify strength, slicing or print readiness.',
    { path: { type: 'string', required: true, description: 'Model path returned by validation_mechanics.' },
      fingerprint: { type: 'string', required: true, description: 'Revision fingerprint returned by validation_mechanics.' } }],
}

/** Register the mechanics and acceptance tools; failures are reported by the tool runtime and cancellation drains children.
 * @param {object} ctx Plugin tool registry owner.
 * @param {Function} defineTool Harness tool definition helper.
 * @param {object} validation Session validation owner.
 * @param {object} config Resolved subprocess timeouts.
 */
export function registerValidationTools(ctx, defineTool, validation, config) {
  for (const [stage, [title, description, parameters]] of Object.entries(tools)) ctx.effect(() => ctx.tools.register(defineTool({
    name: `validation_${stage}`, description, parameters,
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    presentCall: () => ({ card: 'generic', title, kind: stage === 'accept' ? 'write' : 'read' }),
    isConcurrencySafe: () => false,
    timeoutMs: config.mechanicsTimeoutMs + config.validationTimeoutMs * 3,
    async execute(args, exec) {
      const cwd = await ctx.workingDirectory.ensure(exec.agent, exec.signal)
      return JSON.stringify(await validation.execute(exec.agent.session.id, cwd, stage, args, exec.signal))
    },
  })), `print-studio: validation ${stage}`)
}
