/** Physical movement guidance applies to existing and newly created print projects. */
export const name = 'rumi-mechanical-modeling'
export const inject = ['systemPrompt']
/** Register modeling requirements for automatic mechanical validation. @param {object} ctx Prompt owner. */
export function apply(ctx) {
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'rumi:mechanical-modeling', order: ctx.systemPrompt.getSectionOrder('TOOL_WORKFLOW'),
    text: 'For multi-part or movable prints, read blender-modeling and publish a complete assembly with every physical mesh, root fixture, connection, axis, pivot and full movement range. Include pins, caps and axles. JavaScript models export assembly and bind every motionControls axis to its connection; controls use degrees or millimetres. Blender publish preserves assembly metadata. Preserve requested features, connectors, controls and ranges during repairs. Changed candidates are checked automatically after turns: Blender checks geometry and bundled Bullet tests the whole assembly with only the root held, without ideal joints. Read the matching meshState.validation report before claiming acceptance. Missing descriptions, disconnected pieces and blocked movement require repair. Unavailable, unsupported or incomplete checks remain unverified. A passing rigid-contact test does not certify assembly accessibility, deformation, material strength or slicer readiness.',
  }), 'print-studio mechanical workflow')
}
