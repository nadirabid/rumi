/** Rumi shell chrome overrides: developer-chrome filtering, transient scrollbar, split-pane drag, and glass tabs. */

const HIDDEN_CHROME_ID = 'rumi-hidden-chrome'

const HIDDEN_CHROME_RULES = [
  '[data-composer-dock] { visibility: hidden !important; }',
  '[data-composer-stat="activity"] { visibility: visible !important; }',
  '[data-conversation-tabs] { display: none !important; }',
  'header div:has(> [data-conversation-tabs]) { display: none !important; }',
  'header:has([data-conversation-tabs]) { min-height: 0 !important; padding-bottom: 10px !important; }',
  'span:has(> [data-slot="conversation.hero.brand.mark"] [data-rumi-wordmark]) + span { display: none; }',
  'button[aria-haspopup="listbox"] { display: none !important; }',
  '.lv-orb, .lv-mic { position: relative; top: -2px; }',
  'div:has(> [data-slot="conversation.input.activity"]:only-child:empty) { display: none; }',
].join('\n')

function mountStyle(id: string, css: string): () => void {
  const style = document.createElement('style')
  style.id = id
  style.textContent = css
  document.head.append(style)
  return () => { style.remove() }
}

/** Filter composer and header chrome; the disposer removes the rules again. */
export function hideChrome(): () => void {
  if (document.getElementById(HIDDEN_CHROME_ID) !== null) return () => {}
  return mountStyle(HIDDEN_CHROME_ID, HIDDEN_CHROME_RULES)
}

/** Fade only the transcript thumb so the shared scrollbar gutter stays reserved. */
export function styleChatScrollbar(): () => void {
  const chat = '[data-conversation-region="chat"] [data-conversation-scroll]'
  const scrolling = 'data-rumi-chat-scrolling'
  const removeStyle = mountStyle('rumi-chat-scrollbar', `
@property --rumi-chat-scrollbar-visibility {
  syntax: "<percentage>";
  inherits: true;
  initial-value: 0%;
}
${chat} {
  transition: padding-inline-end var(--dsh-chat-end-reserve-transition, 0s),
    --rumi-chat-scrollbar-visibility 200ms linear;
}
${chat}[${scrolling}] {
  --rumi-chat-scrollbar-visibility: 100%;
  transition: padding-inline-end var(--dsh-chat-end-reserve-transition, 0s);
}
${chat}::-webkit-scrollbar-thumb {
  background-color: color-mix(in srgb, var(--dsh-scrollbar-thumb) var(--rumi-chat-scrollbar-visibility), transparent);
}
${chat}::-webkit-scrollbar-thumb:hover {
  background-color: color-mix(in srgb, var(--dsh-scrollbar-thumb-hover) var(--rumi-chat-scrollbar-visibility), transparent);
}
${chat}::-webkit-scrollbar-thumb:active {
  background-color: var(--dsh-scrollbar-thumb-hover);
}
@media (prefers-reduced-motion: reduce) {
  ${chat} {
    transition: padding-inline-end var(--dsh-chat-end-reserve-transition, 0s);
  }
}
`)

  const hideTimers = new Map<Element, ReturnType<typeof setTimeout>>()
  function reveal(event: Event) {
    const target = event.target
    if (!(target instanceof Element) || !target.matches(chat)) return
    const pendingHide = hideTimers.get(target)
    if (pendingHide === undefined) target.setAttribute(scrolling, '')
    clearTimeout(pendingHide)
    hideTimers.set(target, setTimeout(() => {
      target.removeAttribute(scrolling)
      hideTimers.delete(target)
    }, 500))
  }
  document.addEventListener('scroll', reveal, { capture: true, passive: true })
  return () => {
    document.removeEventListener('scroll', reveal, true)
    for (const [target, timer] of hideTimers) {
      clearTimeout(timer)
      target.removeAttribute(scrolling)
    }
    removeStyle()
  }
}

