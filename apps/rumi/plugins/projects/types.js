/**
 * Registry of project types.
 *
 * Rumi's own plugin owns the creation flow; a project-type plugin contributes
 * what its type adds. Registration is scoped to the registering plugin, so a
 * type disappears with the plugin that declared it.
 * @returns {{register: (contribution: object) => () => void, get: (id: string) => object | null, defaultType: () => object | null}} the registry.
 */
export function createProjectTypes() {
  const types = new Map()
  return {
    register(contribution) {
      const id = contribution?.id
      if (typeof id !== 'string' || id === '') throw new Error('project type: an id is required')
      if (types.has(id)) throw new Error(`project type: ${id} is already registered`)
      const entry = {
        id,
        label: typeof contribution.label === 'string' ? contribution.label : id,
        isDefault: contribution.isDefault === true,
        ...(contribution.onOpen ? { onOpen: contribution.onOpen } : {}),
        templates: Array.isArray(contribution.templates) ? contribution.templates : [],
      }
      types.set(id, entry)
      return () => { types.delete(id) }
    },
    get(id) {
      return types.get(id) ?? null
    },
    /** The type a new project gets when the caller names none. */
    defaultType() {
      for (const entry of types.values()) if (entry.isDefault) return entry
      return types.values().next().value ?? null
    },
  }
}
