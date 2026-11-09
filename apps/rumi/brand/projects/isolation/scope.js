/** Cordis loader entry for project scope enforcement. */
import { Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { createProjectScope } from './scope-provider.js'
export default createProjectScope({ Service, z })
