/** Durable movement requirements and accepted source files owned by Print Studio validation. */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile, rename, rm, stat, realpath } from 'node:fs/promises'
import { dirname, join, resolve, relative, sep } from 'node:path'

const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const fileName = value => typeof value === 'string' && value.length < 1024 && !value.startsWith('/')
  && value.split('/').every(part => part && part !== '.' && part !== '..' && !part.includes('\\'))
const coordinates = value => value && ['x', 'y', 'z'].every(axis => Number.isFinite(value[axis]))
const placement = value => value && Number.isFinite(value.scale) && value.scale > 0 && coordinates(value.rotate) && coordinates(value.position)
const requirementsValid = value => value && Array.isArray(value.movements) && value.movements.length <= 256
  && value.movements.every(item => item && ['control', 'connection'].includes(item.type)
    && (item.absolute === undefined || item.absolute === true)
    && typeof item.id === 'string' && item.id.length > 0 && item.id.length <= 128
    && (item.range === null || (Array.isArray(item.range) && item.range.length === 2
      && item.range.every(Number.isFinite) && item.range[0] <= item.range[1])))

/**
 * Retain canonical control limits and connection travel across repairs. Connections without an origin retain travel extent, not absolute endpoints.
 * @param {object} previous Durable required movements.
 * @param {object} intent Normalized intent returned by the validator.
 * @returns {{required: object, checks: object[]}} Monotonic requirements and preservation failures.
 */
export function preserveMovement(previous, intent) {
  const movements = new Map()
  const add = (type, id, range, origin) => movements.set(`${type}:${id}`, { type, id,
    range: range ? range.map(value => value + (Number.isFinite(origin) ? origin : 0)) : null,
    ...(Number.isFinite(origin) ? { absolute: true } : {}) })
  for (const key of intent?.motionKeys ?? []) add('control', key, null)
  for (const item of intent?.motionRanges ?? []) add('control', item.key, item.range, item.origin)
  for (const item of intent?.assembly?.connections ?? []) if (item.kind !== 'fixed') add('connection', item.id, item.range)
  const checks = []
  const travel = range => range[1] - range[0]
  for (const required of previous.movements) {
    const key = `${required.type}:${required.id}`, current = movements.get(key)
    const reduced = required.range && (!current?.range || (required.absolute
      ? !current.absolute || current.range[0] > required.range[0] || current.range[1] < required.range[1]
      : travel(current.range) < travel(required.range)))
    if (!current || reduced) {
      checks.push({ code: 'required_movement_removed', severity: 'error', count: 1,
        message: `Preserve ${required.type} ${required.id} and its required movement extent.`, details: required })
    }
    if (!current) movements.set(key, required)
    else if (required.range) {
      if (required.absolute && current.absolute && current.range) current.range = [Math.min(current.range[0], required.range[0]), Math.max(current.range[1], required.range[1])]
      else if (reduced) movements.set(key, required)
    }
  }
  return { required: { movements: [...movements.values()] }, checks }
}

/**
 * Open validation-owned storage for one project/model pair. Corrupt or inaccessible state rejects.
 * @param {string} directory Explicit private validation directory from plugin configuration.
 * @param {string} cwd Project identity.
 * @param {string} model Relative model entry identity.
 * @returns {object} Durable read and atomic write operations; source files are never changed.
 */
export function validationState(directory, cwd, model) {
  if (typeof directory !== 'string' || !directory) throw new Error('Configure validationStateDirectory')
  const key = createHash('sha256').update(JSON.stringify([resolve(cwd), model])).digest('hex')
  const root = join(directory, key), journal = join(root, 'state.json')
  let saved = { version: 1, required: { movements: [] }, accepted: null }
  return {
    async read() {
      let bytes
      try { if ((await stat(journal)).size > 128 * 1024) throw new Error('Validation state exceeds 128 KiB'); bytes = await readFile(journal, 'utf8') }
      catch (error) { if (error.code === 'ENOENT') return saved; throw error }
      const value = JSON.parse(bytes)
      if (value?.version !== 1 || !requirementsValid(value.required) || (value.accepted !== null
        && (!hash(value.accepted?.fingerprint) || !hash(value.accepted?.sourceHash)
          || !placement(value.accepted?.transform) || !(value.accepted.volume === null || (coordinates(value.accepted.volume) && ['x', 'y', 'z'].every(axis => value.accepted.volume[axis] > 0)))
          || !fileName(value.accepted?.entry) || !/^[a-f0-9-]{36}$/.test(value.accepted?.snapshot)))) throw new Error('Invalid persisted validation state')
      if (value.accepted) {
        const expected = join(root, value.accepted.snapshot), actual = await realpath(expected)
        if (actual !== join(await realpath(root), value.accepted.snapshot)) throw new Error('Accepted source must remain in validation storage')
        const entry = await realpath(join(expected, value.accepted.entry)), part = relative(actual, entry)
        if (part.startsWith(`..${sep}`) || part === '..' || part.startsWith(sep)) throw new Error('Accepted source escapes validation storage')
      }
      saved = value
      return { ...value, accepted: value.accepted ? { ...value.accepted, path: join(root, value.accepted.snapshot, value.accepted.entry), workspace: root } : null }
    },
    async write(required, accepted) {
      if (!requirementsValid(required)) throw new Error('Invalid required movement state')
      await mkdir(root, { recursive: true, mode: 0o700 })
      let next = { ...saved, required }, created = null
      const temporary = join(root, `${randomUUID()}.tmp`)
      try {
        if (accepted) {
          const snapshot = randomUUID(), target = join(root, snapshot)
          created = target
          await mkdir(target, { mode: 0o700 })
          for (const [name, bytes] of accepted.source.files) {
            if (!fileName(name)) throw new Error('Invalid accepted source filename')
            const path = join(target, name)
            await mkdir(dirname(path), { recursive: true, mode: 0o700 })
            await writeFile(path, bytes, { flag: 'wx', mode: 0o600 })
          }
          if (accepted.source.format === 'javascript' && Object.keys(accepted.state.parameters).length) {
            await writeFile(join(target, '.rumi-parameters.json'), JSON.stringify(accepted.state.parameters), { flag: 'wx', mode: 0o600 })
          }
          next.accepted = { fingerprint: accepted.fingerprint, sourceHash: accepted.state.contentHash,
            snapshot, entry: accepted.source.entry, transform: accepted.state.transform, volume: accepted.volume }
        }
        const data = JSON.stringify(next) + '\n'
        if (Buffer.byteLength(data) > 128 * 1024) throw new Error('Validation state exceeds 128 KiB')
        await writeFile(temporary, data, { flag: 'wx', mode: 0o600 })
        await rename(temporary, journal)
        const previous = saved
        saved = next
        created = null
        if (previous.accepted && previous.accepted.snapshot !== next.accepted?.snapshot) {
          await rm(join(root, previous.accepted.snapshot), { recursive: true, force: true })
        }
      } finally {
        await rm(temporary, { force: true })
        if (created) await rm(created, { recursive: true, force: true })
      }
    },
  }
}
