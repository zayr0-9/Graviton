import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { Buffer } from 'buffer'
import path from 'path'
import { WebSocket, type RawData } from 'ws'
import type { LspServerDefinition, LspSessionAttachOptions, LspSessionStatus, LspSessionSummary, ResolvedLspCommand } from './types.js'

const STDERR_TAIL_LIMIT = 50

function toUtf8String(data: RawData): string {
  if (typeof data === 'string') return data
  if (Buffer.isBuffer(data)) return data.toString('utf8')
  if (Array.isArray(data)) {
    return Buffer.concat(data.map(chunk => (Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))).toString('utf8')
  }
  return Buffer.from(data).toString('utf8')
}

function frameJsonRpcMessage(jsonPayload: string): Buffer {
  const body = Buffer.from(jsonPayload, 'utf8')
  const header = Buffer.from(`Content-Length: ${body.byteLength}\r\n\r\n`, 'utf8')
  return Buffer.concat([header, body])
}

function shouldSpawnWithShell(command: string): boolean {
  if (process.platform !== 'win32') return false
  const extension = path.extname(command).toLowerCase()
  return extension === '.cmd' || extension === '.bat'
}

export class LspSession {
  readonly sessionKey: string
  readonly serverDefinition: LspServerDefinition
  readonly workspacePath: string
  readonly workspaceUri: string
  readonly resolvedCommand: ResolvedLspCommand

  private childProcess: ChildProcessWithoutNullStreams | null = null
  private startPromise: Promise<void> | null = null
  private stdoutBuffer = Buffer.alloc(0)
  private attachedSocket: WebSocket | null = null
  private attachedClientId: string | null = null
  private stderrTail: string[] = []
  private lastError: string | null = null
  private status: LspSessionStatus = 'idle'
  private lastActivityAt: string | null = null
  private startedAt: string | null = null
  private restartCount = 0

  constructor(params: {
    sessionKey: string
    serverDefinition: LspServerDefinition
    workspacePath: string
    workspaceUri: string
    resolvedCommand: ResolvedLspCommand
  }) {
    this.sessionKey = params.sessionKey
    this.serverDefinition = params.serverDefinition
    this.workspacePath = params.workspacePath
    this.workspaceUri = params.workspaceUri
    this.resolvedCommand = params.resolvedCommand
  }

  private markActivity(): void {
    this.lastActivityAt = new Date().toISOString()
  }

  private pushStderrLine(line: string): void {
    const trimmed = String(line || '').trim()
    if (!trimmed) return
    this.stderrTail.push(trimmed)
    if (this.stderrTail.length > STDERR_TAIL_LIMIT) {
      this.stderrTail.splice(0, this.stderrTail.length - STDERR_TAIL_LIMIT)
    }
  }

  private closeAttachedSocket(code = 1011, reason = 'LSP session terminated'): void {
    if (!this.attachedSocket) return
    try {
      if (this.attachedSocket.readyState === WebSocket.OPEN || this.attachedSocket.readyState === WebSocket.CONNECTING) {
        this.attachedSocket.close(code, reason)
      }
    } catch {
      // Ignore socket close errors.
    }
  }

  private forwardServerMessageToSocket(payload: string): void {
    this.markActivity()
    if (!this.attachedSocket || this.attachedSocket.readyState !== WebSocket.OPEN) return
    this.attachedSocket.send(payload)
  }

  private handleServerStdoutChunk(chunk: Buffer): void {
    this.stdoutBuffer = Buffer.concat([this.stdoutBuffer, chunk])

    while (this.stdoutBuffer.length > 0) {
      const headerEndIndex = this.stdoutBuffer.indexOf('\r\n\r\n')
      if (headerEndIndex === -1) {
        return
      }

      const headerText = this.stdoutBuffer.subarray(0, headerEndIndex).toString('utf8')
      const contentLengthMatch = /Content-Length:\s*(\d+)/i.exec(headerText)
      if (!contentLengthMatch) {
        this.stdoutBuffer = this.stdoutBuffer.subarray(headerEndIndex + 4)
        continue
      }

      const contentLength = Number(contentLengthMatch[1])
      const totalFrameLength = headerEndIndex + 4 + contentLength
      if (this.stdoutBuffer.length < totalFrameLength) {
        return
      }

      const messageBuffer = this.stdoutBuffer.subarray(headerEndIndex + 4, totalFrameLength)
      this.stdoutBuffer = this.stdoutBuffer.subarray(totalFrameLength)
      this.forwardServerMessageToSocket(messageBuffer.toString('utf8'))
    }
  }

