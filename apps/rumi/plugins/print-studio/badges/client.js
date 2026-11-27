/** Project awards and their supporting evidence in Rumi's global badge collection. */
import stylesheet from './collection.css?inline'
import { ALL_BADGE_KINDS as allKinds, HABIT_BADGE_KINDS as habitKinds, PRINT_BADGE_KINDS as mechanicalKinds } from './kinds.js'
import { createBadgeAwardFeed } from './award-feed.js'

const PANEL = 'print-studio-badges'
const NS = 'rumi.printBadges'
const ROUTE = '/api/print-studio/badges'
const REVEAL_HOLD_MS = 3_700
const REVEAL_FADE_MS = 600

const en = {
  title: 'Badges', empty: 'Build mechanisms and grow your maker habits in a project to earn badges.',
  oneEarned: '1 badge earned', manyEarned: '{count} badges earned',
  pending: 'Checking your latest work…', failed: 'Some projects still need a badge check.',
  loadError: 'Your badges couldn’t be loaded.', retryError: 'The badge check couldn’t be restarted.',
  retry: 'Try again', oneProject: '1 project', projects: '{count} projects',
  seeWhy: 'See why', improved: 'Improved',
  movementChecked: 'Movement checked',
  earnedAnnouncement: 'You earned the {badge} badge in {project}.',
  dismissReveal: 'Dismiss badge reveal',
  mechanicalGroup: 'Mechanical',
  habitsGroup: 'Maker habits',
  'barrel-hinge': 'Barrel hinge', 'living-hinge': 'Living hinge', 'wheel-and-axle': 'Wheel and axle',
  'dovetail-slide': 'Dovetail slide', 'gear-pair': 'Gear pair', 'rack-and-pinion': 'Rack and pinion',
  language: 'Language', patience: 'Patience', persistence: 'Persistence',
}
const zh = {
  title: '徽章', empty: '在项目中设计机械结构、培养制作习惯，即可获得徽章。',
  oneEarned: '已获得 1 枚徽章', manyEarned: '已获得 {count} 枚徽章',
  pending: '正在检查最新进展…', failed: '部分项目仍需进行徽章检查',
  loadError: '徽章未能加载', retryError: '未能重新开始徽章检查',
  retry: '再试一次', oneProject: '1 个项目', projects: '{count} 个项目',
  seeWhy: '查看原因', improved: '有进步',
  movementChecked: '已检查活动情况',
  earnedAnnouncement: '你在{project}项目中获得了{badge}徽章。',
  dismissReveal: '关闭徽章提示',
  mechanicalGroup: '机械结构',
  habitsGroup: '制作习惯',
  'barrel-hinge': '圆筒铰链', 'living-hinge': '柔性铰链', 'wheel-and-axle': '车轮与轮轴',
  'dovetail-slide': '燕尾导轨', 'gear-pair': '齿轮组', 'rack-and-pinion': '齿轮齿条',
  language: '清晰表达', patience: '耐心等待', persistence: '坚持不懈',
}

