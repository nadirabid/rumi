/**
 * Rumi projects — host half: project type registry, HTTP routes, prompt scope, and session-title sync.
 */
import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createProjectEvents } from './events.js'
import {
  createProjectStore,
  DEFAULT_NAME_PATTERN,
  effectiveNameSource,
  PROJECT_ID_PATTERN,
  projectInstructionsFor,
  renderProjectInstructions,
} from './store.js'
import { createProjectTypes } from './types.js'

export { createProjectStore, createProjectTypes, projectInstructionsFor, renderProjectInstructions }

/** The plugin row id. */
export const name = 'rumi-projects'

/** Services this host half reaches. */
export const inject = ['connection', 'rumiProjectScope']

const ROUTE = '/api/rumi-projects'
const DEFAULT_TYPE = 'print'
const BASE_TEMPLATE = join(import.meta.dirname, 'AGENTS_TEMPLATE.md')
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

async function readTemplate(path) {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'cache-control': 'private, no-store', 'content-type': 'application/json', 'x-content-type-options': 'nosniff' },
  })
}

function isValidThumbnail(bytes) {
  if (bytes.length < 24 || bytes.length > 6 * 1024 * 1024
    || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)
    || bytes.toString('ascii', 12, 16) !== 'IHDR') {
    return false
  }
  const width = bytes.readUInt32BE(16)
  const height = bytes.readUInt32BE(20)
  const legacy = width === 480 && height === 320 && bytes.length <= 512 * 1024
  return legacy || (width === 1440 && height === 960)
}

/**
 * Register the project routes, type registry, live voice contributor, and title sync.
 * @param {object} ctx - Cordis host context with connection and project scope.
 * @param {{root?: string}} [config] - Project directory root; defaults to the project scope's workspace root.
 * @returns {void}
 */