  private attachSocketListeners(socket: WebSocket, clientId: string | null): void {
    socket.on('message', data => {
      this.markActivity()
      const jsonPayload = toUtf8String(data)
      if (!jsonPayload.trim()) return
      if (!this.childProcess || this.childProcess.stdin.destroyed) return
      this.childProcess.stdin.write(frameJsonRpcMessage(jsonPayload))
    })

    socket.on('close', () => {
      if (this.attachedSocket === socket) {
        this.attachedSocket = null
        this.attachedClientId = null
      }
    })

    socket.on('error', error => {
      this.lastError = error instanceof Error ? error.message : String(error)
      if (this.attachedSocket === socket) {
        this.attachedSocket = null
        this.attachedClientId = null
      }
    })

    this.attachedSocket = socket
    this.attachedClientId = clientId
  }

  async start(): Promise<void> {
    if (this.childProcess && this.status === 'running') return
    if (this.startPromise) return this.startPromise

    this.status = 'starting'
    this.lastError = null
    this.stdoutBuffer = Buffer.alloc(0)

    this.startPromise = new Promise<void>((resolve, reject) => {
      const child = spawn(this.resolvedCommand.command, this.resolvedCommand.args, {
        cwd: this.workspacePath,
        env: {
          ...process.env,
          ...(this.serverDefinition.env || {}),
        },
        stdio: 'pipe',
        windowsHide: true,
        shell: shouldSpawnWithShell(this.resolvedCommand.command),
      })

      this.childProcess = child

      let settled = false

      child.once('spawn', () => {
        this.startedAt = new Date().toISOString()
        this.markActivity()
        this.status = 'running'
        settled = true
        resolve()
      })

      child.stdout.on('data', chunk => {
        this.handleServerStdoutChunk(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      })

      child.stderr.on('data', chunk => {
        const line = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)
        line
          .split(/\r?\n/)
          .map(part => part.trim())
          .filter(Boolean)
          .forEach(part => this.pushStderrLine(part))
      })

      child.once('error', error => {
        this.lastError = error instanceof Error ? error.message : String(error)
        this.status = 'error'
        this.childProcess = null
        this.startPromise = null
        this.closeAttachedSocket(1011, 'LSP process failed to start')
        if (!settled) {
          reject(error)
        }
      })

      child.once('exit', (code, signal) => {
        this.lastError = code === 0 || code === null ? this.lastError : `LSP process exited with code ${code}${signal ? ` (${signal})` : ''}`
        this.status = this.lastError ? 'error' : 'stopped'
        this.childProcess = null
        this.startPromise = null
        this.closeAttachedSocket(1011, 'LSP process exited')
        if (!settled) {
          reject(new Error(this.lastError || 'LSP process exited before startup completed'))
        }
      })
    })

    try {
      await this.startPromise
    } finally {
      if (this.status !== 'starting') {
        this.startPromise = null
      }
    }
  }

  async attachSocket(options: LspSessionAttachOptions): Promise<void> {
    await this.start()

    if (this.attachedSocket && this.attachedSocket !== options.socket) {
      this.closeAttachedSocket(1012, 'Replaced by a newer LSP client connection')
      this.attachedSocket = null
      this.attachedClientId = null
    }

    this.attachSocketListeners(options.socket, options.clientId || null)
  }

  async restart(): Promise<void> {
    this.restartCount += 1
    await this.stop(false)
    await this.start()
  }

  async stop(closeSocket = true): Promise<void> {
    this.startPromise = null
    this.stdoutBuffer = Buffer.alloc(0)

    if (closeSocket) {
      this.closeAttachedSocket(1001, 'LSP session stopped')
      this.attachedSocket = null
      this.attachedClientId = null
    }

    if (!this.childProcess) {
      this.status = 'stopped'
      return
    }

    const child = this.childProcess
    this.childProcess = null

    await new Promise<void>(resolve => {
      const timeoutId = setTimeout(() => {
        try {
          child.kill('SIGKILL')
        } catch {
          // Ignore forced termination errors.
        }
        resolve()
      }, 1500)

      child.once('exit', () => {
        clearTimeout(timeoutId)
        resolve()
      })

      try {
        child.kill('SIGTERM')
      } catch {
        clearTimeout(timeoutId)
        resolve()
      }
    })

    this.status = 'stopped'
  }

  getSummary(): LspSessionSummary {
    return {
      sessionKey: this.sessionKey,
      serverId: this.serverDefinition.id,
      workspacePath: this.workspacePath,
      workspaceUri: this.workspaceUri,
      status: this.status,
      pid: this.childProcess?.pid ?? null,
      command: this.resolvedCommand.command,
      commandSource: this.resolvedCommand.source,
      args: [...this.resolvedCommand.args],
      attachedClientId: this.attachedClientId,
      attached: Boolean(this.attachedSocket && this.attachedSocket.readyState === WebSocket.OPEN),
      lastActivityAt: this.lastActivityAt,
      startedAt: this.startedAt,
      lastError: this.lastError,
      restartCount: this.restartCount,
      stderrTail: [...this.stderrTail],
    }
  }
}
