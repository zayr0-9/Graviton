import { randomUUID } from 'node:crypto'
import { readdirSync, mkdirSync, mkdtempSync, appendFileSync, writeFileSync, openSync, readSync, closeSync, statSync, unlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SnapshotPayloadReference } from '../../../../../shared/snapshotPayload.js'

const PART_BYTES = 192 * 1024
const MAX_BYTES = 512 * 1024 * 1024
const LEASE_MS = 120_000
const stores = new Set<SnapshotPayloadStore>()
let scratchReaper: ReturnType<typeof setInterval> | undefined
function startScratchReaper(): void {
  if (scratchReaper) return
  scratchReaper = setInterval(() => { for (const store of stores) store.reap() }, 30000)
  scratchReaper.unref?.()
}
let totalBytes = 0
let scratchRoot: string | undefined
export function configureSnapshotScratch(root: string): void {
  scratchRoot = root
  mkdirSync(root, { recursive: true, mode: 0o700 })
  // Do not sweep another live host's scratch. Only our exact PID-prefixed
  // directories whose owner is confirmed absent are crash leftovers.
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const match = /^graviton-snapshot-(\d+)-/.exec(entry.name)
    if (!entry.isDirectory() || !match) continue
    try { process.kill(Number(match[1]), 0) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') rmSync(join(root, entry.name), { recursive: true, force: true }) }
  }
}
export function disposeSnapshotScratch(): void {
  clearInterval(scratchReaper); scratchReaper = undefined
  for (const store of [...stores]) store.dispose()
}

/** Per-session identities with one process-wide byte budget. Frozen references
 * lease an append-only prefix, so ten observers do not copy ten entire turns. */
