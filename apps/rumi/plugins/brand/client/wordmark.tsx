import * as React from 'react'

/** Plain lowercase "rumi" wordmark rendered in the sidebar and conversation hero. */
const FONT = 'Arial, Helvetica, "Helvetica Neue", sans-serif'

/** Plain wordmark; `size` is the caller's icon box, scaled to set type. */
export function Wordmark({ size = 26, className }: { size?: number; className?: string }) {
  return (
    <span
      className={className}
      data-rumi-wordmark=""
      role="img"
      aria-label="Rumi"
      style={{
        fontFamily: FONT,
        fontSize: Math.round(size * 0.65),
        fontWeight: 400,
        letterSpacing: '-0.012em',
        lineHeight: 1,
        whiteSpace: 'nowrap',
        userSelect: 'none',
        color: 'inherit',
      }}
    >
      rumi
    </span>
  )
}

/** The wordmark already names the product; the name seat stays empty. */
export function NoName() {
  return null
}

/** Suppress developer-facing Session header utilities without disturbing other seats. */
export function NoHeaderUtility() {
  return null
}
