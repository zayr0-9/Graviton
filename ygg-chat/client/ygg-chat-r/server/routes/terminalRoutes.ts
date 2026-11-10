import type { Express } from 'express'
import { hostClientPolicy } from './hostClientPolicy.js'
import { TerminalService } from '../terminal/terminalService.js'

export function registerTerminalRoutes(app: Express, service: TerminalService): void {
  app.use('/api/terminal', hostClientPolicy)
  app.post('/api/terminal/create', async (req, res) => {
    const { clientId, requestId, cwd, cols, rows, title } = req.body ?? {}
    if (typeof clientId !== 'string' || !clientId || clientId.length > 128 || typeof requestId !== 'string' || !requestId || requestId.length > 128 || typeof cwd !== 'string' || cwd.length > 4096) {
      res.status(400).json({ success: false, error: 'Valid clientId, requestId and host cwd required' }); return
    }
    try { res.json(await service.create(clientId, requestId, { cwd, cols, rows, title })) }
    catch (error) { res.status(409).json({ success: false, error: error instanceof Error ? error.message : 'Terminal unavailable' }) }
  })
  app.get('/api/terminal/:id', (req, res) => {
    try {
      const after = Number(req.query.after ?? 0)
      if (!Number.isSafeInteger(after) || after < 0) throw new Error('Invalid terminal cursor')
      res.json(service.read(String(req.query.clientId ?? ''), String(req.params.id), after))
    } catch (error) { res.status(404).json({ success: false, error: error instanceof Error ? error.message : 'Terminal unavailable' }) }
  })
  app.post('/api/terminal/:id/:action', (req, res) => {
    const { clientId, data, cols, rows } = req.body ?? {}
    if (typeof clientId !== 'string' || !clientId || clientId.length > 128) { res.status(400).json({ success: false, error: 'Client ID required' }); return }
    try {
      const id = String(req.params.id)
      if (req.params.action === 'write') {
        if (typeof data !== 'string' || Buffer.byteLength(data) > 65536) throw new Error('Terminal input exceeds limit')
        service.write(clientId, id, data)
      } else if (req.params.action === 'resize') service.resize(clientId, id, cols, rows)
      else if (req.params.action === 'kill') service.kill(clientId, id)
      else { res.status(404).json({ success: false, error: 'Unknown terminal command' }); return }
      res.json({ success: true })
    } catch (error) { res.status(409).json({ success: false, error: error instanceof Error ? error.message : 'Terminal command failed' }) }
  })
}
