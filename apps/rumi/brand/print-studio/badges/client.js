/** Project awards and their supporting evidence in Rumi's global badge collection. */
import stylesheet from './collection.css?inline'
import { PRINT_BADGE_KINDS as kinds } from '../badges-kinds.js'

const PANEL = 'print-studio-badges'
const NS = 'rumi.printBadges'
const ROUTE = '/api/print-studio/badges'

const en = {
  title: 'Badges', empty: 'Build a mechanism in a project to earn its badge.',
  progress: '{count} of {total} mechanical badges earned',
  pending: 'Checking your latest designs…', failed: 'Some designs still need a badge check.',
  loadError: 'Your badges couldn’t be loaded.', retryError: 'The badge check couldn’t be restarted.',
  retry: 'Try again', oneProject: '1 project', projects: '{count} projects',
  movementChecked: 'Movement checked',
  'barrel-hinge': 'Barrel hinge', 'living-hinge': 'Living hinge', 'wheel-and-axle': 'Wheel and axle',
  'dovetail-slide': 'Dovetail slide', 'gear-pair': 'Gear pair', 'rack-and-pinion': 'Rack and pinion',
  'barrel-hinge.hint': 'Join two pieces so they swing around a pin.',
  'living-hinge.hint': 'Make one piece fold along a thin, flexible strip.',
  'wheel-and-axle.hint': 'Mount a wheel so it can turn on an axle.',
  'dovetail-slide.hint': 'Guide a sliding piece along a flared track.',
  'gear-pair.hint': 'Mesh two gears so one turns the other.',
  'rack-and-pinion.hint': 'Use a gear and a toothed rail to turn rotation into sliding.',
}
const zh = {
  title: '徽章', empty: '在项目中设计机械结构，即可获得相应的徽章。',
  progress: '已获得 {count} 枚机械徽章，共 {total} 枚',
  pending: '正在检查最新设计…', failed: '部分设计仍需进行徽章检查',
  loadError: '徽章未能加载', retryError: '未能重新开始徽章检查',
  retry: '再试一次', oneProject: '1 个项目', projects: '{count} 个项目',
  movementChecked: '已检查活动情况',
  'barrel-hinge': '圆筒铰链', 'living-hinge': '柔性铰链', 'wheel-and-axle': '车轮与轮轴',
  'dovetail-slide': '燕尾导轨', 'gear-pair': '齿轮组', 'rack-and-pinion': '齿轮齿条',
  'barrel-hinge.hint': '用销轴连接两个部件，让它们绕轴转动。',
  'living-hinge.hint': '让一体成形的部件沿着柔韧的薄片折叠。',
  'wheel-and-axle.hint': '安装一个可以在轮轴上转动的轮子。',
  'dovetail-slide.hint': '让滑块沿着燕尾形轨道移动。',
  'gear-pair.hint': '让两个齿轮相互啮合，一个带动另一个。',
  'rack-and-pinion.hint': '用齿轮和齿条把旋转变成直线运动。',
}

// Each medallion depicts the feature named on its card.
const glyphs = {
  'barrel-hinge': 'M4 6h6v4H8v4h2v4H4z M20 6h-6v4h2v4h-2v4h6z M12 4v16 M10 6h4v4h-4z M10 14h4v4h-4z',
  'living-hinge': 'M3 6.5l6 3.2v9L3 15.5z M21 6.5l-6 3.2v9l6-3.2z M9 10q3 3 6 0 M9 18q3 3 6 0',
  'wheel-and-axle': 'M16 12a6.5 8 0 1 1-13 0 6.5 8 0 1 1 13 0z M11.5 12a2 2.5 0 1 1-4 0 2 2.5 0 1 1 4 0z M11.5 10.8l8.4-2.5q2 0 1.2 2.1l-9.8 3',
  'dovetail-slide': 'M3 10l6-3h3l-1.5 3h4L13 7h3l5 2.5v4L9 20l-6-3z M3 10l6 3 12-6 M9 13v7 M6 9l3 1.5 8-4',
  'gear-pair': 'M8 4l1 2 2 .5 2-.5 1.2 2-1.3 1.8.1 2 1 1.7-1.5 1.8-2-.4-1.8 1L8 18H6l-.8-2.1-2-.9-1.7.4-.8-2 1.2-1.6v-2L1 8.3 2.5 6.5l2 .4 1.8-1L6.6 4z M9.3 11a2.1 2.1 0 1 1-4.2 0 2.1 2.1 0 1 1 4.2 0z M16.8 12.7l.5-1.2h1.6l.5 1.2 1.4.7 1.1-.2.8 1.4-.8 1.1v1.5l.8 1.1-.8 1.4-1.1-.2-1.4.7-.5 1.2h-1.6l-.5-1.2-1.4-.7-1.1.2-.8-1.4.8-1.1v-1.5l-.8-1.1.8-1.4 1.1.2z M19.2 16.5a1.1 1.1 0 1 1-2.2 0 1.1 1.1 0 1 1 2.2 0z',
  'rack-and-pinion': 'M10 3h3l.7 1.9 1.3.8 2-.4 1.3 2.3-1.3 1.6v1.6l1.3 1.6-1.3 2.3-2-.4-1.3.8L13 17h-3l-.7-1.9-1.3-.8-2 .4-1.3-2.3L6 10.8V9.2L4.7 7.6 6 5.3l2 .4 1.3-.8z M13.5 10a2 2 0 1 1-4 0 2 2 0 1 1 4 0z M2 20v-3h2l1 1.5h2L8 17h2l1 1.5h2l1-1.5h2l1 1.5h2l1-1.5h2v3z',
}
const medal = 'M8 13.5 6.5 21 11 18.5 13.5 21l.6-6.5 M16 13.5l2.2 7.5-4.6-2.5 M18.5 9a6.5 6.5 0 1 1-13 0 6.5 6.5 0 1 1 13 0z M9.4 9.1l1.7 1.7 3.5-3.6'

