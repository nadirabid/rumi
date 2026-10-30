/** A project carries its own instructions: the frame plus what its type adds. */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createProjectStore, createProjectTypes, projectInstructionsFor, renderProjectInstructions } from '../brand/projects/index.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function root(): string {
  const directory = mkdtempSync(join(tmpdir(), 'rumi-project-types-'))
  roots.push(directory)
  return directory
}

describe('createProjectTypes', () => {
  it('keeps contributions by id and forgets them when the registration is disposed', () => {
    const types = createProjectTypes()
    const dispose = types.register({ id: 'print', label: '3D printing', isDefault: true, templates: [] })
    expect(types.get('print')?.label).toBe('3D printing')
    expect(types.defaultType()?.id).toBe('print')
    dispose()
    expect(types.get('print')).toBeNull()
    expect(types.defaultType()).toBeNull()
  })

  it('falls back to the first registered type when none is marked default', () => {
    const types = createProjectTypes()
    types.register({ id: 'print' })
    types.register({ id: 'story' })
    expect(types.defaultType()?.id).toBe('print')
  })

  it('rejects a second registration of the same id', () => {
    const types = createProjectTypes()
    types.register({ id: 'print' })
    expect(() => types.register({ id: 'print' })).toThrow(/already registered/u)
  })
})

describe('renderProjectInstructions', () => {
  it('leads with the project name and keeps the templates in order', () => {
    const text = renderProjectInstructions({
      name: 'Dragon cup',
      templates: ['## This project\n\nFrame.', '## What this project makes\n\nType.'],
    })
    expect(text.startsWith('# Dragon cup\n')).toBe(true)
    expect(text.indexOf('## This project')).toBeLessThan(text.indexOf('## What this project makes'))
    expect(text).toMatch(/\n\n## What this project makes/u)
    expect(text.endsWith('\n')).toBe(true)
  })

  it('skips an empty template instead of leaving a gap', () => {
    const text = renderProjectInstructions({ name: 'Moon lamp', templates: ['   ', '## Type'] })
    expect(text).toBe('# Moon lamp\n\n## Type\n')
  })
})

describe('createProjectStore instructions', () => {
  it('writes AGENTS.md from the settled name and records the type', async () => {
    const projects = createProjectStore(root())
    const project = await projects.create('', {
      type: 'print',
      instructions: name => renderProjectInstructions({ name, templates: ['## What this project makes'] }),
    })
    expect(project.name).toBe('Untitled 1')
    expect(project.type).toBe('print')
    const written = readFileSync(join(project.path, 'AGENTS.md'), 'utf8')
    expect(written.startsWith('# Untitled 1\n')).toBe(true)
    expect(written).toContain('## What this project makes')
  })

  it('writes no instructions when the caller supplies none', async () => {
    const projects = createProjectStore(root())
    const project = await projects.create('Kept')
    expect(project.type).toBeNull()
    expect(() => readFileSync(join(project.path, 'AGENTS.md'), 'utf8')).toThrow()
  })
})

describe('projectInstructionsFor', () => {
  it("returns the instructions the session's project was created with", async () => {
    const projects = createProjectStore(root())
    const project = await projects.create('Dragon cup', {
      type: 'print',
      instructions: name => renderProjectInstructions({ name, templates: ['## What this project makes'] }),
    })
    await projects.attachSession(project.id, 'session-7')
    const text = await projectInstructionsFor(projects, 'session-7')
    expect(text).toContain('# Dragon cup')
    expect(text).toContain('## What this project makes')
  })

  it('answers empty for a session no project owns', async () => {
    const projects = createProjectStore(root())
    await projects.create('Moon lamp', { instructions: () => '# Moon lamp\n' })
    expect(await projectInstructionsFor(projects, 'session-unknown')).toBe('')
  })
})
