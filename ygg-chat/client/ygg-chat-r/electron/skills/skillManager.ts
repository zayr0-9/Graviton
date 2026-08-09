// electron/skills/skillManager.ts
// Built-in tool for the AI to discover and activate skills

import { skillRegistry, SkillSummary } from './skillLoader.js'

interface SkillManagerArgs {
  action: 'list' | 'activate' | 'load_resource'
  name?: string           // For 'activate' and 'load_resource'
  resourcePath?: string   // For 'load_resource' (e.g., "references/FORMS.md")
}

interface SkillManagerResult {
  success: boolean
  error?: string

  // For 'list' action
  skills?: SkillSummary[]
  totalCount?: number

  // For 'activate' action
  skill?: {
    name: string
    displayName?: string
    description: string
    instructions: string      // The bodyContent from SKILL.md
    hasScripts: boolean
    hasReferences: boolean
    hasAssets: boolean
  }

  // For 'load_resource' action
  resource?: {
    path: string
    content: string
    type: 'script' | 'reference' | 'asset'
  }
}

/**
 * Execute the skill_manager tool
 * This is called by the AI to discover and activate skills
 */
export async function execute(args: SkillManagerArgs): Promise<SkillManagerResult> {
  const { action, name, resourcePath } = args

  // Ensure registry is initialized
  await skillRegistry.initialize()

  if (action === 'list') {
    const skills = skillRegistry.getSummaries()
      .filter(s => s.enabled)  // Only show enabled skills to AI

    return {
      success: true,
      skills,
      totalCount: skills.length,
    }
  }

  if (action === 'activate') {
    if (!name) {
      return { success: false, error: 'Missing "name" parameter for activate action' }
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
2. Activate a skill to load its instructions with action: "activate" and name: "skill-name"
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
    },
    required: ['action'],
  },
}
