/** Projects are directories on disk; the host routes expose them without touching session state. */
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { apply, createProjectStore } from '../index.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function root() {
  const directory = mkdtempSync(join(tmpdir(), 'rumi-projects-'))
  roots.push(directory)
  return directory
}

it('creates a project directory with the metadata and the artifact folders', async () => {
  const projects = createProjectStore(root())
  const project = await projects.create('Dragon cup')
  expect(project.name).toBe('Dragon cup')
  expect(project.sessionIds).toEqual([])
  expect(project.activeSessionId).toBeNull()
  expect(statSync(join(project.path, 'project.json')).isFile()).toBe(true)
  for (const child of ['artifacts', 'source', 'references']) {
    expect(statSync(join(project.path, child)).isDirectory()).toBe(true)
  }
  expect(JSON.parse(readFileSync(join(project.path, 'project.json'), 'utf8')).path).toBeUndefined()
})

it('names an unnamed project and lists the newest first', async () => {
  const projects = createProjectStore(root())
  const first = await projects.create('')
  await new Promise(resolve => setTimeout(resolve, 10))
  await projects.create('Marble run')
  expect(first.name).toBe('Untitled 1')
  const listed = await projects.list()
  expect(listed.map(project => project.name)).toContain('Untitled 1')
  expect(listed[0].name).toBe('Marble run')
  expect(listed.every(project => typeof project.path === 'string')).toBe(true)
})

it('records the session a project uses and keeps earlier ones', async () => {
  const projects = createProjectStore(root())
  const project = await projects.create('Moon lamp')
  const attached = await projects.attachSession(project.id, 'session-1')
  expect(attached.activeSessionId).toBe('session-1')
  const again = await projects.attachSession(project.id, 'session-1')
  expect(again.sessionIds).toEqual(['session-1'])
  const later = await projects.attachSession(project.id, 'session-2')
  expect(later.sessionIds).toEqual(['session-1', 'session-2'])
  expect(later.activeSessionId).toBe('session-2')
})

it('ignores directories that are not projects and tolerates a missing root', async () => {
  const directory = root()
  const projects = createProjectStore(directory)
  expect(await projects.list()).toEqual([])
  rmSync(directory, { recursive: true, force: true })
  expect(await projects.list()).toEqual([])
})

it('refuses an id that is not a plain directory name', async () => {
  const projects = createProjectStore(root())
  await expect(projects.attachSession('../escape', 'session-1')).rejects.toThrow('invalid id')
})

it('serves the gallery over the connection routes', async () => {
  const routes = new Map<string, (request: Request) => Promise<Response>>()
  const cleanup: (() => void)[] = []
  const provided = new Map<string, unknown>()
  apply({
    effect: (effect: () => (() => void)) => cleanup.push(effect()),
    provide: (name: string, value: unknown) => {
      provided.set(name, value)
      return () => { provided.delete(name) }
    },
    connection: { fetch: { register: (route: { path: string; fetch: (request: Request) => Promise<Response> }) => {
      routes.set(route.path, route.fetch)
      return () => { routes.delete(route.path) }
    } } },
  }, { root: root() })
  const request = (path: string, init?: RequestInit) => routes.get(path.split('?')[0])!(new Request(`http://rumi${path}`, init))

  const created = await (await request('/api/rumi-projects', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Tiny rover' }),
  })).json()
  expect(created.project.name).toBe('Tiny rover')
  expect(provided.has('rumiProjectTypes')).toBe(true)
  expect(readFileSync(join(created.project.path, 'AGENTS.md'), 'utf8')).toContain('# Tiny rover')

  const listed = await (await request('/api/rumi-projects')).json()
  expect(listed.projects).toHaveLength(1)
  expect(listed.projects[0].path).toBe(created.project.path)

  const attached = await (await request('/api/rumi-projects/session', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ projectId: created.project.id, sessionId: 'session-9' }),
  })).json()
  expect(attached.project.activeSessionId).toBe('session-9')

  const missing = await request('/api/rumi-projects/session', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ projectId: 'nope' }),
  })
  expect(missing.status).toBe(400)
  for (const dispose of cleanup.toReversed()) dispose()
  expect(routes.size).toBe(0)
})

it('allocates distinct names concurrently and continues after reopening the store', async () => {
  const directory = root()
  const first = createProjectStore(directory)
  const second = createProjectStore(directory)
  const created = await Promise.all([first.create(), second.create(), first.create()])
  expect(created.map(project => project.name).sort()).toEqual(['Untitled 1', 'Untitled 2', 'Untitled 3'])
  expect((await createProjectStore(directory).create()).name).toBe('Untitled 4')
})