/**
 * Mount the badge collection and its project-toolbar action.
 * @param {object} ctx - The current Print Studio client scope.
 * @param {object} React - Shell React instance.
 * @param {object} primitives - Shared controls and tooltip components.
 */
export function installBadges(ctx, React, { Button, Tooltip, IconChevronRightOutlineRegular }) {
  const h = React.createElement
  ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'print badges: locale')
  ctx.effect(() => {
    const style = document.createElement('style')
    style.textContent = stylesheet
    document.head.append(style)
    return () => style.remove()
  }, 'print badges: material')

  function Glyph({ kind, size }) {
    return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
      'aria-hidden': true, stroke: 'currentColor', strokeWidth: kind ? 1.2 : 1.7,
      strokeLinejoin: 'round', strokeLinecap: 'round' }, h('path', { d: kind ? glyphs[kind] : medal }))
  }

  function Toolbar({ activePanel, openPage, t }) {
    const label = t('title')
    return h(Tooltip, { label, side: 'bottom', portal: true, delayMs: 500 },
      h('button', { className: 'rumi-glass rumi-badges-button', type: 'button', 'aria-label': label,
        'aria-pressed': activePanel === PANEL, onClick: () => openPage(PANEL, label) }, h(Glyph, { size: 18 })))
  }

  function Card({ kind, awards, t }) {
    const earned = awards.length > 0
    return h('article', { className: 'rumi-badge-card rumi-lq', 'data-earned': earned || undefined },
      h('div', { className: 'rumi-badge-face' },
        h('div', { className: 'rumi-badge-medallion' }, h(Glyph, { kind, size: 32 })),
        h('h2', null, t(kind)),
        h('p', { className: 'rumi-badge-description' }, t(kind + '.hint'))),
      earned && h('details', { className: 'rumi-badge-projects' },
        h('summary', null, t(awards.length === 1 ? 'oneProject' : 'projects', { count: awards.length }),
          h(IconChevronRightOutlineRegular, { size: 12, 'aria-hidden': true })),
        h('ul', null, awards.map(award => h('li', { key: award.id },
          h('h3', null, award.projectName), h('p', null, award.evidence),
          award.working && h('p', { className: 'rumi-badge-checked' }, t('movementChecked')))))))
  }

  function Collection({ t }) {
    const [data, setData] = React.useState(null)
    const [error, setError] = React.useState(null)
    const [refresh, setRefresh] = React.useState(0)
    const [retrying, setRetrying] = React.useState(false)
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
        } catch (error) {
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
    }, [refresh])
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
      } catch (error) {
        if (!controller.signal.aborted) setError('retryError')
      } finally {
        retryRequest.current = null
        if (!controller.signal.aborted) setRetrying(false)
      }
    }

    const awarded = new Set(data?.awards.map(award => award.kind))
    const notice = error || (data?.failed ? 'failed' : null)
    return h('section', { className: 'rumi-badges', 'aria-label': t('title') },
      h('header', { className: 'rumi-badges-heading' }, h('h1', null, t('title')),
        data && h('p', null, awarded.size ? t('progress', { count: awarded.size, total: kinds.length }) : t('empty'))),
      notice && h('div', { className: 'rumi-badges-notice', role: 'alert' }, t(notice),
        h(Button, { variant: 'outline', size: 'sm', disabled: retrying, onClick: retry }, t('retry'))),
      data?.pending > 0 && h('p', { className: 'rumi-badges-pending', role: 'status' }, t('pending')),
      data ? h('div', { className: 'rumi-badges-grid' }, kinds.map(kind => h(Card, {
        key: kind, kind, awards: data.awards.filter(award => award.kind === kind), t,
      }))) : !error && h('div', { className: 'rumi-badges-grid', 'aria-busy': true },
        kinds.map(kind => h('div', { key: kind, className: 'rumi-badges-skeleton' }))))
  }

  ctx.slots.inject('rumi.projects.toolbar', () => ctx.slots.register({
    name: 'rumi.projects.toolbar', id: 'print-studio-badges', locale: NS,
  }, Toolbar))
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL, locale: NS }, Collection))
}
