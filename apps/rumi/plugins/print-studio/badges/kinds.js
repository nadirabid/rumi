/** Stable badge identities, labels, and category helpers shared by evaluators, storage, voice, and the UI. */

export const PRINT_BADGE_KINDS = Object.freeze([
  'barrel-hinge', 'living-hinge', 'wheel-and-axle', 'dovetail-slide', 'gear-pair', 'rack-and-pinion',
])

/** Project-level maker habit badge identities evaluated across session turns. */
export const HABIT_BADGE_KINDS = Object.freeze([
  'language', 'patience', 'persistence',
])

/** All Rumi badge identities displayed in the global collection and reveal feed. */
export const ALL_BADGE_KINDS = Object.freeze([
  ...PRINT_BADGE_KINDS, ...HABIT_BADGE_KINDS,
])

/** Canonical human-readable English display labels for each badge identity. */
export const BADGE_LABELS = Object.freeze({
  'barrel-hinge': 'Barrel hinge',
  'living-hinge': 'Living hinge',
  'wheel-and-axle': 'Wheel and axle',
  'dovetail-slide': 'Dovetail slide',
  'gear-pair': 'Gear pair',
  'rack-and-pinion': 'Rack and pinion',
  language: 'Language',
  patience: 'Patience',
  persistence: 'Persistence',
})

/**
 * Resolve the display label for one badge identity.
 * @param {string} kind Badge identifier.
 * @returns {string} Display label, falling back to `kind`.
 */
export function badgeLabel(kind) {
  return BADGE_LABELS[kind] ?? kind
}

/**
 * Resolve the display category for one badge identity.
 * @param {string} kind Badge identifier.
 * @returns {'mechanical' | 'habit' | null} Category name, or null for unrecognized kinds.
 */
export function badgeCategory(kind) {
  if (PRINT_BADGE_KINDS.includes(kind)) return 'mechanical'
  if (HABIT_BADGE_KINDS.includes(kind)) return 'habit'
  return null
}
