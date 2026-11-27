/** Add ChatGPT service-tier preferences to the stock composer model menu. */
import type { Context } from '@deepseek-ai/cordis'
import type { ModelDirectoryState } from '@deepseek-ai/dsh-client-ui-model-selection/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import { Button, IconCheckOutlineRegular, IconChevronRightOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { useSpeed } from './speed.ts'
import css from './speed.module.css'

const LOCALE = 'rumi.model-picker'
const PANE = 'rumi-requested-speed'

const en = {
  title: 'Requested speed', auto: 'Auto', priority: 'Fast', ultrafast: 'Ultrafast',
  loading: 'Loading…', failed: 'Could not load or save requested speed.', retry: 'Retry',
}
const zh: Record<keyof typeof en, string> = {
  title: '请求速度', auto: '自动', priority: '快速', ultrafast: '超快速',
  loading: '正在加载…', failed: '无法读取或保存请求速度。', retry: '重试',
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { [LOCALE]: keyof typeof en }
}

interface SpeedInjected {
  hooks: { modelDirectory: ObservableSnapshot<ModelDirectoryState> }
}

type SpeedProps<Seat extends 'conversation.input.model.options' | 'conversation.input.model.pane'> =
  PropsRuntime<Seat> & PropsLocale<typeof LOCALE> & InjectFace<SpeedInjected>

function chatGptModel({ current, groups }: ModelDirectoryState): string | null {
  if (current?.provider !== 'rumi-chatgpt') return null
  return groups.find(group => group.id === current.provider)?.models.some(model => model.id === current.model)
    ? current.model
    : null
}

function SpeedOption({ sessionId, useModelDirectory, locked, openPane, t }: SpeedProps<'conversation.input.model.options'>) {
  const model = useModelDirectory(chatGptModel)
  const { speed, failed } = useSpeed(sessionId, model)
  if (model === null || (!failed && speed !== undefined && speed.tiers.length <= 1)) return null
  return <Button className={css.row} role="menuitem" disabled={locked} data-model-menu-pane={PANE}
    onClick={() => openPane({ key: PANE, title: t('title') })}>
    <span className={css.label}>{t('title')}</span>
    <span className={css.value}>{failed ? t('retry') : speed === undefined ? t('loading') : t(speed.requested)}</span>
    <IconChevronRightOutlineRegular className={css.chevron} aria-hidden="true" />
  </Button>
}

function SpeedPane({ sessionId, useModelDirectory, locked, dismiss, t }: SpeedProps<'conversation.input.model.pane'>) {
  const model = useModelDirectory(chatGptModel)
  const { speed, failed, saving, save, retry } = useSpeed(sessionId, model)
  if (model === null) return null
  return <div role="menu" aria-label={t('title')}>
    {failed && <div className={css.status} role="alert">{t('failed')}
      <Button size="sm" autoFocus onClick={retry}>{t('retry')}</Button>
    </div>}
    {!failed && speed === undefined && <div className={css.status} role="status">{t('loading')}</div>}
    {speed?.tiers.map(tier => <Button key={tier} className={css.row} role="menuitemradio"
      aria-checked={speed.requested === tier} autoFocus={speed.requested === tier && !failed}
      disabled={locked || saving} onClick={async () => { if (await save(tier)) dismiss() }}>
      {t(tier)}{speed.requested === tier && <IconCheckOutlineRegular size={14} aria-hidden="true" />}
    </Button>)}
  </div>
}

/** Required browser services. */
export const inject = ['slots', 'locale']

/**
 * Register the speed option and detail pane alongside stock model selection.
 * @param ctx Browser plugin context.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(LOCALE, { en, zh }))
  ctx.inject(['modelDirectories'], scope => {
    const inject = (sessionId: Parameters<typeof scope.modelDirectories.directoryFor>[0]): SpeedInjected => ({
      hooks: { modelDirectory: scope.modelDirectories.directoryFor(sessionId).store },
    })
    scope.slots.inject('conversation.input.model.options', () => scope.slots.register({
      name: 'conversation.input.model.options', id: PANE, locale: LOCALE, inject,
    }, SpeedOption))
    scope.slots.inject('conversation.input.model.pane', () => scope.slots.register({
      name: 'conversation.input.model.pane', key: PANE, locale: LOCALE, inject,
    }, SpeedPane))
  })
}
