export interface HostPrompt {
  id: string
  owner_id: string
  name: string
  content: string
  description: string | null
  is_default: boolean
  created_at: string
  updated_at: string
  storage_mode: 'local'
}
export interface HostPromptSnapshot { schema: 1; hostId: string; epoch: string; revision: number; prompts: HostPrompt[]; repairNeeded?: string }

/** Explicit public schema; never forward unknown preference/credential fields. */
export function validateHostPrompts(value: unknown): HostPrompt[] {
  if (!Array.isArray(value) || value.length > 1000) throw new Error('Invalid prompt collection')
  const ids = new Set<string>()
  let defaults = 0
  const prompts = value.map(row => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('Invalid prompt')
    const text = (key: string, max: number, required = true): string => {
      const result = row[key]
      if (typeof result !== 'string' || result.length > max || (required && !result.trim())) throw new Error(`Invalid prompt ${key}`)
      return result
    }
    const id = text('id', 200)
    if (!id.startsWith('local-') || ids.has(id)) throw new Error('Invalid or duplicate prompt ID')
    ids.add(id)
    if (typeof row.is_default !== 'boolean') throw new Error('Invalid prompt default')
    if (row.is_default && ++defaults > 1) throw new Error('Only one default prompt is allowed')
    return { id, owner_id: text('owner_id', 200), name: text('name', 100), content: text('content', 200_000),
      description: row.description == null ? null : text('description', 10_000, false), is_default: row.is_default,
      created_at: text('created_at', 64), updated_at: text('updated_at', 64), storage_mode: 'local' as const }
  })
  if (JSON.stringify(prompts).length > 2_000_000) throw new Error('Prompt collection is too large')
  return prompts
}
