/** Temporary Blender-to-CAD migration detection, AGENTS.md upgrade, and prompt notice. */
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import {
  formatLegacyCadUpgradeNotice,
  inspectLegacyBlenderProject,
  registerLegacyCadMigration,
  upgradeLegacyProjectInstructions,
} from '../cad/legacy-migration.js'

const TEMPLATE_PATH = join(import.meta.dirname, '..', 'AGENTS_TEMPLATE.md')

const LEGACY_AGENTS = `# Old Kart

## This project

Custom base notes stay intact.

### Project type

This project is for designing and creating 3d prints.

### Editable designs

Use background Blender Python scripts. Call \`blender_status\`, then read the \`blender-modeling\` skill.
`

const BLENDER_USD = `#usda 1.0
(
    defaultPrim = "Model"
    doc = "Blender v4.5.15 LTS"
    metersPerUnit = 1
    upAxis = "Z"
)
def Xform "Model" {}
`

const CAD_USD = `#usda 1.0
(
    defaultPrim = "Model"
    doc = "Rumi CAD"
    metersPerUnit = 1
    upAxis = "Z"
)
def Xform "Model" {}
`

it('upgrades stale Blender AGENTS.md and emits a CAD upgrade notice until republished with Rumi CAD', async () => {
  const workspace = await realpath(await mkdtemp(join(tmpdir(), 'rumi-legacy-cad-')))
  const root = join(workspace, randomUUID()), id = root.split('/').at(-1)!
  const modelDir = join(root, 'models', 'kart')
  const sourceDir = join(root, 'source')
  const session = { id: 'sess-1', header: { cwd: root } }
  let dispose!: () => Promise<void>
  let preStep!: (args: object, next: () => Promise<void>) => Promise<void>
  let context!: (args: object) => string
  const ctx = {
    rumiProjectScope: { workspaceRoot: workspace },
    logger: { warn: vi.fn() },
    effect(start: () => () => Promise<void>) { dispose = start() },
    on(_name: string, callback: typeof preStep) { preStep = callback },
    inject(_names: string[], register: (scope: object) => void) {
      register({
        effect: (start: () => void) => start(),
        systemPrompt: {
          getContextOrder: () => 0,
          context: (entry: { text: typeof context }) => { context = entry.text },
        },
      })
    },
  }
  const agent = { session }, next = vi.fn(async () => {})
  const checkNotice = async () => { await preStep({ agent }, next); return context({ agent }) }

  try {
    await mkdir(modelDir, { recursive: true })
    await mkdir(sourceDir, { recursive: true })
    await writeFile(join(root, 'project.json'), JSON.stringify({ id, type: 'print', name: 'Old Kart', sessionIds: ['sess-1'] }))
    await writeFile(join(root, 'AGENTS.md'), LEGACY_AGENTS)
    await writeFile(join(modelDir, 'model.usda'), BLENDER_USD)
    await writeFile(join(sourceDir, 'build_kart.py'), 'import bpy\n# legacy blender build\n')

    const onOpen = registerLegacyCadMigration(ctx, TEMPLATE_PATH)
    onOpen({ path: root })
    await vi.waitFor(async () => {
      const updated = await readFile(join(root, 'AGENTS.md'), 'utf8')
      expect(updated).toContain('cad_status')
    })

    const updatedAgents = await readFile(join(root, 'AGENTS.md'), 'utf8')
    expect(updatedAgents).toContain('# Old Kart')
    expect(updatedAgents).toContain('Custom base notes stay intact.')
    expect(updatedAgents).toContain('cad-modeling')
    expect(updatedAgents).not.toContain('blender_status')
    expect(updatedAgents).not.toContain('blender-modeling')

    const notice = await checkNotice()
    expect(notice).toContain('Legacy Blender-to-CAD upgrade required')
    expect(notice).toContain('"legacyBlenderModels":["models/kart/model.usda"]')
    expect(notice).toContain('"legacyBlenderScripts":["source/build_kart.py"]')
    expect(notice).toContain('do not hand-edit model.usda directly')

    // Once republished by build123d CAD, the temporary upgrade notice clears automatically.
    await writeFile(join(modelDir, 'model.usda'), CAD_USD)
    expect(await checkNotice()).toBe('')
  } finally {
    await dispose?.()
    await rm(workspace, { recursive: true, force: true })
  }
})

it('detects legacy models from blend-only revisions and stays silent for empty or CAD projects', async () => {
  const workspace = await realpath(await mkdtemp(join(tmpdir(), 'rumi-legacy-rev-')))
  const root = join(workspace, 'proj')
  const revDir = join(root, 'models', 'widget', 'revisions', 'rev1')
  try {
    await mkdir(revDir, { recursive: true })
    await writeFile(join(root, 'AGENTS.md'), LEGACY_AGENTS)
    await writeFile(join(root, 'models', 'widget', 'model.usda'), '#usda 1.0\ndef Xform "Model" {}\n')
    await writeFile(join(revDir, 'model.blend'), 'BLENDER')

    const legacy = await inspectLegacyBlenderProject(root, TEMPLATE_PATH)
    expect(legacy.instructionsUpgraded).toBe(true)
    expect(legacy.legacyBlenderModels).toEqual(['models/widget/model.usda'])
    expect(formatLegacyCadUpgradeNotice(legacy)).toContain('models/widget/model.usda')

    // Adding a STEP/BREP revision marks it upgraded even without a header doc string.
    await writeFile(join(revDir, 'model.step'), 'ISO-10303-21;')
    const upgraded = await inspectLegacyBlenderProject(root, TEMPLATE_PATH)
    expect(upgraded.instructionsUpgraded).toBe(false)
    expect(upgraded.legacyBlenderModels).toEqual([])
    expect(formatLegacyCadUpgradeNotice(upgraded)).toBe('')
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

it('refuses to overwrite a symlinked AGENTS.md outside the project', async () => {
  const workspace = await realpath(await mkdtemp(join(tmpdir(), 'rumi-legacy-sym-')))
  const root = join(workspace, 'proj')
  const outside = join(workspace, 'outside.md')
  try {
    await mkdir(root, { recursive: true })
    await writeFile(outside, LEGACY_AGENTS)
    await symlink(outside, join(root, 'AGENTS.md'))
    expect(await upgradeLegacyProjectInstructions(root, TEMPLATE_PATH)).toBe(false)
    expect(await readFile(outside, 'utf8')).toBe(LEGACY_AGENTS)
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})
