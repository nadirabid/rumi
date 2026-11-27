/** Rumi brand — browser half: wordmark, chrome overrides, Live Voice key settings, and default model configuration. */
import './styles.css'
import { hideChrome, styleChatScrollbar, styleDocumentTabs, styleViewerLayout } from './chrome.ts'
import { Wordmark, NoName, NoHeaderUtility } from './wordmark.tsx'
import { LIVE_VOICE_NS, liveVoiceLocales, LiveVoiceSettings } from './live-voice-settings.tsx'
import { registerDefaultModel } from './default-model-settings.tsx'

export const inject = ['slots', 'locale', 'layout']

export function apply(ctx: any) {
  ctx.inject(['configForms', 'remote', 'remote.session', 'remote.credentials', 'remote.settings'], registerDefaultModel)
  ctx.effect(styleViewerLayout, 'rumi-brand: responsive viewer layout')
  ctx.effect(hideChrome, 'rumi-brand: hide developer chrome')
  ctx.effect(styleChatScrollbar, 'rumi-brand: transient chat scrollbar')
  ctx.effect(styleDocumentTabs, 'rumi-brand: document tab glass')
  ctx.effect(() => ctx.locale.register(LIVE_VOICE_NS, liveVoiceLocales), 'rumi-brand: live voice copy')

  ctx.slots.inject('conversation.session.header.utilities', function* () {
    yield ctx.slots.register({ name: 'conversation.session.header.utilities', id: 'open-in-app', order: -10, priority: -1 }, NoHeaderUtility)
    yield ctx.slots.register({ name: 'conversation.session.header.utilities', id: 'session-log-download', priority: -1 }, NoHeaderUtility)
  })

  const t = ctx.locale.bind(LIVE_VOICE_NS)
  ctx.slots.inject('sidebar.brand.mark', () => ctx.slots.register({ name: 'sidebar.brand.mark', id: 'rumi-brand' }, Wordmark))
  ctx.slots.inject('sidebar.brand.name', () => ctx.slots.register({ name: 'sidebar.brand.name', id: 'rumi-brand' }, NoName))
  ctx.slots.inject('conversation.hero.brand.mark', () => ctx.slots.register({ name: 'conversation.hero.brand.mark', id: 'rumi-brand' }, Wordmark))
  ctx.slots.inject('plugins.item', () => ctx.slots.register({
    name: 'plugins.item',
    id: 'rumi-live-voice',
    order: 50,
    label: () => t('title'),
    locale: LIVE_VOICE_NS,
  }, LiveVoiceSettings))
}