/** Unified 48x48 dual-layer emblems shared by every earned badge, unearned badge, and reveal. */
const emblems = {
  'barrel-hinge': {
    fill: 'M8 10h11a1.5 1.5 0 0 1 1.5 1.5v25A1.5 1.5 0 0 1 19 38H8a2 2 0 0 1-2-2V12a2 2 0 0 1 2-2z M29 10h11a2 2 0 0 1 2 2v24a2 2 0 0 1-2 2H29a1.5 1.5 0 0 1-1.5-1.5v-25A1.5 1.5 0 0 1 29 10z M20.5 9h7v8h-7z M20.5 20h7v8h-7z M20.5 31h7v8h-7z',
    stroke: 'M8 10h12.5v7H18v3h2.5v8H18v3h2.5v7H8a2 2 0 0 1-2-2V12a2 2 0 0 1 2-2z M40 10H27.5v7H30v3h-2.5v8H30v3h-2.5v7H40a2 2 0 0 0 2-2V12a2 2 0 0 0-2-2z M20.5 9h7v8h-7z M20.5 20h7v8h-7z M20.5 31h7v8h-7z M24 5.5V9 M24 39v3.5 M11.5 16a1 1 0 1 0 0 .01 M11.5 32a1 1 0 1 0 0 .01 M36.5 16a1 1 0 1 0 0 .01 M36.5 32a1 1 0 1 0 0 .01',
  },
  'living-hinge': {
    fill: 'M7 13.5 19.5 19v16.5L7 30a1.5 1.5 0 0 1-.9-1.4V14.8a1.3 1.3 0 0 1 1.8-1.2z M41 13.5 28.5 19v16.5L41 30a1.5 1.5 0 0 0 .9-1.4V14.8a1.3 1.3 0 0 0-1.8-1.2z M19.5 19q4.5-2.6 9 0v16.5q-4.5-2.6-9 0z',
    stroke: 'M6.5 14.5 19.5 19v16.5L6.5 30a1.4 1.4 0 0 1-.9-1.3V15.7a1.2 1.2 0 0 1 .9-1.2z M41.5 14.5 28.5 19v16.5L41.5 30a1.4 1.4 0 0 0 .9-1.3V15.7a1.2 1.2 0 0 0-.9-1.2z M19.5 19q4.5-2.8 9 0 M19.5 35.5q4.5-2.8 9 0 M22.5 20.5v11.5 M25.5 20.5v11.5',
  },
  'wheel-and-axle': {
    fill: 'M29.5 24a11 13.5 0 1 1-22 0 11 13.5 0 1 1 22 0z M21.5 24a3 3.7 0 1 1-6 0 3 3.7 0 1 1 6 0z M21.3 21.6l16.8-3.4a2.4 2.4 0 0 1 1 4.7l-17.8 3.6z',
    stroke: 'M29.5 24a11 13.5 0 1 1-22 0 11 13.5 0 1 1 22 0z M25.5 24a7 8.8 0 1 1-14 0 7 8.8 0 1 1 14 0z M21.5 24a3 3.7 0 1 1-6 0 3 3.7 0 1 1 6 0z M18.5 15.2v5.1 M18.5 27.7v5.1 M11.7 21.8l4 1.2 M11.7 26.2l4-1.2 M21.3 21.6l16.8-3.4a2.4 2.4 0 0 1 1 4.7l-17.8 3.6',
  },
  'dovetail-slide': {
    fill: 'M17.5 9h13l4.2 17.5H13.3z M6.5 23h9.2l-2.9 11.5h22.4L32.3 23h9.2a1.5 1.5 0 0 1 1.5 1.5v12a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-12A1.5 1.5 0 0 1 6.5 23z',
    stroke: 'M17.5 9h13l4.2 17.5H13.3z M6.5 23h9.2l-2.9 11.5h22.4L32.3 23h9.2a1.5 1.5 0 0 1 1.5 1.5v12a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-12A1.5 1.5 0 0 1 6.5 23z M21 15h6',
  },
  'gear-pair': {
    fill: 'M16 7h4l1 3.2 2.4 1 3-1.4 2.8 2.8-1.4 3 1 2.4 3.2 1v4l-3.2 1-1 2.4 1.4 3-2.8 2.8-3-1.4-2.4 1L20 35h-4l-1-3.2-2.4-1-3 1.4-2.8-2.8 1.4-3-1-2.4L4 23v-4l3.2-1 1-2.4-1.4-3 2.8-2.8 3 1.4 2.4-1z M33.5 24.5h3l.7 2.2 1.7.7 2.1-1 2 2-1 2.1.7 1.7 2.2.7v3l-2.2.7-.7 1.7 1 2.1-2 2-2.1-1-1.7.7-.7 2.2h-3l-.7-2.2-1.7-.7-2.1 1-2-2 1-2.1-.7-1.7-2.2-.7v-3l2.2-.7.7-1.7-1-2.1 2-2 2.1 1 1.7-.7z',
    stroke: 'M16 7h4l1 3.2 2.4 1 3-1.4 2.8 2.8-1.4 3 1 2.4 3.2 1v4l-3.2 1-1 2.4 1.4 3-2.8 2.8-3-1.4-2.4 1L20 35h-4l-1-3.2-2.4-1-3 1.4-2.8-2.8 1.4-3-1-2.4L4 23v-4l3.2-1 1-2.4-1.4-3 2.8-2.8 3 1.4 2.4-1z M22.5 21a4.5 4.5 0 1 1-9 0 4.5 4.5 0 1 1 9 0z M33.5 24.5h3l.7 2.2 1.7.7 2.1-1 2 2-1 2.1.7 1.7 2.2.7v3l-2.2.7-.7 1.7 1 2.1-2 2-2.1-1-1.7.7-.7 2.2h-3l-.7-2.2-1.7-.7-2.1 1-2-2 1-2.1-.7-1.7-2.2-.7v-3l2.2-.7.7-1.7-1-2.1 2-2 2.1 1 1.7-.7z M37.6 34.4a2.6 2.6 0 1 1-5.2 0 2.6 2.6 0 1 1 5.2 0z',
  },
  'rack-and-pinion': {
    fill: 'M21.8 6h4.4l.9 2.9 2.2.9 2.7-1.3 3.1 3.1-1.3 2.7.9 2.2 2.9.9v4.4l-2.9.9-.9 2.2 1.3 2.7-3.1 3.1-2.7-1.3-2.2.9-.9 2.9h-4.4l-.9-2.9-2.2-.9-2.7 1.3-3.1-3.1 1.3-2.7-.9-2.2-2.9-.9v-4.4l2.9-.9.9-2.2-1.3-2.7 3.1-3.1 2.7 1.3 2.2-.9z M6 40.5v-5h3.5l1.5 2.5h3.5l1.5-2.5h3.5l1.5 2.5h3.5l1.5-2.5h3.5l1.5 2.5h3.5l1.5-2.5H42v5a1.5 1.5 0 0 1-1.5 1.5h-33A1.5 1.5 0 0 1 6 40.5z',
    stroke: 'M21.8 6h4.4l.9 2.9 2.2.9 2.7-1.3 3.1 3.1-1.3 2.7.9 2.2 2.9.9v4.4l-2.9.9-.9 2.2 1.3 2.7-3.1 3.1-2.7-1.3-2.2.9-.9 2.9h-4.4l-.9-2.9-2.2-.9-2.7 1.3-3.1-3.1 1.3-2.7-.9-2.2-2.9-.9v-4.4l2.9-.9.9-2.2-1.3-2.7 3.1-3.1 2.7 1.3 2.2-.9z M28.2 19.6a4.2 4.2 0 1 1-8.4 0 4.2 4.2 0 1 1 8.4 0z M6 40.5v-5h3.5l1.5 2.5h3.5l1.5-2.5h3.5l1.5 2.5h3.5l1.5-2.5h3.5l1.5 2.5h3.5l1.5-2.5H42v5a1.5 1.5 0 0 1-1.5 1.5h-33A1.5 1.5 0 0 1 6 40.5z',
  },
  language: {
    fill: 'M10 9.5h28a4 4 0 0 1 4 4v16.5a4 4 0 0 1-4 4H21.5L12 40.5V34h-2a4 4 0 0 1-4-4V13.5a4 4 0 0 1 4-4z',
    stroke: 'M10 9.5h28a4 4 0 0 1 4 4v16.5a4 4 0 0 1-4 4H21.5L12 40.5V34h-2a4 4 0 0 1-4-4V13.5a4 4 0 0 1 4-4z M13.5 17.5h15.5 M13.5 22.8h21 M13.5 28h11.5 M33.5 15l1 2.4 2.4 1-2.4 1-1 2.4-1-2.4-2.4-1 2.4-1z',
  },
  patience: {
    fill: 'M13.5 8h21v4.2c0 4.4-4 7.7-8.1 10.6h-4.8C17.5 19.9 13.5 16.6 13.5 12.2z M13.5 40h21v-4.2c0-4.4-4-7.7-8.1-10.6h-4.8c-4.1 2.9-8.1 6.2-8.1 10.6z',
    stroke: 'M10.5 8h27 M10.5 40h27 M13.5 8v4.2c0 4.6 4.4 8 8.7 10.8 1.2.7 1.2 1.3 0 2-4.3 2.8-8.7 6.2-8.7 10.8V40 M34.5 8v4.2c0 4.6-4.4 8-8.7 10.8-1.2.7-1.2 1.3 0 2 4.3 2.8 8.7 6.2 8.7 10.8V40 M17.5 14h13 M17 36.2c2.5-2.5 4.8-3.8 7-3.8s4.5 1.3 7 3.8 M24 25.5v4.5',
  },
  persistence: {
    fill: 'M6.5 39 20 16.5 27.5 28l4.5-6.8L41.5 39z M20 16.5V8.5l8.5 3-8.5 3z',
    stroke: 'M6.5 39 20 16.5 27.5 28l4.5-6.8L41.5 39H6.5z M20 16.5V8.5l8.5 3-8.5 3 M13 39c2.5-3.4 4.8-5.3 8.2-6.2 2.4-.6 3.5-2.1 2.2-4.1-1.2-1.8-.3-3.8 2.4-4.7',
  },
  medal: {
    fill: 'M37 19a13 13 0 1 1-26 0 13 13 0 1 1 26 0z M16 29.5 13 42l8.5-4.8L25.5 42l1.2-11.5 M32 29.5 36.2 42l-8.8-4.8',
    stroke: 'M37 19a13 13 0 1 1-26 0 13 13 0 1 1 26 0z M16 29.5 13 42l8.5-4.8L25.5 42l1.2-11.5 M32 29.5 36.2 42l-8.8-4.8 M18.8 19.2l3.4 3.4 7-7.2',
  },
}
const toolbarMedal = 'M8 13.5 6.5 21 11 18.5 13.5 21l.6-6.5 M16 13.5l2.2 7.5-4.6-2.5 M18.5 9a6.5 6.5 0 1 1-13 0 6.5 6.5 0 1 1 13 0z M9.4 9.1l1.7 1.7 3.5-3.6'

