import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../lsp/LspServerRegistry.js', () => ({
  getLspServerDefinition: (id: string) => ({ id }),
  resolveLspCommand: () => ({ command: 'fixture', args: [], source: 'path' }),
  listLspServers: () => [],
}))
vi.mock('../lsp/LspSession.js', () => ({
  LspSession: class {
    sessionKey: string; serverDefinition: any; socket: any
    stop = vi.fn(async () => { this.socket = null })
    constructor(options: any) { this.sessionKey = options.sessionKey; this.serverDefinition = options.serverDefinition }
    async attachSocket(options: any) {
      this.socket = options.socket
      options.socket.once('close', () => { if (this.socket === options.socket) this.socket = null })
    }
    getSummary() { return { sessionKey: this.sessionKey, attached: Boolean(this.socket) } }
  },
}))
import { createLspSessionKey, LspManager } from '../lsp/LspManager.js'

describe('per-client interactive LSP', () => {
  it('isolates same workspace sessions and scopes close/restart to one client', async () => {
    const manager = new LspManager()
    const a = new EventEmitter(); const b = new EventEmitter()
    await manager.attachSocket({ serverId: 'ts', workspacePath: '/project', clientId: 'a', socket: a as any })
    await manager.attachSocket({ serverId: 'ts', workspacePath: '/project', clientId: 'b', socket: b as any })
    const sessionA = manager.ensureSession('ts', '/project', 'a')
    const sessionB = manager.ensureSession('ts', '/project', 'b')
    expect(sessionA).not.toBe(sessionB)
    a.emit('close')
    expect(sessionA.stop).toHaveBeenCalledOnce()
    expect(sessionB.stop).not.toHaveBeenCalled()
    expect(manager.listSessions()).toHaveLength(1)
    await manager.restartSession('ts', '/project', 'b')
    expect(sessionB.stop).toHaveBeenCalledOnce()
    expect(manager.listSessions()).toHaveLength(0)
  })
  it('an old socket closing cannot destroy its replacement', async () => {
    const manager = new LspManager()
    const old = new EventEmitter(); const current = new EventEmitter()
    await manager.attachSocket({ serverId: 'ts', workspacePath: '/project', clientId: 'a', socket: old as any })
    await manager.attachSocket({ serverId: 'ts', workspacePath: '/project', clientId: 'a', socket: current as any })
    old.emit('close')
    expect(manager.listSessions()).toHaveLength(1)
    expect(manager.listSessions()[0].attached).toBe(true)
    current.emit('close')
    expect(manager.listSessions()).toHaveLength(0)
  })
  it('uses unambiguous tuple keys and bounds interactive process ownership', () => {
    expect(createLspSessionKey('a::b', '/p', 'c')).not.toBe(createLspSessionKey('b', '/p', 'c::a'))
    const manager = new LspManager()
    for (let i = 0; i < 32; i++) manager.ensureSession('ts', '/project', String(i))
    expect(() => manager.ensureSession('ts', '/project', 'overflow')).toThrow('limit')
    expect(() => manager.ensureSession('ts', '/project', '0')).not.toThrow()
  })
})
