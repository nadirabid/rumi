/** Cordis loader entry for project shell enforcement. */
import { SandboxBashExecutor } from '@deepseek-ai/dsh-bash-sandbox'
import { createProjectShell } from './shell-provider.js'
export default createProjectShell({ SandboxBashExecutor })