export class SnapshotPayloadStore {
  private directory: string | undefined
  private files = new Map<string, { path: string; bytes: number; active: boolean }>()
  private leases = new Map<string, { journal: string; bytes: number; expires: number; deadline: number }>()
  private bytes = 0
  private lastReap = 0
  constructor(private maxBytes = MAX_BYTES, private leaseMs = LEASE_MS) { stores.add(this); startScratchReaper() }
  private path(id: string): string {
    const root = scratchRoot ?? tmpdir()
    mkdirSync(root, { recursive: true, mode: 0o700 })
    this.directory ??= mkdtempSync(join(root, `graviton-snapshot-${process.pid}-`))
    return join(this.directory, id)
  }
  private reserve(bytes: number): void {
    if (Date.now() - this.lastReap > 1000) for (const store of stores) store.reap()
    if (this.bytes + bytes > this.maxBytes || totalBytes + bytes > MAX_BYTES) throw new Error('Snapshot scratch capacity reached; retry after old snapshots expire')
  }
  createJournal(): string {
    stores.add(this)
    const id = randomUUID()
    const path = this.path(id)
    writeFileSync(path, '', { mode: 0o600, flag: 'wx' })
    this.files.set(id, { path, bytes: 0, active: true })
    return id
  }
  append(id: string, line: string): void {
    const file = this.files.get(id)
    if (!file?.active) throw new Error('Invalid snapshot journal')
    const bytes = Buffer.byteLength(line)
    this.reserve(bytes)
    appendFileSync(file.path, line)
    file.bytes += bytes; this.bytes += bytes; totalBytes += bytes
  }
  freeze(id: string, reader = true): SnapshotPayloadReference {
    this.reap()
    const source = this.files.get(id)
    if (!source) throw new Error('Snapshot journal no longer available')
    const sharedLease = [...this.leases].find(([, lease]) => lease.journal === id && lease.bytes === source.bytes)
    if (sharedLease) {
      sharedLease[1].expires = Math.min(sharedLease[1].deadline, Date.now() + this.leaseMs)
      return { id: sharedLease[0], bytes: source.bytes, partBytes: PART_BYTES, parts: Math.ceil(source.bytes / PART_BYTES), encoding: 'json-lines' }
    }
    if (this.leases.size >= (reader ? 2048 : 1792)) throw new Error('Snapshot reader capacity reached')
    const immutableId = randomUUID()
    this.leases.set(immutableId, { journal: id, bytes: source.bytes, expires: Date.now() + this.leaseMs, deadline: Date.now() + 10 * this.leaseMs })
    return { id: immutableId, bytes: source.bytes, partBytes: PART_BYTES, parts: Math.ceil(source.bytes / PART_BYTES), encoding: 'json-lines' }
  }
  capture(value: unknown, reader = true): SnapshotPayloadReference {
    const id = this.createJournal()
    try { this.append(id, JSON.stringify(value) + '\n'); return this.freeze(id, reader) }
    finally { this.remove(id) }
  }
  readPart(id: string, part: number): Buffer | undefined {
    this.reap()
    const lease = this.leases.get(id)
    const file = lease && this.files.get(lease.journal)
    if (!lease || !file || !Number.isSafeInteger(part) || part < 0 || part * PART_BYTES >= lease.bytes) return undefined
    const size = Math.min(PART_BYTES, lease.bytes - part * PART_BYTES)
    const output = Buffer.allocUnsafe(size)
    const fd = openSync(file.path, 'r')
    try {
      if (statSync(file.path).size < lease.bytes || readSync(fd, output, 0, size, part * PART_BYTES) !== size) throw new Error('Incomplete snapshot payload')
    } finally { closeSync(fd) }
    lease.expires = Math.min(lease.deadline, Date.now() + this.leaseMs)
    return output
  }
  remove(id: string): void {
    const file = this.files.get(id)
    if (!file) return
    file.active = false
    this.collect(id)
  }
  private collect(id: string): void {
    const file = this.files.get(id)
    if (!file || file.active || [...this.leases.values()].some(lease => lease.journal === id)) return
    unlinkSync(file.path)
    this.files.delete(id); this.bytes -= file.bytes; totalBytes -= file.bytes
  }
  reap(now = Date.now()): void {
    this.lastReap = now
    for (const [id, lease] of this.leases) if (lease.expires <= now) { this.leases.delete(id); this.collect(lease.journal) }
  }
  dispose(): void {
    if (this.directory) rmSync(this.directory, { recursive: true, force: true })
    totalBytes -= this.bytes
    this.directory = undefined; this.files.clear(); this.leases.clear(); this.bytes = 0; stores.delete(this)
    if (!stores.size) { clearInterval(scratchReaper); scratchReaper = undefined }
  }
}

/** Keep small turns in memory; append large turns to disk. A freeze is immutable
 * even if execution advances or the current journal is reset while it is read. */
export class SnapshotEventJournal<T> {
  private events: T[] = []
  private failedReason?: string
  private bytes = 0
  private journal: string | undefined
  private unavailable = false
  constructor(readonly payloads = new SnapshotPayloadStore(), private memoryBytes = 256 * 1024) {}
  append(event: T): void {
    if (this.unavailable) return
    try {
    const line = JSON.stringify(event) + '\n'
    if (!this.journal && this.bytes + Buffer.byteLength(line) > this.memoryBytes) {
      this.journal = this.payloads.createJournal()
      for (const prior of this.events) this.payloads.append(this.journal, JSON.stringify(prior) + '\n')
      this.events = []
    }
    if (this.journal) this.payloads.append(this.journal, line)
    else this.events.push(structuredClone(event))
    this.bytes += Buffer.byteLength(line)
    } catch (error) { this.reset(); this.unavailable = true; this.failedReason = error instanceof Error ? error.message : 'Scratch write failed' }
  }
  snapshot(): { events: T[]; eventsReference?: SnapshotPayloadReference } {
    if (this.unavailable) throw new Error(`Current turn snapshot unavailable: ${this.failedReason}; persisted history is preserved`)
    return this.journal ? { events: [], eventsReference: this.payloads.freeze(this.journal) } : { events: structuredClone(this.events) }
  }
  reset(): void {
    if (this.journal) this.payloads.remove(this.journal)
    this.journal = undefined; this.events = []; this.bytes = 0; this.unavailable = false
  }
}
