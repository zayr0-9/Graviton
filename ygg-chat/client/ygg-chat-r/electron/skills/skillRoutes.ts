// electron/skills/skillRoutes.ts
// Express routes for skill management API

import { Express } from 'express'
import { skillRegistry } from './skillLoader.js'
import {
  installFromGitHub,
  installFromLocal,
  installFromUrl,
  installAllFromGitHub,
  fetchSkillsCatalog,
  type InstallResult,
} from './skillInstaller.js'

function installFailureResponse(result: InstallResult) {
  return {
    success: false,
    error: result.error,
    code: result.code,
    candidates: result.candidates,
  }
}

export function registerSkillRoutes(app: Express): void {

  // GET /api/skills - List all installed skills (summaries)
  app.get('/api/skills', async (_req, res) => {
    try {
      await skillRegistry.initialize()
      const skills = skillRegistry.getSummaries()
      res.json({
        success: true,
        skills,
        totalCount: skills.length,
        skillsDirectory: skillRegistry.getSkillsDirectory(),
      })
    } catch (error) {
      console.error('[SkillRoutes] Error listing skills:', error)
      res.status(500).json({ success: false, error: 'Failed to list skills' })
    }
  })

  // GET /api/skills/catalog - Fetch available skills from anthropics/skills
  app.get('/api/skills/catalog', async (_req, res) => {
    try {
      const catalog = await fetchSkillsCatalog()
      res.json({ success: true, skills: catalog })
    } catch (error) {
      console.error('[SkillRoutes] Error fetching catalog:', error)
      res.status(500).json({ success: false, error: 'Failed to fetch skills catalog' })
    }
  })

  // GET /api/skills/:name - Get full skill content (for activation)
  app.get('/api/skills/:name', async (req, res) => {
    try {
      await skillRegistry.initialize()
      const skill = skillRegistry.getSkill(req.params.name)

      if (!skill) {
        res.status(404).json({ success: false, error: 'Skill not found' })
        return
      }

      res.json({ success: true, skill })
    } catch (error) {
      console.error('[SkillRoutes] Error getting skill:', error)
      res.status(500).json({ success: false, error: 'Failed to get skill' })
    }
  })

  // GET /api/skills/:name/resource - Load a resource file from skill
  app.get('/api/skills/:name/resource', async (req, res) => {
    try {
      await skillRegistry.initialize()
      const resourcePath = req.query.path as string

      if (!resourcePath) {
        res.status(400).json({ success: false, error: 'Missing "path" query parameter' })
        return
      }

      const resource = await skillRegistry.loadResource(req.params.name, resourcePath)

      if (!resource) {
        res.status(404).json({ success: false, error: 'Resource not found' })
        return
      }

      res.json({ success: true, resource })
    } catch (error) {
      console.error('[SkillRoutes] Error loading resource:', error)
      res.status(500).json({ success: false, error: 'Failed to load resource' })
    }
  })

  // POST /api/skills/:name/enable - Enable a skill
  app.post('/api/skills/:name/enable', async (req, res) => {
    try {
      await skillRegistry.initialize()
      const success = await skillRegistry.setSkillEnabled(req.params.name, true)

      if (!success) {
        res.status(404).json({ success: false, error: 'Skill not found' })
        return
      }

      res.json({ success: true })
    } catch (error) {
      console.error('[SkillRoutes] Error enabling skill:', error)
      res.status(500).json({ success: false, error: 'Failed to enable skill' })
    }
  })

  // POST /api/skills/:name/disable - Disable a skill
  app.post('/api/skills/:name/disable', async (req, res) => {
    try {
      await skillRegistry.initialize()
      const success = await skillRegistry.setSkillEnabled(req.params.name, false)

      if (!success) {
        res.status(404).json({ success: false, error: 'Skill not found' })
        return
      }

      res.json({ success: true })
    } catch (error) {
      console.error('[SkillRoutes] Error disabling skill:', error)
      res.status(500).json({ success: false, error: 'Failed to disable skill' })
    }
  })

  // POST /api/skills/install/github - Install from GitHub
  app.post('/api/skills/install/github', async (req, res) => {
    try {
      const { source } = req.body

      if (!source || typeof source !== 'string') {
        res.status(400).json({ success: false, error: 'Missing "source" in request body' })
        return
      }

      const result = await installFromGitHub(source)

      if (result.success) {
        res.json({ success: true, skillName: result.skillName, displayName: result.displayName })
      } else {
        res.status(400).json(installFailureResponse(result))
      }
    } catch (error) {
      console.error('[SkillRoutes] Error installing from GitHub:', error)
      res.status(500).json({ success: false, error: 'Failed to install skill' })
    }
  })

  // POST /api/skills/install/github/all - Install all skills from a multi-skill GitHub repo/folder
  app.post('/api/skills/install/github/all', async (req, res) => {
    try {
      const { source } = req.body

      if (!source || typeof source !== 'string') {
        res.status(400).json({ success: false, error: 'Missing "source" in request body' })
        return
      }

      const result = await installAllFromGitHub(source)

      if (result.success) {
        res.json({
          success: true,
          skillName: result.skillName,
          skillNames: result.skillNames,
          displayName: result.displayName,
          displayNames: result.displayNames,
        })
      } else {
        res.status(400).json(installFailureResponse(result))
      }
    } catch (error) {
      console.error('[SkillRoutes] Error installing all from GitHub:', error)
      res.status(500).json({ success: false, error: 'Failed to install skills' })
    }
  })

  // POST /api/skills/install/local - Install from local folder
  app.post('/api/skills/install/local', async (req, res) => {
    try {
      const { path: sourcePath } = req.body

      if (!sourcePath || typeof sourcePath !== 'string') {
        res.status(400).json({ success: false, error: 'Missing "path" in request body' })
        return
      }

      const result = await installFromLocal(sourcePath)

      if (result.success) {
        res.json({ success: true, skillName: result.skillName, displayName: result.displayName })
      } else {
        res.status(400).json(installFailureResponse(result))
      }
    } catch (error) {
      console.error('[SkillRoutes] Error installing from local:', error)
      res.status(500).json({ success: false, error: 'Failed to install skill' })
    }
  })

  // POST /api/skills/install/url - Install from any URL (ClawdHub, GitHub, or direct zip)
  app.post('/api/skills/install/url', async (req, res) => {
    try {
      const { url } = req.body

      if (!url || typeof url !== 'string') {
        res.status(400).json({ success: false, error: 'Missing "url" in request body' })
        return
      }

      const result = await installFromUrl(url)

      if (result.success) {
        res.json({
          success: true,
          skillName: result.skillName,
          skillNames: result.skillNames,
          displayName: result.displayName,
          displayNames: result.displayNames,
        })
      } else {
        res.status(400).json(installFailureResponse(result))
      }
    } catch (error) {
      console.error('[SkillRoutes] Error installing from URL:', error)
      res.status(500).json({ success: false, error: 'Failed to install skill' })
    }
  })

  // DELETE /api/skills/:name - Uninstall a skill
  app.delete('/api/skills/:name', async (req, res) => {
    try {
      await skillRegistry.initialize()
      const success = await skillRegistry.uninstallSkill(req.params.name)

      if (!success) {
        res.status(404).json({ success: false, error: 'Skill not found' })
        return
      }

      res.json({ success: true })
    } catch (error) {
      console.error('[SkillRoutes] Error uninstalling skill:', error)
      res.status(500).json({ success: false, error: 'Failed to uninstall skill' })
    }
  })

  // POST /api/skills/reload - Reload all skills
  app.post('/api/skills/reload', async (_req, res) => {
    try {
      await skillRegistry.reload()
      const skills = skillRegistry.getSummaries()
      res.json({ success: true, skills, totalCount: skills.length })
    } catch (error) {
      console.error('[SkillRoutes] Error reloading skills:', error)
      res.status(500).json({ success: false, error: 'Failed to reload skills' })
    }
  })

  console.log('[SkillRoutes] Registered skill routes')
}
