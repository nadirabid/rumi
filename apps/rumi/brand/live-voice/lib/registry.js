/** Contributor registry for Live Voice context. */

/** Contributor fields the host will call. */
export const CONTRIBUTOR_FIELDS = ['instructions', 'thinking', 'commentary'];

/**
 * Contributors consulted when a live session needs context.
 *
 * The host owns the wire: delegation ids, channel caps, and timing. A
 * contributor supplies content and never touches the socket. Registration is
 * ordered and disposable; a duplicate id fails rather than silently replacing.
 * @returns {{register: (contributor: object) => () => void, contributors: () => object[]}} the registry.
 */
export function createLiveVoiceRegistry() {
  /** @type {{id: string, order: number}[]} */
  const entries = [];
  return {
    register(contributor) {
      const id = contributor?.id;
      if (typeof id !== 'string' || id === '') throw new Error('live voice: a contributor id is required');
      if (entries.some((entry) => entry.id === id)) throw new Error(`live voice: ${id} is already registered`);
      const normalised = { ...contributor, order: Number.isFinite(contributor.order) ? contributor.order : 100 };
      for (const field of CONTRIBUTOR_FIELDS) {
        if (normalised[field] !== undefined && typeof normalised[field] !== 'function') {
          throw new Error(`live voice: ${id}.${field} must be a function`);
        }
      }
      entries.push(normalised);
      entries.sort((left, right) => left.order - right.order);
      return () => {
        const index = entries.indexOf(normalised);
        if (index >= 0) entries.splice(index, 1);
      };
    },
    /** Contributions in `order`, as the host reads them at session start. */
    contributors() {
      return [...entries];
    },
  };
}

/**
 * Compose the startup instructions for one Session.
 *
 * The plugin's own standing orders come first, then each contributor in order.
 * GPT-Live freezes instructions when the session starts, so this runs before
 * the socket opens; a contributor that throws is reported and skipped rather
 * than stopping the session.
 * @param {{base: string, contributors: readonly object[], sessionId: string, onError?: (id: string, error: unknown) => void}} request - Composition inputs.
 * @returns {Promise<string>} Instructions for `session.start`.
 */
export async function composeInstructions({ base, contributors, sessionId, onError = () => {} }) {
  const parts = [base];
  for (const contributor of contributors) {
    if (typeof contributor.instructions !== 'function') continue;
    try {
      const text = await contributor.instructions(sessionId);
      if (typeof text === 'string' && text.trim() !== '') parts.push(text.trim());
    } catch (error) {
      onError(contributor.id, error);
    }
  }
  return parts.join('\n\n');
}
