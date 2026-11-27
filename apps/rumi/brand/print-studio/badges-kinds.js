/** Stable badge identities and category helpers shared by evaluators, storage, and the UI. */
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
