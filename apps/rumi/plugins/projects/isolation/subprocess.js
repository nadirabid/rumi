/** Cordis loader entry for project-owned subprocess confinement. */
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import { createProjectSubprocess } from './subprocess-provider.js'
export default createProjectSubprocess({ LocalSubprocessRuntime })
