import fs from 'fs/promises'
import path from 'path'

const YGG_DIR_NAME = '.ygg'
const PLAN_DIR_NAME = 'plans'
const PLAN_FILE_EXTENSION = '.md'
const MAX_LIST_RESULTS = 50
const MAX_ID_ATTEMPTS = 12

const ID_DICTIONARY = [
  'amber',
  'atlas',
  'bridge',
  'cedar',
  'delta',
  'ember',
  'forge',
  'garden',
  'harbor',
  'island',
  'juniper',
  'keystone',
  'lantern',
  'meadow',
  'north',
  'orbit',
  'prairie',
  'quartz',
  'river',
  'summit',
  'trail',
  'violet',
]

export type PlanAction = 'create' | 'list' | 'read' | 'edit' | 'display' | 'clarify'

export interface PlanToolArgs {
  action: PlanAction
  name?: string
  content?: string
  search?: string
  replacement?: string
  cwd?: string
}

export interface PlanInfo {
  name: string
  modifiedAt: string
  title?: string
}

export interface ReadPlanResult {
  exists: boolean
  name: string
  content: string | null
}

export interface CreatePlanResult {
  name: string
  created: boolean
  content: string
  path: string
}

export interface EditPlanResult {
  success: boolean
  message: string
  name: string
  content: string | null
  path?: string
}

export interface DisplayPlanResult {
  displayed: boolean
  exists: boolean
  name: string
  path?: string
  message: string
  modelContent?: string
  content?: string
}

function normalizeName(rawName: string): string {
  const trimmed = rawName.trim().toLowerCase().replace(/\.md$/i, '').replace(/\s+/g, '-')
  if (!trimmed || /[^a-z0-9-]/.test(trimmed) || trimmed.startsWith('-') || trimmed.endsWith('-')) {
    throw new Error('Plan name must be lowercase alphanumeric with dashes (e.g., "feature-rollout")')
  }
  return trimmed
}

