/** In-memory pin choices for the global panel launchers. */
import { createSnapshotStore, type ObservableSnapshot } from '@deepseek-ai/dsh-client-store'

/** Panel the product always surfaces when a deployment seeds no list of its own. */
export const FIXED_PANEL_ID = 'plugins'

const NO_PANELS: readonly string[] = []

/**
 * Renderer global through which a deployment hides launcher rows on first paint.
 * The desktop preload sets it; a plain browser leaves it undefined and every
 * registered launcher renders as before.
 */
const HIDDEN_PANELS_GLOBAL = '__DSH_HIDDEN_PANELS__'

/** Read the deployment's initial unpinned ids, ignoring anything malformed. */
function initialUnpinned(): readonly string[] {
  const seeded = (globalThis as Record<string, unknown>)[HIDDEN_PANELS_GLOBAL]
  if (!Array.isArray(seeded)) return NO_PANELS
  const ids = seeded.filter((id): id is string => typeof id === 'string' && id !== '')
  return ids.length === 0 ? NO_PANELS : ids
}

/** Unpinned panel ids and their only mutation. */
export interface PanelPins {
  /** Unpinned panel ids; ids of panels that are not registered stay listed. */
  readonly unpinned: ObservableSnapshot<readonly string[]>
  /**
   * Pin or unpin one panel launcher.
   * @param id - Panel id.
   * @param pinned - Whether the launcher is manually pinned.
   */
  readonly setPinned: (id: string, pinned: boolean) => void
}

/**
 * Create the in-memory panel pin list; the snapshot keeps its reference until the list changes.
 * @returns Unpinned panel ids and the pin mutation.
 */
export function createPanelPins(): PanelPins {
  const store = createSnapshotStore<{ readonly unpinned: readonly string[] }>({ unpinned: initialUnpinned() })
  return {
    unpinned: { getSnapshot: () => store.getSnapshot().unpinned, subscribe: listener => store.subscribe(listener) },
    setPinned: (id, pinned) => {
      const current = store.getSnapshot().unpinned
      if (pinned !== current.includes(id)) return
      store.set({ unpinned: pinned ? current.filter(entry => entry !== id) : [...current, id] })
    },
  }
}