/** Size chat automatically until a divider drag chooses a proportional split; double-click resets it. */
export function styleViewerLayout(): () => void {
  const frame = '[data-sidebar-collapsed]:not([data-rightbar-collapsed]):not([data-rightbar-fullscreen]):has([data-sidebar-right-panel="push"][data-sidebar-right-open] .rumi-print-viewer)'
  const handleSelector = `${frame}>[data-side="rightbar"]`
  const removeStyle = mountStyle('rumi-viewer-layout', `
${frame}{--rumi-chat-width:clamp(240px,var(--rumi-chat-share,min(25%,500px)),calc(100% - 300px));grid-template-columns:0px var(--rumi-chat-width) minmax(0,1fr)!important}
${frame} [data-sidebar-right-panel="push"]{width:100%!important;--dsh-sidebar-width:100%!important}
${handleSelector}{left:var(--rumi-chat-width)!important}
`)
  const changed = new Set<HTMLElement>()
  let drag: { handle: HTMLElement; frame: HTMLElement; id: number; offset: number } | null = null

  const findHandle = (event: Event): HTMLElement | null =>
    event.target instanceof Element ? event.target.closest<HTMLElement>(handleSelector) : null

  function update(event: PointerEvent) {
    if (!drag) return
    const bounds = drag.frame.getBoundingClientRect()
    const width = Math.max(240, Math.min(bounds.width - 300, event.clientX - bounds.left - drag.offset))
    drag.frame.style.setProperty('--rumi-chat-share', `${(width / bounds.width) * 100}%`)
    changed.add(drag.frame)
  }

  function finish() {
    if (!drag) return
    const previous = drag
    drag = null
    if (previous.handle.hasPointerCapture(previous.id)) previous.handle.releasePointerCapture(previous.id)
  }

  const listeners: Record<string, EventListener> = {
    pointerdown(raw) {
      const event = raw as PointerEvent
      const target = findHandle(event)
      if (!target || event.button !== 0 || drag || !target.parentElement) return
      event.preventDefault()
      event.stopImmediatePropagation()
      const bounds = target.getBoundingClientRect()
      drag = { handle: target, frame: target.parentElement, id: event.pointerId, offset: event.clientX - bounds.left - bounds.width / 2 }
      target.setPointerCapture(event.pointerId)
    },
    pointermove(raw) {
      const event = raw as PointerEvent
      if (!drag || drag.id !== event.pointerId) return
      event.preventDefault()
      event.stopImmediatePropagation()
      update(event)
    },
    pointerup(raw) {
      const event = raw as PointerEvent
      if (!drag || drag.id !== event.pointerId) return
      event.preventDefault()
      event.stopImmediatePropagation()
      update(event)
      finish()
    },
    pointercancel(raw) {
      if (drag?.id === (raw as PointerEvent).pointerId) finish()
    },
    lostpointercapture(raw) {
      if (drag?.id === (raw as PointerEvent).pointerId) finish()
    },
    dblclick(raw) {
      const target = findHandle(raw)
      if (!target?.parentElement) return
      raw.preventDefault()
      raw.stopImmediatePropagation()
      finish()
      target.parentElement.style.removeProperty('--rumi-chat-share')
      changed.delete(target.parentElement)
    },
  }
  for (const [name, listener] of Object.entries(listeners)) document.addEventListener(name, listener, true)
  window.addEventListener('blur', finish)
  return () => {
    finish()
    for (const [name, listener] of Object.entries(listeners)) document.removeEventListener(name, listener, true)
    window.removeEventListener('blur', finish)
    for (const owner of changed) owner.style.removeProperty('--rumi-chat-share')
    removeStyle()
  }
}

/** Rumi document tabs reserve separate space for their title and close control. */
export function styleDocumentTabs(): () => void {
  return mountStyle('rumi-document-tabs', `
[data-sidebar-right-session] [data-dockkit-strip]{box-sizing:border-box;height:auto;min-height:50px;padding:4px 8px 4px var(--dsh-dockkit-strip-inline-start,8px)}
[data-sidebar-right-session] [data-dockkit-strip-tabs]{gap:8px;padding:4px}
[data-sidebar-right-session] [data-dockkit-strip-tabs]>div:not([data-dockkit-tab]):not([data-dockkit-caret]){display:none}
[data-sidebar-right-session] [data-dockkit-strip] [data-dockkit-tab]{box-sizing:border-box;flex:0 0 auto;width:max-content;min-width:0;max-width:280px;height:34px;gap:8px;padding:0 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;corner-shape:round;background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 78%,transparent);backdrop-filter:blur(24px) saturate(180%);box-shadow:inset 0 1px 0 color-mix(in srgb,var(--dsw-alias-label-primary-foreground) 55%,transparent),0 1px 3px var(--dsw-alias-bg-mask-2)}
[data-sidebar-right-session] [data-dockkit-strip] [data-dockkit-tab][aria-selected="true"]{background:color-mix(in srgb,var(--dsw-alias-label-primary) 6%,var(--dsw-alias-bg-layer-2));color:var(--dsw-alias-label-primary)}
[data-sidebar-right-session] [data-dockkit-strip] [data-dockkit-tab]:hover{background:var(--dsw-alias-interactive-bg-hover)}
[data-sidebar-right-session] [data-dockkit-strip] [data-dockkit-tab-title]{mask-image:none}
[data-sidebar-right-session] [data-dockkit-strip] [data-dockkit-tab-title][data-dockkit-tab-clipped]{mask-image:linear-gradient(to right,var(--dsw-alias-label-primary) calc(100% - 16px),transparent)}
[data-sidebar-right-session] [data-dockkit-strip] [data-dockkit-tab-close]{position:static;flex:none;width:20px;height:20px;opacity:1;pointer-events:auto;border-radius:50%;corner-shape:round}
[data-sidebar-right-session] [data-dockkit-strip]>button{width:34px;height:34px;border:1px solid var(--dsw-alias-border-l2);border-radius:50%;corner-shape:round;background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 78%,transparent);box-shadow:0 1px 3px var(--dsw-alias-bg-mask-2)}
[data-sidebar-right-session] [data-dockkit-strip] [data-dockkit-tab]:focus-visible,[data-sidebar-right-session] [data-dockkit-strip] button:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
@media(pointer:coarse){[data-sidebar-right-session] [data-dockkit-strip] [data-dockkit-tab],[data-sidebar-right-session] [data-dockkit-strip]>button{min-height:44px}[data-sidebar-right-session] [data-dockkit-strip] [data-dockkit-tab-close]{width:28px;height:28px}}
`)
}
