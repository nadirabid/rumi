/** Rumi's composer uses the stock model directory and separate session speed preferences. */
import { ModelSelect } from 'rumi-composer-select'
import { en, zh } from '../../../../packages/client/ui-model-selection/src/client/locales.ts'
import { DeepSeekModelLabel } from '../../../../packages/client/ui-deepseek-model-label-1017/src/client/DeepSeekModelLabel.tsx'

export const inject = ['modelDirectories', 'sessions', 'slots', 'locale', 'remote', 'remote.session']
export function apply(ctx) {
  const locale = 'rumi.model-picker'
  ctx.effect(() => ctx.locale.register(locale, {
    en: { ...en, 'speed.label': 'Requested speed', 'speed.auto': 'Auto', 'speed.priority': 'Fast', 'speed.ultrafast': 'Ultrafast',
      'speed.loading': 'Loading…', 'speed.failed': 'Could not load or save requested speed.', 'badge.label': '1017' },
    zh: { ...zh, 'speed.label': '请求速度', 'speed.auto': '自动', 'speed.priority': '快速', 'speed.ultrafast': '超快速',
      'speed.loading': '正在加载…', 'speed.failed': '无法读取或保存请求速度。', 'badge.label': '1017' },
  }))
  ctx.slots.inject('conversation.input.model', () => ctx.slots.register({
    name: 'conversation.input.model', priority: -1, locale,
    children: { 'rumi.composer.model.label': { kind: 'single', scope: 'session', inline: true } },
    inject: (sessionId) => {
      const directory = ctx.modelDirectories.directoryFor(sessionId)
      const available = ctx.sessions.subagentAddress(sessionId) === undefined
      return { sessionId, available, directory: directory.store,
        load: () => { if (available) void directory.load().catch(() => {}) },
        select: selection => available ? directory.select(selection) : Promise.resolve(undefined) }
    },
  }, ModelSelect))
  ctx.slots.inject('rumi.composer.model.label', () => ctx.slots.register({
    name: 'rumi.composer.model.label', locale,
  }, DeepSeekModelLabel))
}
