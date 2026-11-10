/** Physical movement guidance applies to existing and newly created print projects. */
export const name = 'rumi-mechanical-modeling'
export const inject = ['systemPrompt']
/** Register modeling requirements for explicit mechanical validation. @param {object} ctx Prompt owner. */
export function apply(ctx) {
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'rumi:mechanical-modeling', order: ctx.systemPrompt.getSectionOrder('TOOL_WORKFLOW'),
    text: 'For multi-part or movable prints, read blender-modeling and publish a complete assembly with every physical mesh, root fixture, connection, axis, pivot and full movement range. Include pins, caps and axles. JavaScript models export assembly and bind every motionControls axis to its connection; controls use degrees or millimetres. Blender publish preserves assembly metadata. Preserve requested features, connectors, controls and ranges during repairs. After each build, read the RUMI_CHECKS line that publish prints and repair blocking findings. When the design is ready, follow blender-modeling: call validation_mechanics once for the costly Bullet test, then validation_accept with the returned fingerprint. The bundled Bullet checker holds only the root, without ideal joints. No turn-end checks or automatic repair turns run. Read the matching meshState.validation report before claiming acceptance. Missing descriptions, disconnected pieces and blocked movement require repair. Unavailable, unsupported or incomplete checks remain unverified. A passing rigid-contact test does not certify assembly accessibility, deformation, material strength or slicer readiness.',
  }), 'print-studio mechanical workflow')
}
