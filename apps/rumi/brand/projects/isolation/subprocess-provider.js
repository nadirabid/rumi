/** All model-owned subprocesses share the kernel policy, including search tools. */
import { mkdirSync } from 'node:fs'
import { checkedPath, seatbeltProfile } from './paths.js'

/** Bind the subprocess implementation without changing its owned lifecycle.
 * @param {object} dependencies Existing local subprocess implementation.
 * @returns {Function} Project-confined provider.
 */
export function createProjectSubprocess({ LocalSubprocessRuntime }) {
  return class ProjectSubprocess extends LocalSubprocessRuntime {
    static inject = ['rumiProjectScope']
    /** Resolve confinement for tool-owned processes; host-owned startup stays privileged.
     * @param {object} spec Existing resolved process request.
     * @returns {object} Process request with inherited OS confinement.
     */
    confined(spec) {
      const scope = this.ctx.rumiProjectScope, root = scope.activeRoot()
      if (root === undefined) return spec
      checkedPath(root, spec.cwd, false, scope.runtimeRoots)
      const temporary = checkedPath(root, '.rumi/tmp', true, [])
      mkdirSync(temporary, { recursive: true, mode: 0o700 })
      const profile = seatbeltProfile(root, scope.runtimeRoots)
      const alreadyConfined = spec.argv[0] === '/usr/bin/sandbox-exec' && spec.argv[1] === '-p' && spec.argv[2] === profile
      return { ...spec, argv: alreadyConfined ? spec.argv : ['/usr/bin/sandbox-exec', '-p', profile, ...spec.argv],
        env: { ...spec.env, TMPDIR: temporary, TMP: temporary, TEMP: temporary, HOME: root, PYTHONDONTWRITEBYTECODE: '1' } }
    }
    spawn(spec) { return super.spawn(this.confined(spec)) }
    spawnTerminal(spec) { return super.spawnTerminal(this.confined(spec)) }
  }
}
