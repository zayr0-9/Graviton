import yaml from 'yaml'

const FRONTMATTER_REGEX = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/
const VALID_SKILL_NAME_REGEX = /^[a-z](?:[a-z0-9-]*[a-z0-9])?$/

export interface ParsedSkillManifest {
  name: string
  runtimeName: string
  description: string
  frontmatter: Record<string, unknown>
  bodyContent: string
}

export function normalizeSkillName(name: string): string {
  const normalized = name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

  if (!normalized || !VALID_SKILL_NAME_REGEX.test(normalized)) {
    throw new Error(`Skill name "${name}" cannot be converted to a valid lowercase kebab-case name`)
  }

  return normalized
}

export function parseSkillManifest(content: string): ParsedSkillManifest {
  const match = content.match(FRONTMATTER_REGEX)
  if (!match) {
    throw new Error('SKILL.md missing YAML frontmatter')
  }

  let frontmatter: unknown
  try {
    frontmatter = yaml.parse(match[1])
  } catch (error) {
    throw new Error(`SKILL.md has invalid YAML frontmatter: ${error instanceof Error ? error.message : String(error)}`)
  }

  if (!frontmatter || typeof frontmatter !== 'object' || Array.isArray(frontmatter)) {
    throw new Error('SKILL.md frontmatter must be a YAML object')
  }

  const values = frontmatter as Record<string, unknown>
  if (typeof values.name !== 'string' || !values.name.trim()) {
    throw new Error('SKILL.md missing required "name" field')
  }
  if (typeof values.description !== 'string' || !values.description.trim()) {
    throw new Error('SKILL.md missing required "description" field')
  }

  const name = values.name.trim()
  return {
    name,
    runtimeName: normalizeSkillName(name),
    description: values.description.trim(),
    frontmatter: values,
    bodyContent: match[2].trim(),
  }
}

export function serializeSkillManifest(manifest: ParsedSkillManifest, runtimeName = manifest.runtimeName): string {
  const frontmatter = {
    ...manifest.frontmatter,
    name: runtimeName,
  }
  const body = manifest.bodyContent ? `\n${manifest.bodyContent}\n` : '\n'
  return `---\n${yaml.stringify(frontmatter).trimEnd()}\n---${body}`
}

export function isValidSkillName(name: string): boolean {
  return VALID_SKILL_NAME_REGEX.test(name)
}
