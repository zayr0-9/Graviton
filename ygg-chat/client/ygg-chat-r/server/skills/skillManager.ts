// server/skills/skillManager.ts
// Built-in tool for the AI to discover and activate skills.
//
// Two sources (docs/claude_code_context_loading_rules.md §5.1):
//   - the running conversation's ConversationContextLoader (personal `~/<readDir>/skills`,
//     project `<root>/<readDir>/skills`, legacy commands, nested skills), when the chat
//     has a root path; bodies are rendered through the §5.5 substitution pipeline;
//   - the host-installed registry (`<dataDir>/skills`, Settings UI installs) as fallback.

import fs from 'fs/promises'
import path from 'path'
import { getConversationContext } from '../context/contextSessionRegistry.js'
import type { DiscoveredSkill } from '../context/skillsDiscovery.js'
import { skillRegistry, SkillSummary } from './skillLoader.js'

interface SkillManagerArgs {
  action: 'list' | 'activate' | 'load_resource'
  name?: string // For 'activate' and 'load_resource'
  resourcePath?: string // For 'load_resource' (e.g., "references/FORMS.md")
  /** Raw argument string for 'activate' ($ARGUMENTS, $0, $1, named arguments). */
  arguments?: string
}

export interface SkillManagerExecutionOptions {
  rootPath?: string | null
  conversationId?: string | null
}

interface SkillManagerResult {
  success: boolean
  error?: string

  // For 'list' action
  skills?: Array<SkillSummary & { scope?: string; argumentHint?: string }>
  totalCount?: number

  // For 'activate' action
  skill?: {
    name: string
    displayName?: string
    description: string
    instructions: string // The bodyContent from SKILL.md (rendered)
    hasScripts: boolean
    hasReferences: boolean
    hasAssets: boolean
    scope?: string
    sourcePath?: string
  }

  // For 'load_resource' action
  resource?: {
    path: string
    content: string
    type: 'script' | 'reference' | 'asset'
  }
}

async function directoryExists(dirPath: string): Promise<boolean> {
  try {
    return (await fs.stat(dirPath)).isDirectory()
  } catch {
    return false
  }
}

async function loadResourceFromDirectory(skillDir: string, resourcePath: string): Promise<SkillManagerResult['resource'] | null> {
  const normalizedPath = path.normalize(resourcePath)
  if (normalizedPath.startsWith('..') || path.isAbsolute(normalizedPath)) return null
  const fullPath = path.join(skillDir, normalizedPath)
  if (!fullPath.startsWith(skillDir)) return null
  try {
    const content = await fs.readFile(fullPath, 'utf-8')
    let type: 'script' | 'reference' | 'asset' = 'asset'
    if (normalizedPath.startsWith('scripts/')) type = 'script'
    else if (normalizedPath.startsWith('references/')) type = 'reference'
    return { path: resourcePath, content, type }
  } catch {
    return null
  }
}

function summarizeDiscovered(skill: DiscoveredSkill): SkillSummary & { scope?: string; argumentHint?: string } {
  return {
    name: skill.name,
    displayName: skill.frontmatter.name !== skill.name ? skill.frontmatter.name : undefined,
    description: skill.frontmatter.description,
    enabled: true,
    scope: skill.scope,
    argumentHint: skill.frontmatter.argumentHint,
  }
}

/**
 * Execute the skill_manager tool
 * This is called by the AI to discover and activate skills
 */
