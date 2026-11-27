/** Live dictation strip ported into the conversation chat column while speech decodes. */
import * as React from 'react'
import type { DictationStore } from './rtc.ts'
import type { Translate } from './locales.ts'

declare function require(name: string): any

// The chat column is not a slot, so the dictation row reaches it through a
// portal. A host without react-dom keeps the dock placement instead.
let createPortal: ((children: React.ReactNode, container: Element) => React.ReactPortal) | null = null
try {
  createPortal = require('react-dom')?.createPortal ?? null
} catch {
  createPortal = null
}

/**
 * The dock is wider than the conversation column, so the fallback seat pins its
 * row to the conversation's own content width and centres it.
 */
const CHAT_COLUMN: React.CSSProperties = {
  width: '100%',
  maxWidth: 'var(--dsh-chat-content-width, 748px)',
  marginLeft: 'auto',
  marginRight: 'auto',
  boxSizing: 'border-box',
}

/**
 * The dictation bubble borrows the conversation's own user-message chrome so it
 * reads as that message while it is still being said.
 */
const DICTATION_BUBBLE: React.CSSProperties = {
  maxWidth: 'min(calc(var(--dsh-chat-content-width, 748px) * 0.702), 82%)',
  background: 'var(--dsw-specific-bubble, var(--dsw-alias-surface-secondary))',
  color: 'var(--dsw-alias-label-primary, inherit)',
  borderRadius: 'var(--dsw-radius-xl, 18px)',
  padding: '10px 16px',
  fontSize: 'var(--dsh-content-font-size, 14px)',
  lineHeight: 'calc(22px + var(--dsh-content-font-delta, 0px))',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
}

const MARK_BARS: [number, number][] = [
  [8.05, 8], [12.15, 14], [16.25, 20], [20.35, 14], [24.45, 8],
]

function VoiceMark({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 34 34" aria-hidden="true" style={{ display: 'block' }}>
      <circle cx={17} cy={17} r={16} fill="var(--dsw-alias-label-primary-foreground)" stroke="var(--dsw-alias-border-l3)" strokeWidth={1} />
      {MARK_BARS.map(([x, height], index) => (
        <rect
          key={index}
          x={x}
          y={17 - height / 2}
          width={1.5}
          height={height}
          rx={0.75}
          fill="var(--dsw-alias-label-primary)"
        />
      ))}
    </svg>
  )
}

/**
 * The chat column that owns this conversation's messages, resolved from the
 * seat's own hidden node so the lookup never crosses into another Session.
 */
function useChatColumn(anchor: React.RefObject<HTMLSpanElement | null>) {
  const [column, setColumn] = React.useState<Element | null>(null)

  React.useEffect(() => {
    const root = anchor.current?.closest('[data-conversation-content]')
    if (!root) return undefined
    let frame = 0
    const sync = () => {
      frame = 0
      setColumn(root.querySelector('[data-chat-flow]'))
    }
    sync()
    const observer = new MutationObserver(() => {
      if (frame === 0) frame = requestAnimationFrame(sync)
    })
    observer.observe(root, { childList: true, subtree: true })
    return () => {
      observer.disconnect()
      if (frame !== 0) cancelAnimationFrame(frame)
    }
  }, [anchor])

  return column
}

/**
 * Dictation tail seated at the end of the conversation while words arrive.
 */
export function createDictationTail(dictation: DictationStore) {
  return function DictationTail({ t }: { t: Translate }) {
    const view = React.useSyncExternalStore(dictation.subscribe, dictation.get)
    const anchor = React.useRef<HTMLSpanElement | null>(null)
    const row = React.useRef<HTMLDivElement | null>(null)
    const column = useChatColumn(anchor)
    const live = view.active && view.user !== ''

    React.useEffect(() => {
      const node = row.current
      if (!live || node === null || column === null) return undefined
      const place = () => {
        const running = column.querySelector(':scope > [data-chat-running]')
        if (node.parentNode !== column || node.nextElementSibling !== running) {
          column.insertBefore(node, running)
        }
      }
      place()
      const observer = new MutationObserver(place)
      observer.observe(column, { childList: true })
      return () => {
        observer.disconnect()
        node.remove()
      }
    }, [column, live])

    const anchorNode = <span ref={anchor} hidden aria-hidden="true" />
    if (!live) return anchorNode

    const content = (
      <div
        ref={row}
        data-live-voice-dictation=""
        style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 5, padding: '2px 0 4px' }}
      >
        <div style={DICTATION_BUBBLE}>
          {view.user}
          <span className="lv-caret" aria-hidden="true" />
        </div>
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11.5, lineHeight: '16px', opacity: 0.45 }}>
          <VoiceMark size={12} />
          <span>{t('trigger.voice')}</span>
        </div>
      </div>
    )

    return (
      <React.Fragment>
        {anchorNode}
        {column !== null && createPortal !== null
          ? createPortal(content, column)
          : <div style={CHAT_COLUMN}>{content}</div>}
      </React.Fragment>
    )
  }
}
