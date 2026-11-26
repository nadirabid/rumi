/** Dependency roots excluded from the packaged Rumi profile and its private pnpm install. */
export const omittedRuntimeDependencies: ReadonlySet<string> = new Set([
  '@deepseek-ai/libreoffice-kit',
  '@deepseek-ai/dsh-experimental-inspector-profile',
  '@deepseek-ai/dsh-experimental-voice-input-bundle',
])
