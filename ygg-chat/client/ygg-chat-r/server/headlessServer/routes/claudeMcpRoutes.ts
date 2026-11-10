import type { Express, Response } from 'express'
import { ClaudeMcpControlError, type ClaudeMcpControlService } from '../services/claudeMcpControl.js'

function fail(res: Response, error: unknown) {
  if (error instanceof ClaudeMcpControlError) {
    res.status(error.status).json({ error: error.message, code: error.code })
    return
  }
  res.status(502).json({ error: error instanceof Error ? error.message : 'Claude Code did not answer.', code: 'claude_mcp_failed' })
}

/**
 * Claude Code's own MCP servers, for the Settings panel. Server names travel in the JSON body:
 * they contain spaces, dots and parentheses ("claude.ai Vega GP (UAT env)").
 */
export function registerClaudeMcpRoutes(app: Express, deps: { control: ClaudeMcpControlService }): void {
  const { control } = deps
  app.get('/api/headless/claude/mcp/status', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    try { res.json(await control.status(req.query.cwd)) }
    catch (error) { fail(res, error) }
  })
  app.post('/api/headless/claude/mcp/sign-in', async (req, res) => {
    try { res.json(await control.signIn(req.body?.name, req.body?.cwd)) }
    catch (error) { fail(res, error) }
  })
  app.post('/api/headless/claude/mcp/sign-in/callback', async (req, res) => {
    try { await control.submitCallback(req.body?.name, req.body?.callbackUrl); res.json({ success: true }) }
    catch (error) { fail(res, error) }
  })
  app.post('/api/headless/claude/mcp/reconnect', async (req, res) => {
    try { res.json({ server: await control.reconnect(req.body?.name, req.body?.cwd) }) }
    catch (error) { fail(res, error) }
  })
  app.post('/api/headless/claude/mcp/sign-out', async (req, res) => {
    try { await control.signOut(req.body?.name, req.body?.cwd); res.json({ success: true }) }
    catch (error) { fail(res, error) }
  })
}
