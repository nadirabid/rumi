/** Compact model-visible validation without changing the diagnostic report. */

/**
 * Count passing probes; retain every failed or inconclusive probe and all coverage.
 * @param {object | null} report Current or previous validation report.
 * @returns {object | null} Model-facing report; the input remains unchanged.
 */
export function summarizeValidationReport(report) {
  if (!report?.mechanics?.connections) return report
  return { ...report, mechanics: { ...report.mechanics,
    connections: report.mechanics.connections.map(connection => {
      const probeCounts = { passed: 0, needs_repair: 0, review: 0 }
      for (const probe of connection.probes) probeCounts[probe.status]++
      return { ...connection, probeCounts, probes: connection.probes.filter(probe => probe.status !== 'passed') }
    }),
  } }
}

/**
 * Compact current and previous reports for the logged model context.
 * @param {object | undefined} state Validation state, absent before initialization.
 * @returns {object | undefined} Same model identities and statuses with compact reports.
 */
export function summarizeValidationState(state) {
  if (!state) return state
  return { ...state, models: state.models.map(model => ({ ...model,
    report: summarizeValidationReport(model.report), previousReport: summarizeValidationReport(model.previousReport),
  })) }
}
