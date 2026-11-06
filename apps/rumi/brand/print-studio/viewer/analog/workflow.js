/** Current analog editing guidance for both existing and new project conversations. */
export const name = 'rumi-analog-shaping'
export const inject = ['systemPrompt']
/** Register live operation guidance. @param {object} ctx Prompt-owning plugin context. */
export function apply(ctx) {
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'rumi:analog-shaping', order: ctx.systemPrompt.getSectionOrder('TOOL_WORKFLOW'),
    text: 'When the person asks to adjust a model themselves, including let me tilt both eyes, open real interactive controls before making their adjustment. Read interactive-controls and use viewer_controls with explicit labels and bindings. Controls are generic: sliders, two-axis pads, and curves can bind named JavaScript model parameters or supported GLB deformation values. A missing binding means prepare a faithful parametric model first, not tell the person to request repeated rebuilds. Never substitute labels alone, unrelated deformation, or a simplified replacement that loses existing features. For direct edits without a request for controls, ordinary modeling remains appropriate. Read analog-shaping for built-in GLB deformation math. Keep controls open while exploring; freeze then save the latest visible values on satisfaction or before another task, and close on explicit cancel. Final JavaScript parameter models save through viewer_controls. A temporary JavaScript preview of an edit to an existing model must declare finish blender, the preserved original and a semantic edit recipe; freeze its latest values, apply them to the original in Blender, check printability, publish and load the result. GLB recipes save through Blender. Check the tool result before claiming controls are visible or a save succeeded.',
  }), 'print-studio analog workflow')
}
