/** Cordis loader entry for project filesystem enforcement. */
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { createProjectFileSystem } from './filesystem-provider.js'
export default createProjectFileSystem({ LocalFileSystem })