export function apply(ctx, config = {}) {
  const store = createProjectStore(config.root ?? ctx.rumiProjectScope.workspaceRoot)
  const types = createProjectTypes()
  const events = createProjectEvents()
  ctx.effect(() => () => events.close(), 'rumi projects: events')
  ctx.provide('rumiProjectTypes', types)

  const syncSessionTitle = async (session, snapshot) => {
    if (!snapshot || snapshot.source?.kind === 'fallback') return null
    const owner = await store.findBySession(session.id, session.header?.cwd)
    if (!owner) return null
    const source = snapshot.source?.kind === 'user' ? 'user' : 'auto'
    if (source === 'user' && DEFAULT_NAME_PATTERN.test(snapshot.title) && effectiveNameSource(owner) === 'default') {
      return owner
    }
    const { project, changed } = await store.rename(owner.id, snapshot.title, { source })
    if (changed) events.publish(project)
    return project
  }

  let titleServices = null
  const refreshedLegacy = new Set()
  const reconcileSessionTitle = async (session, knownOwner = null) => {
    if (!titleServices || !session) return knownOwner
    const owner = knownOwner ?? await store.findBySession(session.id, session.header?.cwd)
    if (!owner || effectiveNameSource(owner) !== 'default') return owner
    const current = titleServices.sessionTitle.get(session)
    if (current?.source.kind === 'provider') {
      return (await syncSessionTitle(session, current)) ?? owner
    }
    if (current?.source.kind === 'user'
      && DEFAULT_NAME_PATTERN.test(current.title)
      && typeof session.requestHeader === 'function'
      && session.requestHeader() !== undefined
      && !refreshedLegacy.has(session.id)) {
      refreshedLegacy.add(session.id)
      void titleServices.sessionTitle.refresh(session).catch(error => {
        refreshedLegacy.delete(session.id)
        ctx.logger?.warn(`rumi projects: failed to refresh legacy untitled project ${owner.id}: ${error instanceof Error ? error.message : String(error)}`)
      })
    }
    return owner
  }

  ctx.inject(['sessions', 'sessionTitle'], (scoped) => {
    const services = { sessions: scoped.sessions, sessionTitle: scoped.sessionTitle }
    titleServices = services
    scoped.effect(() => () => {
      if (titleServices === services) titleServices = null
    }, 'rumi projects: session title services')
    scoped.on('session/created', (session) => {
      void reconcileSessionTitle(session).catch(error => {
        scoped.logger?.warn(`rumi projects: failed to reconcile session title for ${session.id}: ${error instanceof Error ? error.message : String(error)}`)
      })
    })
    scoped.on('session/event', (session, event) => {
      if (event.type === 'session/title') {
        void syncSessionTitle(session, event.data).catch(error => {
          scoped.logger?.warn(`rumi projects: failed to sync session title for ${session.id}: ${error instanceof Error ? error.message : String(error)}`)
        })
        return
      }
      if (event.type === 'request/header') {
        void reconcileSessionTitle(session).catch(error => {
          scoped.logger?.warn(`rumi projects: failed to reconcile legacy session title for ${session.id}: ${error instanceof Error ? error.message : String(error)}`)
        })
      }
    })
  })

  const currentInstructions = readFileSync(BASE_TEMPLATE, 'utf8')
  ctx.inject(['systemPrompt'], (scoped) => {
    scoped.effect(() => scoped.systemPrompt.section({
      name: 'rumi:project-scope', order: scoped.systemPrompt.getSectionOrder('TOOL_WORKFLOW'),
      text: currentInstructions,
    }), 'rumi project scope')
  })

  const instructionsFor = (sessionId) => projectInstructionsFor(store, sessionId)
  ctx.inject(['liveVoice'], (scoped) => {
    scoped.effect(() => scoped.liveVoice.register({
      id: 'project',
      instructions: instructionsFor,
    }), 'rumi projects: live voice context')
  })

  const route = (path, methods, fetch) => ctx.effect(() => ctx.connection.fetch.register({
    path: `${ROUTE}${path}`, methods, requestBody: 'buffered', fetch,
  }), `rumi projects: ${methods.join(',')} ${ROUTE}${path}`)

  route('', ['GET', 'POST', 'DELETE'], async (request) => {
    if (request.method === 'DELETE') {
      const projectId = new URL(request.url).searchParams.get('projectId') ?? ''
      try {
        await store.remove(projectId)
      } catch (error) {
        if (error.code === 'ENOENT' || !PROJECT_ID_PATTERN.test(projectId)) return json({ error: 'project_not_found' }, 404)
        throw error
      }
      return new Response(null, { status: 204 })
    }
    if (request.method !== 'POST') return json({ projects: await store.list() })
    const body = await request.json().catch(() => ({}))
    const type = types.get(typeof body.type === 'string' ? body.type : DEFAULT_TYPE) ?? types.defaultType()
    const base = await readTemplate(BASE_TEMPLATE)
    if (base === null) return json({ error: 'project_template_missing' }, 500)
    const templates = [base]
    for (const path of type?.templates ?? []) {
      const contributed = await readTemplate(path)
      if (contributed === null) ctx.logger?.warn(`rumi projects: type template is missing at ${path}`)
      else templates.push(contributed)
    }
    return json({
      project: await store.create(body.name, {
        type: type?.id ?? null,
        instructions: projectName => renderProjectInstructions({ name: projectName, templates }),
      }),
    }, 201)
  })

  route('/thumbnail', ['GET', 'POST'], async (request) => {
    const url = new URL(request.url)
    if (request.method === 'POST') {
      const sessionId = url.searchParams.get('sessionId')
      if (!sessionId) return json({ error: 'session_required' }, 400)
      const bytes = Buffer.from(await request.arrayBuffer())
      if (!isValidThumbnail(bytes)) return json({ error: 'invalid_thumbnail' }, 400)
      return await store.saveThumbnail(sessionId, bytes)
        ? new Response(null, { status: 204 }) : json({ error: 'project_not_found' }, 404)
    }
    try {
      const bytes = await store.thumbnail(url.searchParams.get('projectId') ?? '')
      return new Response(bytes, {
        headers: { 'content-type': 'image/png', 'cache-control': 'private, no-cache', 'x-content-type-options': 'nosniff' },
      })
    } catch (error) {
      if (error.code === 'ENOENT' || !PROJECT_ID_PATTERN.test(url.searchParams.get('projectId') ?? '')) {
        return json({ error: 'thumbnail_not_found' }, 404)
      }
      throw error
    }
  })

  route('/events', ['GET'], async (request) => events.response(request.signal))

  route('/session', ['POST'], async (request) => {
    const body = await request.json().catch(() => ({}))
    if (typeof body.projectId !== 'string' || typeof body.sessionId !== 'string') {
      return json({ error: 'project_and_session_required' }, 400)
    }
    try {
      const workspaceId = typeof body.workspaceId === 'string' ? body.workspaceId : undefined
      let project = await store.attachSession(body.projectId, body.sessionId, workspaceId)
      if (effectiveNameSource(project) === 'default' && titleServices !== null) {
        const session = titleServices.sessions.get(body.sessionId)
        if (session !== undefined) {
          project = (await reconcileSessionTitle(session, project)) ?? project
        }
      }
      types.get(project.type)?.onOpen?.(project)
      return json({ project })
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : String(error) }, 404)
    }
  })
}