export async function execute(args: SkillManagerArgs, options: SkillManagerExecutionOptions = {}): Promise<SkillManagerResult> {
  const { action, name, resourcePath } = args
  const loader = getConversationContext(options.conversationId)

  // Ensure registry is initialized
  await skillRegistry.initialize()

  if (action === 'list') {
    const listed = new Map<string, SkillSummary & { scope?: string; argumentHint?: string }>()
    if (loader) {
      for (const skill of await loader.getSkills()) {
        // §5.2 invocation matrix: `disable-model-invocation` hides the skill from the model.
        if (skill.shadowed || skill.frontmatter.disableModelInvocation) continue
        listed.set(skill.name, summarizeDiscovered(skill))
      }
    }
    for (const summary of skillRegistry.getSummaries().filter(s => s.enabled)) {
      if (!listed.has(summary.name)) listed.set(summary.name, { ...summary, scope: 'personal' })
    }
    const skills = Array.from(listed.values())
    return { success: true, skills, totalCount: skills.length }
  }

  if (action === 'activate') {
    if (!name) {
      return { success: false, error: 'Missing "name" parameter for activate action' }
    }

    if (loader) {
      const discovered = await loader.findSkill(name)
      if (discovered) {
        if (discovered.frontmatter.disableModelInvocation) {
          return { success: false, error: `Skill "${name}" can only be invoked by the user` }
        }
        const rendered = loader.renderSkillEntry(discovered, args.arguments ?? null, `skill ${discovered.name} instructions`)
        return {
          success: true,
          skill: {
            name: discovered.name,
            displayName: discovered.frontmatter.name !== discovered.name ? discovered.frontmatter.name : undefined,
            description: discovered.frontmatter.description,
            instructions: rendered.text,
            hasScripts: await directoryExists(path.join(discovered.skillDir, 'scripts')),
            hasReferences: await directoryExists(path.join(discovered.skillDir, 'references')),
            hasAssets: await directoryExists(path.join(discovered.skillDir, 'assets')),
            scope: discovered.scope,
            sourcePath: discovered.realPath,
          },
        }
      }
    }

    const skill = skillRegistry.getSkill(name)
    if (!skill) {
      return { success: false, error: `Skill "${name}" not found` }
    }

    if (!skill.enabled) {
      return { success: false, error: `Skill "${name}" is disabled` }
    }

    return {
      success: true,
      skill: {
        name: skill.name,
        displayName: skill.displayName,
        description: skill.description,
        instructions: skill.bodyContent,
        hasScripts: skill.hasScripts,
        hasReferences: skill.hasReferences,
        hasAssets: skill.hasAssets,
        scope: 'personal',
        sourcePath: path.join(skill.sourcePath, 'SKILL.md'),
      },
    }
  }

  if (action === 'load_resource') {
    if (!name) {
      return { success: false, error: 'Missing "name" parameter for load_resource action' }
    }
    if (!resourcePath) {
      return { success: false, error: 'Missing "resourcePath" parameter for load_resource action' }
    }

    if (loader) {
      const discovered = await loader.findSkill(name)
      if (discovered) {
        const resource = await loadResourceFromDirectory(discovered.skillDir, resourcePath)
        if (!resource) {
          return { success: false, error: `Resource "${resourcePath}" not found in skill "${name}"` }
        }
        return { success: true, resource }
      }
    }

    const resource = await skillRegistry.loadResource(name, resourcePath)
    if (!resource) {
      return { success: false, error: `Resource "${resourcePath}" not found in skill "${name}"` }
    }

    return {
      success: true,
      resource,
    }
  }

  return { success: false, error: `Unknown action: ${action}` }
}

/**
 * Get the tool definition for skill_manager
 * This should be added to your toolDefinitions
 */
export const skillManagerDefinition = {
  name: 'skill_manager',
  description: `Discover and activate specialized skills that provide detailed instructions for specific tasks.

Use this tool to:
1. List available skills with action: "list"
2. Activate a skill to load its instructions with action: "activate" and name: "skill-name" (optional "arguments" string)
3. Load additional resources (scripts, references, assets) with action: "load_resource"

Skills are context injections - they provide detailed instructions that you should follow.
After activating a skill, incorporate its instructions into your approach for the current task.`,
  inputSchema: {
    type: 'object' as const,
    properties: {
      action: {
        type: 'string',
        enum: ['list', 'activate', 'load_resource'],
        description: 'The action to perform',
      },
      name: {
        type: 'string',
        description: 'Skill name (required for activate and load_resource)',
      },
      resourcePath: {
        type: 'string',
        description: 'Path to resource file within the skill (e.g., "references/FORMS.md")',
      },
      arguments: {
        type: 'string',
        description: 'Optional argument string for activate; substituted into the skill body ($ARGUMENTS, $0, $1, named arguments).',
      },
    },
    required: ['action'],
  },
}
