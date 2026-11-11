/** Project-owned tool contexts; capability admission fails closed for unaudited tools. */
import { AsyncLocalStorage } from 'node:async_hooks'
import { openSync, readSync, closeSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve, join } from 'node:path'
import { canonical, checkedPath, projectRoot } from './paths.js'

const TOOLS = new Set(['bash', 'read', 'write', 'edit', 'str_replace_editor', 'glob', 'grep', 'read_image', 'skill',
  'web_search', 'web_fetch',
  'load_workspace_dependencies', 'job_output', 'job_list', 'job_kill', 'blender_status',
  'print_studio_status', 'print_studio_progress', 'print_studio_print_test',
  'viewer_cursor_snapshot', 'viewer_working_model', 'viewer_load', 'viewer_transform', 'viewer_highlight',
  'viewer_controls', 'viewer_camera', 'mesh_open', 'mesh_transform', 'mesh_remove',
  'validation_mechanics', 'validation_accept'])
const checkout = resolve(import.meta.dirname, '../../../../..')
const applicationRoots = import.meta.dirname.includes('.app/Contents/')
  ? [import.meta.dirname.slice(0, import.meta.dirname.indexOf('.app/Contents/') + '.app/Contents'.length)]
  : ['node_modules', 'packages', 'vendor', 'apps/rumi/brand'].map(path => join(checkout, path))

/** Bind the provider to the shipped service definitions. @param {object} dependencies Service bases and schemas. @returns {Function} Cordis provider. */
export function createProjectScope({ Service, z }) {
  return class ProjectScope extends Service {
    static inject = ['tools', 'systemPrompt']
    static Config = z.object({
      instructionMaxBytes: z.number().step(1).min(1).max(1048576).default(65536),
      workspaceRoot: z.string().default(join(process.env.DSH_RUMI_HOME || join(homedir(), '.rumi'), 'workspace')),
      runtimeRoots: z.array(z.string()).default(['/System', '/usr', '/bin', '/sbin', '/opt/homebrew', ...applicationRoots,
        join(process.env.DSH_RUMI_HOME || join(homedir(), '.rumi'), 'dsh-runtimes')]),
    })
    constructor(ctx, config) {
      super(ctx, 'rumiProjectScope')
      if (process.platform !== 'darwin') throw new Error('Rumi project isolation requires the macOS sandbox')
      this.workspaceRoot = config.workspaceRoot
      this.runtimeRoots = config.runtimeRoots.map(canonical)
      this.storage = new AsyncLocalStorage()
      ctx.effect(() => ctx.systemPrompt.context({
        name: 'rumi:project-instructions', order: ctx.systemPrompt.getContextOrder('WEB_SURFACE'), interpolate: false, required: true,
        text: ({ agent }) => {
          if (!agent) return ''
          const root = this.rootFor(agent.session)
          const path = checkedPath(root, 'AGENTS.md', false, [])
          let file
          try { file = openSync(path, 'r') }
          catch (error) { if (error.code === 'ENOENT') return ''; throw error }
          try {
            const buffer = Buffer.alloc(config.instructionMaxBytes + 1)
            const bytesRead = readSync(file, buffer, 0, buffer.length, 0)
            if (bytesRead > config.instructionMaxBytes) throw new Error('Project instructions exceed the configured byte limit')
            return buffer.subarray(0, bytesRead).toString('utf8')
          } finally { closeSync(file) }
        },
      }))
      ctx.effect(() => ctx.tools.guard(exec => {
        if (!exec.agent) return 'Project isolation requires a project session.'
        if (!TOOLS.has(exec.name)) return 'This capability is not enabled for isolated Rumi projects.'
        if (exec.arguments?.sandbox_permissions === 'require_escalated') return 'Project isolation cannot be disabled or escalated.'
        try { this.rootFor(exec.agent.session) } catch { return 'This session is not registered with its project.' }
      }))
      ctx.on('tools/execute', async (exec, next) => {
        const root = this.rootFor(exec.agent.session)
        const inspect = (value) => {
          if (!value || typeof value !== 'object') return
          for (const [key, item] of Object.entries(value)) {
            if (typeof item === 'string' && /^(path|file_path|directory|cwd|workdir|original)$/u.test(key)) checkedPath(root, item, ['write', 'edit', 'str_replace_editor'].includes(exec.name), ['read', 'read_image', 'glob', 'grep'].includes(exec.name) ? this.runtimeRoots : [])
            else if (typeof item === 'object') inspect(item)
          }
        }
        inspect(exec.arguments)
        return this.storage.run({ root }, next)
      })
    }
    /** Resolve a session's owning project. @param {object} session Calling session. @returns {string} Project directory. */
    rootFor(session) { return projectRoot(this.workspaceRoot, session) }
    /** Read the active tool's root; absence means trusted host work, never an agent fallback. @returns {string|undefined} Active project. */
    activeRoot() { return this.storage.getStore()?.root }
    /** Check a path for the active operation. @param {string} path Target. @param {boolean} write Mutation flag. @returns {string} Canonical path. */
    check(path, write) {
      const root = this.activeRoot()
      return root === undefined ? path : checkedPath(root, path, write, this.runtimeRoots)
    }
  }
}
