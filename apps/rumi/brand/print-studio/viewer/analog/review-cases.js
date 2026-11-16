/** Deterministic endpoints and coupled extremes. @param {object} spec Validated control recipe. @returns {object} Neutral values and comparison cases. */
export function controlReviewCases(spec) {
  const axes = spec.controls.flatMap(control => control.axes)
  const neutral = { ...spec.values, ...Object.fromEntries(axes.map(axis => [axis.key, axis.reset])) }
  if (spec.operation === 'fields') for (const key of Object.keys(neutral)) neutral[key] = 0
  else neutral.amount = .5
  const cases = []
  for (const axis of axes) {
    // Auxiliary deformation controls need a nonzero amount to reveal their effect.
    const baseline = spec.operation !== 'fields' && axis.key !== 'amount' ? { ...neutral, amount: 1 } : neutral
    for (const endpoint of ['min', 'max']) {
      const values = { ...baseline, [axis.key]: axis[endpoint] }
      if (JSON.stringify(values) !== JSON.stringify(baseline)) cases.push({ id: `${axis.key}:${endpoint}`, key: axis.key, baseline, values })
    }
  }
  for (const endpoint of ['min', 'max']) {
    const values = { ...neutral, ...Object.fromEntries(axes.map(axis => [axis.key, axis[endpoint]])) }
    if (JSON.stringify(values) !== JSON.stringify(neutral)) cases.push({ id: `combined:${endpoint}`, key: null, baseline: neutral, values })
  }
  return { neutral, cases }
}