/**
 * Mount the badge collection and its project-toolbar action.
 * @param {object} ctx - The current Print Studio client scope.
 * @param {object} React - Shell React instance.
 * @param {object} primitives - Shared controls and tooltip components.
 * @param {Function} createPortal - Shell portal for the reveal above floating project panes.
 */
export function installBadges(ctx, React, { Button, Tooltip, IconChevronRightOutlineRegular, IconCloseOutlineRegular }, createPortal) {
  const h = React.createElement
  const feed = createBadgeAwardFeed(ROUTE + '/events')
  ctx.effect(feed.connect, 'print badges: award events')
  ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'print badges: locale')
  ctx.effect(() => {
    const style = document.createElement('style')
    style.textContent = stylesheet
    document.head.append(style)
    return () => style.remove()
  }, 'print badges: material')

  function ToolbarGlyph() {
    return h('svg', { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none',
      'aria-hidden': true, stroke: 'currentColor', strokeWidth: 1.7,
      strokeLinejoin: 'round', strokeLinecap: 'round' }, h('path', { d: toolbarMedal }))
  }

  function Emblem({ kind }) {
    const art = emblems[kind] ?? emblems.medal
    return h('svg', { className: 'rumi-badge-emblem', viewBox: '0 0 48 48', fill: 'none',
      'aria-hidden': true, strokeLinejoin: 'round', strokeLinecap: 'round' },
      h('path', { className: 'rumi-badge-emblem-fill', d: art.fill }),
      h('path', { className: 'rumi-badge-emblem-stroke', d: art.stroke }))
  }

  function Toolbar({ activePanel, openPage, t }) {
    const label = t('title')
    return h(Tooltip, { label, side: 'bottom', portal: true, delayMs: 500 },
      h('button', { className: 'rumi-glass rumi-badges-button', type: 'button', 'aria-label': label,
        'aria-pressed': activePanel === PANEL, onClick: () => openPage(PANEL, label) }, h(ToolbarGlyph)))
  }

  function BadgeFace({ kind, award, t }) {
    return h('div', {
      className: 'rumi-badge-surface rumi-badge-face',
      'data-kind': kind,
      'data-locked': !award || undefined,
    },
      award?.path === 'growth' && h('span', { className: 'rumi-badge-growth' }, t('improved')),
      h('div', { className: 'rumi-badge-art', 'data-kind': kind, 'aria-hidden': true },
        h('div', { className: 'rumi-badge-medallion' },
          h(Emblem, { kind }))),
      h('div', { className: 'rumi-badge-caption' },
        h('h2', { className: 'rumi-badge-title' }, t(kind)),
        award && h('p', { className: 'rumi-badge-project' }, h('bdi', null, award.projectName))))
  }

  function Card({ kind, awards, individual = false, t }) {
    const earned = awards.length > 0
    const summaryLabel = individual
      ? t('seeWhy')
      : t(awards.length === 1 ? 'oneProject' : 'projects', { count: awards.length })
    return h('article', { className: 'rumi-badge-card', 'data-earned': earned || undefined },
      h(BadgeFace, { kind, award: awards[0], t }),
      earned && h('details', { className: 'rumi-badge-projects' },
        h('summary', null, summaryLabel,
          h(IconChevronRightOutlineRegular, { size: 12, 'aria-hidden': true })),
        h('ul', null, awards.map(award => h('li', { key: award.id },
          h('h3', null, award.projectName), h('p', null, award.evidence),
          award.working && h('p', { className: 'rumi-badge-checked' }, t('movementChecked')))))))
  }

  function RevealCard({ award, t }) {
    const [hovered, setHovered] = React.useState(false)
    const [focused, setFocused] = React.useState(false)
    const [visible, setVisible] = React.useState(() => !document.hidden)
    const [leaving, setLeaving] = React.useState(false)
    React.useEffect(() => {
      const onVisibility = () => setVisible(!document.hidden)
      document.addEventListener('visibilitychange', onVisibility)
      return () => document.removeEventListener('visibilitychange', onVisibility)
    }, [])
    React.useEffect(() => {
      setLeaving(false)
      if (hovered || focused || !visible) return
      const fade = setTimeout(() => setLeaving(true), REVEAL_HOLD_MS)
      const dismiss = setTimeout(() => feed.dismiss(award.id), REVEAL_HOLD_MS + REVEAL_FADE_MS)
      return () => { clearTimeout(fade); clearTimeout(dismiss) }
    }, [award.id, hovered, focused, visible])

    const dismiss = () => feed.dismiss(award.id)
    return h('aside', {
      className: 'rumi-badge-reveal', hidden: !visible,
      'data-kind': award.kind,
      'data-leaving': leaving || undefined,
      style: { '--badge-fade': REVEAL_FADE_MS + 'ms' },
      onPointerEnter: event => { if (event.pointerType !== 'touch') setHovered(true) },
      onPointerLeave: () => setHovered(false),
      onFocus: () => setFocused(true),
      onBlur: event => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false) },
      onKeyDown: event => {
        if (event.key !== 'Escape') return
        event.stopPropagation()
        dismiss()
      },
    },
    h('div', { className: 'rumi-badge-reveal-scene' },
      h('div', { className: 'rumi-badge-reveal-flight' },
        h('div', { className: 'rumi-badge-reveal-plate' },
          h(BadgeFace, { kind: award.kind, award, t }),
          h('div', { className: 'rumi-badge-surface rumi-badge-reveal-back', 'data-kind': award.kind, 'aria-hidden': true },
            h('div', { className: 'rumi-badge-medallion' },
              h(Emblem, { kind: 'medal' })))))),
    h(Button, { className: 'rumi-badge-reveal-dismiss', size: 'sm', variant: 'ghost',
      'aria-label': t('dismissReveal'), onClick: dismiss }, h(IconCloseOutlineRegular, { size: 16, 'aria-hidden': 'true' })))
  }

  function Reveal({ t }) {
    const award = React.useSyncExternalStore(feed.subscribe, feed.active)
    return h(React.Fragment, null,
      h('div', { className: 'rumi-badge-announcement', role: 'status' },
        award ? t('earnedAnnouncement', { badge: t(award.kind), project: award.projectName }) : ''),
      award && createPortal(h(RevealCard, { key: award.id, award, t }), document.body))
  }

  function Collection({ t }) {
    const [data, setData] = React.useState(null)
    const [error, setError] = React.useState(null)
    const [refresh, setRefresh] = React.useState(0)
    const [retrying, setRetrying] = React.useState(false)
    const awardRevision = React.useSyncExternalStore(feed.subscribe, feed.revision)
    const retryRequest = React.useRef(null)
    React.useEffect(() => () => retryRequest.current?.abort(), [])
    React.useEffect(() => {
      const controller = new AbortController()
      let timer
      let loading = false
      async function load() {
        if (loading || document.hidden || controller.signal.aborted) return
        clearTimeout(timer)
        loading = true
        try {
          const response = await fetch(ROUTE, { signal: controller.signal, cache: 'no-store' })
          if (!response.ok) throw new Error('badge collection unavailable')
          const result = await response.json()
          if (!controller.signal.aborted) {
            setData(result)
            setError(current => current === 'loadError' ? null : current)
          }
        } catch (_loadError) {
          if (!controller.signal.aborted) setError('loadError')
        } finally {
          loading = false
          if (!controller.signal.aborted && !document.hidden) timer = setTimeout(load, 4000)
        }
      }
      void load()
      document.addEventListener('visibilitychange', load)
      return () => {
        controller.abort()
        clearTimeout(timer)
        document.removeEventListener('visibilitychange', load)
      }
    }, [refresh, awardRevision])
    async function retry() {
      if (retryRequest.current) return
      if (error === 'loadError') {
        setError(null)
        setRefresh(value => value + 1)
        return
      }
      const controller = new AbortController()
      retryRequest.current = controller
      setRetrying(true)
      try {
        const response = await fetch(ROUTE + '/retry', { method: 'POST', signal: controller.signal })
        if (!response.ok) throw new Error('badge retry failed')
        if (!controller.signal.aborted) {
          setError(null)
          setRefresh(value => value + 1)
        }
      } catch (_retryError) {
        if (!controller.signal.aborted) setError('retryError')
      } finally {
        retryRequest.current = null
        if (!controller.signal.aborted) setRetrying(false)
      }
    }

    const allAwards = data?.awards ?? []
    const earnedEntries = []
    const unearnedMechanical = []
    for (const kind of mechanicalKinds) {
      const awards = allAwards.filter(award => award.kind === kind)
      if (awards.length === 0) {
        unearnedMechanical.push({ key: kind, kind, awards: [] })
        continue
      }
      const sortTime = awards.reduce((first, award) => {
        const earnedAt = Date.parse(award.earnedAt)
        return Number.isFinite(earnedAt) ? Math.min(first, earnedAt) : first
      }, Number.MAX_SAFE_INTEGER)
      earnedEntries.push({ key: kind, kind, awards, individual: false, sortTime })
    }
    const earnedHabitKinds = new Set()
    for (const award of allAwards) {
      if (!habitKinds.includes(award.kind)) continue
      earnedHabitKinds.add(award.kind)
      const parsed = Date.parse(award.earnedAt)
      earnedEntries.push({
        key: award.id, kind: award.kind, awards: [award], individual: true,
        sortTime: Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER,
      })
    }
    earnedEntries.sort((left, right) => left.sortTime - right.sortTime || String(left.key).localeCompare(String(right.key)))
    const unearnedHabits = habitKinds
      .filter(kind => !earnedHabitKinds.has(kind))
      .map(kind => ({ key: kind, kind, awards: [] }))
    const unearnedGroups = [
      { id: 'mechanical', labelKey: 'mechanicalGroup', items: unearnedMechanical },
      { id: 'habits', labelKey: 'habitsGroup', items: unearnedHabits },
    ].filter(group => group.items.length > 0)
    const notice = error || (data?.failed ? 'failed' : null)
    const subtitle = earnedEntries.length === 0
      ? t('empty')
      : earnedEntries.length === 1
        ? t('oneEarned')
        : t('manyEarned', { count: earnedEntries.length })
    return h('section', { className: 'rumi-badges', 'aria-label': t('title') },
      h('header', { className: 'rumi-badges-heading' }, h('h1', null, t('title')),
        data && h('p', null, subtitle)),
      notice && h('div', { className: 'rumi-badges-notice', role: 'alert' }, t(notice),
        h(Button, { variant: 'outline', size: 'sm', disabled: retrying, onClick: retry }, t('retry'))),
      data?.pending > 0 && h('p', { className: 'rumi-badges-pending', role: 'status' }, t('pending')),
      data ? h('div', { className: 'rumi-badges-groups' },
        earnedEntries.length > 0 && h('div', { className: 'rumi-badges-grid rumi-badges-earned' },
          earnedEntries.map(({ key, kind, awards, individual }) => h(Card, { key, kind, awards, individual, t }))),
        earnedEntries.length > 0 && unearnedGroups.length > 0 && h('div', {
          className: 'rumi-badges-divider', role: 'separator', 'aria-hidden': true,
        }),
        unearnedGroups.length > 0 && h('div', { className: 'rumi-badges-unearned-groups' },
          unearnedGroups.map(group => h('section', {
            key: group.id, className: 'rumi-badges-category', 'data-category': group.id,
            'aria-labelledby': `rumi-badges-category-${group.id}`,
          },
          h('div', { id: `rumi-badges-category-${group.id}`, className: 'rumi-badges-category-label' }, t(group.labelKey)),
          h('div', { className: 'rumi-badges-grid rumi-badges-unearned' },
            group.items.map(({ key, kind, awards }) => h(Card, { key, kind, awards, t })))))))
        : !error && h('div', { className: 'rumi-badges-grid rumi-badges-earned', 'aria-busy': true },
          allKinds.map(kind => h('div', { key: kind, className: 'rumi-badges-skeleton' }))))
  }

  ctx.slots.inject('rumi.projects.toolbar', () => ctx.slots.register({
    name: 'rumi.projects.toolbar', id: 'print-studio-badges', locale: NS,
  }, Toolbar))
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL, locale: NS }, Collection))
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay', id: 'print-studio-badge-reveal', locale: NS,
  }, Reveal))
}
