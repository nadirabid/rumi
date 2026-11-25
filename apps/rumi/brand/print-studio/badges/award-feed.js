/** Live badge awards for the shell reveal and the open collection. */
import { PRINT_BADGE_KINDS } from '../badges-kinds.js'

const MAX_QUEUED_AWARDS = 8
const MAX_REMEMBERED_AWARDS = 128

/**
 * Share one live-only subscription across both views. The collection refreshes
 * even when a burst fills the reveal queue.
 * @param {string} path Authenticated badge events endpoint.
 * @returns {object} Snapshot readers, subscription, and reveal dismissal.
 */
export function createBadgeAwardFeed(path) {
  const listeners = new Set()
  const queue = []
  const seen = new Set()
  let revision = 0
  const notify = () => { for (const listener of listeners) listener() }

  function receive(event) {
    if (typeof event.data !== 'string' || event.data.length > 8_192) return
    let notice
    try { notice = JSON.parse(event.data) }
    catch (error) {
      if (error instanceof SyntaxError) return
      throw error
    }
    if (typeof notice?.projectName !== 'string' || !Array.isArray(notice.awards)
      || notice.awards.length > PRINT_BADGE_KINDS.length) return
    const fresh = []
    for (const award of notice.awards) {
      if (typeof award?.id !== 'string' || !award.id || award.id.length > 128
        || !PRINT_BADGE_KINDS.includes(award.kind) || seen.has(award.id)) continue
      seen.add(award.id)
      if (seen.size > MAX_REMEMBERED_AWARDS) seen.delete(seen.values().next().value)
      fresh.push({ id: award.id, kind: award.kind, projectName: notice.projectName })
    }
    if (fresh.length === 0) return
    queue.push(...fresh.slice(0, MAX_QUEUED_AWARDS - queue.length))
    revision += 1
    notify()
  }

  return {
    connect() {
      const source = new EventSource(path)
      source.addEventListener('badge-earned', receive)
      return () => {
        source.removeEventListener('badge-earned', receive)
        source.close()
      }
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    active: () => queue[0],
    revision: () => revision,
    dismiss(id) {
      if (queue[0]?.id !== id) return
      queue.shift()
      notify()
    },
  }
}
