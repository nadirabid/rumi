/** Post-commit badge awards available to Rumi's host plugins. */
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { ALL_BADGE_KINDS } from './badges-kinds.js'

/** A batch of new awards from one registered project's completed review. */
export interface PrintBadgeEarned {
  readonly projectId: Branded<'RumiProjectId'>
  readonly projectPath: string
  readonly projectName: string
  readonly awards: readonly {
    readonly id: Branded<'RumiPrintBadgeId'>
    readonly kind: (typeof ALL_BADGE_KINDS)[number]
    readonly path?: 'practice' | 'growth'
  }[]
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * Dispatch a project's newly earned badges after their transaction commits.
     * @param event The registered project and newly inserted awards.
     * @mode parallel
     */
    'rumi/print-badge-earned'(event: PrintBadgeEarned): void | Promise<void>
  }
}
