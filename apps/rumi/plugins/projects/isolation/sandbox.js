/** Cordis loader entry for project sandbox enforcement. */
import { SandboxProvider } from '@deepseek-ai/dsh-sandbox'
import { createProjectSandbox } from './sandbox-provider.js'
export default createProjectSandbox({ SandboxProvider })
