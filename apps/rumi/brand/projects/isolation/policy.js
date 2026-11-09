/** Cordis loader entry for project policy enforcement. */
import { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import { createProjectPolicy } from './policy-provider.js'
export default createProjectPolicy({ SandboxPolicyService })