function firstMarkdownHeading(content: string): string | undefined {
  for (const line of content.split('\n')) {
    const match = line.match(/^#\s+(.+)$/)
    if (match?.[1]) return match[1].trim()
  }
  return undefined
}

function randomDictionaryWord(): string {
  return ID_DICTIONARY[Math.floor(Math.random() * ID_DICTIONARY.length)]
}

function generateCandidateName(): string {
  return `${randomDictionaryWord()}-${randomDictionaryWord()}-${randomDictionaryWord()}`
}

function resolveBaseDirectory(cwd?: string): string {
  const normalizedCwd = typeof cwd === 'string' ? cwd.trim() : ''
  if (normalizedCwd) return path.resolve(normalizedCwd)
  return path.resolve(process.cwd())
}

export function getPlanStorageDirectory(cwd?: string): string {
  return path.join(resolveBaseDirectory(cwd), YGG_DIR_NAME, PLAN_DIR_NAME)
}

async function ensureStorageDirectory(cwd?: string): Promise<string> {
  const dir = getPlanStorageDirectory(cwd)
  await fs.mkdir(dir, { recursive: true })
  return dir
}

function planFilePath(planDir: string, name: string): string {
  return path.join(planDir, `${normalizeName(name)}${PLAN_FILE_EXTENSION}`)
}

async function existingPlanNames(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir)
    return entries.filter(entry => entry.endsWith(PLAN_FILE_EXTENSION)).map(entry => entry.slice(0, -PLAN_FILE_EXTENSION.length))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

async function generatePlanName(dir: string): Promise<string> {
  const existing = new Set(await existingPlanNames(dir))
  for (let attempt = 0; attempt < MAX_ID_ATTEMPTS; attempt += 1) {
    const candidate = generateCandidateName()
    if (!existing.has(candidate)) return candidate
  }
  throw new Error('Unable to generate a unique plan name after multiple attempts')
}

export async function listPlans(cwd?: string): Promise<PlanInfo[]> {
  const dir = getPlanStorageDirectory(cwd)
  try {
    const entries = await fs.readdir(dir)
    const planFiles = entries.filter(entry => entry.endsWith(PLAN_FILE_EXTENSION))
    const filesWithStats = await Promise.all(
      planFiles.map(async entry => {
        const filePath = path.join(dir, entry)
        const [stats, content] = await Promise.all([fs.stat(filePath), fs.readFile(filePath, 'utf8').catch(() => '')])
        return {
          name: entry.slice(0, -PLAN_FILE_EXTENSION.length),
          modifiedAt: stats.mtime.toISOString(),
          mtime: stats.mtime.getTime(),
          title: firstMarkdownHeading(content),
        }
      })
    )

    return filesWithStats
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, MAX_LIST_RESULTS)
      .map(({ name, modifiedAt, title }) => ({ name, modifiedAt, ...(title ? { title } : {}) }))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

export async function readPlan(name: string, cwd?: string): Promise<ReadPlanResult> {
  const normalized = normalizeName(name)
  const dir = getPlanStorageDirectory(cwd)
  const filePath = planFilePath(dir, normalized)
  try {
    const content = await fs.readFile(filePath, 'utf8')
    return { exists: true, name: normalized, content }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { exists: false, name: normalized, content: null }
    throw error
  }
}

export async function createPlan(content: string, name?: string, cwd?: string): Promise<CreatePlanResult> {
  const dir = await ensureStorageDirectory(cwd)
  const planName = name ? normalizeName(name) : await generatePlanName(dir)
  const filePath = path.join(dir, `${planName}${PLAN_FILE_EXTENSION}`)
  await fs.writeFile(filePath, content, { encoding: 'utf8', flag: 'wx' })
  return { name: planName, created: true, content, path: filePath }
}

export async function editPlan(name: string, search: string, replacement: string, cwd?: string): Promise<EditPlanResult> {
  const normalized = normalizeName(name)
  const dir = getPlanStorageDirectory(cwd)
  const filePath = path.join(dir, `${normalized}${PLAN_FILE_EXTENSION}`)

  try {
    const content = await fs.readFile(filePath, 'utf8')
    const lines = content.split('\n')
    let matchCount = 0
    const newLines = lines.map(line => {
      if (!line.includes(search)) return line
      matchCount += 1
      return replacement
    })

    if (matchCount === 0) {
      return { success: false, message: `No lines found containing "${search}"`, name: normalized, content, path: filePath }
    }

    const newContent = newLines.join('\n')
    await fs.writeFile(filePath, newContent, 'utf8')
    return { success: true, message: `Updated ${matchCount} line(s)`, name: normalized, content: newContent, path: filePath }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { success: false, message: `Plan "${normalized}" does not exist`, name: normalized, content: null }
    }
    throw error
  }
}

export async function displayPlan(name: string, cwd?: string): Promise<DisplayPlanResult> {
  const normalized = normalizeName(name)
  const dir = getPlanStorageDirectory(cwd)
  const filePath = path.join(dir, `${normalized}${PLAN_FILE_EXTENSION}`)
  try {
    const content = await fs.readFile(filePath, 'utf8')
    return {
      displayed: true,
      exists: true,
      name: normalized,
      path: filePath,
      content,
      message: `Displayed plan "${normalized}" in the chat view.`,
      modelContent: `Plan "${normalized}" was displayed to the user in the chat view. Do not repeat the plan unless the user asks.`,
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { displayed: false, exists: false, name: normalized, message: `Plan "${normalized}" does not exist` }
    }
    throw error
  }
}

export async function executePlanMd(args: PlanToolArgs, defaultCwd?: string): Promise<any> {
  const cwd = args.cwd || defaultCwd
  switch (args.action as string) {
    case 'create':
      return await createPlan(args.content ?? '', args.name, cwd)
    case 'list':
      return await listPlans(cwd)
    case 'read':
      if (!args.name) throw new Error('name is required for read action')
      return await readPlan(args.name, cwd)
    case 'edit':
      if (!args.name) throw new Error('name is required for edit action')
      if (args.search === undefined || args.search === '') throw new Error('search is required for edit action')
      if (args.replacement === undefined) throw new Error('replacement is required for edit action')
      return await editPlan(args.name, args.search, args.replacement, cwd)
    case 'display':
      if (!args.name) throw new Error('name is required for display action')
      return await displayPlan(args.name, cwd)
    case 'clarify':
      throw new Error('plan_md clarify must be handled by the renderer so the user can answer interactively')
    default:
      throw new Error(`Unsupported plan_md action: ${String(args.action)}`)
  }
}
