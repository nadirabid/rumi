/** Load the signed-in account's advertised speeds for one conversation and model. */
import { useEffect, useState } from 'react'

type Tier = 'auto' | 'priority' | 'ultrafast'
interface Speed { requested: Tier; tiers: Tier[] }
export function useSpeed(sessionId: string, model: string | null, open: boolean) {
  const key = JSON.stringify([sessionId, model])
  const [state, update] = useState<{ key: string; speed?: Speed; failed?: boolean; saving?: boolean }>()
  const [revision, reload] = useState(0)
  useEffect(() => {
    if (!open || !model) return
    const controller = new AbortController()
    const query = new URLSearchParams({ sessionId, model })
    fetch('/api/rumi-chatgpt/speed?' + query, { signal: controller.signal, cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) throw new Error(String(response.status))
        const speed: Speed = await response.json()
        if (!controller.signal.aborted) update({ key, speed })
      }).catch(() => { if (!controller.signal.aborted) update({ key, failed: true }) })
    return () => controller.abort()
  }, [open, key, revision, sessionId, model])
  const current = state?.key === key ? state : undefined
  async function save(tier: Tier) {
    if (!current?.speed || current.saving) return false
    update({ ...current, saving: true })
    try {
      const response = await fetch('/api/rumi-chatgpt/speed', { method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Rumi-Settings': '1' },
        body: JSON.stringify({ sessionId, model, tier }) })
      if (!response.ok) throw new Error(String(response.status))
      const speed: Speed = await response.json()
      update({ key, speed })
      return true
    } catch {
      update({ ...current, failed: true, saving: false })
      return false
    }
  }
  return { ...current, save, retry: () => reload(n => n + 1) }
}
