import { newQuickJSWASMModuleFromVariant, type QuickJSContext, type QuickJSRuntime } from 'quickjs-emscripten-core'
import variant from '@jitl/quickjs-singlefile-cjs-release-sync'
import { assertToolAllowedWithoutAutoApprove, requiresAgentMode } from '../../../../../shared/operationModeToolPolicy.js'
import { REPL_GUIDE } from '../../../../../shared/replGuide.js'
import type { ToolExecutionContext, ToolExecutor } from './toolLoopService.js'

const MAX_SESSIONS = 16
const IDLE_MS = 30 * 60_000
const MAX_VALUE_BYTES = 8 * 1024 * 1024
const MAX_ARTIFACT_BYTES = 5 * 1024 * 1024
const MEMORY_BYTES = 32 * 1024 * 1024
const MAX_OUTPUT = 20_000
const MAX_CODE = 32_000
const NAME = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/
// These tools have transcript/UI semantics, not just a return value. Never hide them.
const DIRECT_ONLY = new Set(['repl', 'multi_call', 'skill_manager', 'html_renderer', 'view_image'])

type Session = {
  runtime: QuickJSRuntime
  vm: QuickJSContext
  touched: number
  deadline: number
}

type Workspace = {
  session?: Session
  tail: Promise<void>
  queued: number
  active: number
  touched: number
  revision: number
  mutationEpoch: number
  lastWriter: string | null
  reservations: Map<string, symbol>
}
const MAX_QUEUED_CELLS = 64
const MAX_CAPTURES = 16

function argsObject(value: unknown): Record<string, any> {
  const parsed = typeof value === 'string' ? JSON.parse(value) : value
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('repl arguments must be an object')
  return parsed as Record<string, any>
}

function variableName(value: unknown): string {
  if (typeof value !== 'string' || !NAME.test(value) || ['__proto__', 'prototype', 'constructor'].includes(value)) {
    throw new Error('Expected a variable name (1–64 identifier characters)')
  }
  return value
}

function integer(value: unknown, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || Number(value) < min || Number(value) > max) throw new Error(`Expected integer in ${min}–${max}`)
  return Number(value)
}

// Serialize plain tool data incrementally. Do not call user/custom-tool getters or
// toJSON, and reject excessive depth/work before allocating a complete JSON copy.
function boundedJson(value: unknown): string {
  const chunks: string[] = []
  const ancestors = new Set<object>()
  const deadline = Date.now() + 100
  let bytes = 0
  let nodes = 0
  const add = (text: string) => {
    bytes += Buffer.byteLength(text, 'utf8')
    if (bytes > MAX_VALUE_BYTES) throw new Error('result exceeds 8 MiB')
    chunks.push(text)
  }
  const string = (text: string) => {
    if (text.length > MAX_VALUE_BYTES) throw new Error('result exceeds 8 MiB')
    add(JSON.stringify(text))
  }
  const visit = (item: unknown, depth: number): void => {
    if (++nodes > 100_000 || depth > 64 || Date.now() > deadline) throw new Error('result serialization budget exceeded')
    if (item == null) { add('null'); return }
    if (typeof item === 'string') { string(item); return }
    if (typeof item === 'number' || typeof item === 'boolean') { add(JSON.stringify(item)); return }
    if (typeof item !== 'object') throw new Error('result is not plain JSON data')
    if (ancestors.has(item)) throw new Error('result is cyclic')
    ancestors.add(item)
    const array = Array.isArray(item)
    if (!array && ![Object.prototype, null].includes(Object.getPrototypeOf(item))) throw new Error('result is not plain JSON data')
    const keys = Object.keys(item)
    if (keys.length > 100_000 || (array && item.length > 100_000)) throw new Error('result serialization budget exceeded')
    add(array ? '[' : '{')
    let first = true
    const field = (key: string) => {
      const descriptor = Object.getOwnPropertyDescriptor(item, key)
      if (descriptor && !('value' in descriptor)) throw new Error('result contains an accessor')
      const child = descriptor?.value
      if (!array && child === undefined) return
      if (!first) add(',')
      first = false
      if (!array) { string(key); add(':') }
      visit(child, depth + 1)
    }
    if (array) for (let i = 0; i < item.length; i++) field(String(i))
    else for (const key of keys) field(key)
    add(array ? ']' : '}')
    ancestors.delete(item)
  }
  visit(value, 0)
  return chunks.join('')
}

// Executed INSIDE QuickJS, never in Node. Capture intrinsics so cells cannot replace
// inspection/serialization with host callbacks. No Node, network, or module loader.
const BOOTSTRAP = `(() => {
  const stringify = JSON.stringify, parse = JSON.parse;
  const keys = Object.keys, describe = Object.getOwnPropertyDescriptor, define = Object.defineProperty;
  const array = Array.isArray, own = Object.prototype.hasOwnProperty.call.bind(Object.prototype.hasOwnProperty);
  const initial = new Set(Object.getOwnPropertyNames(globalThis));
  const initialHas = initial.has.bind(initial);
  const has = name => own(globalThis, name) && !initialHas(name);
  const get = name => {
    if (!has(name)) throw Error('Variable not found; use top-level var declarations');
    const d = describe(globalThis, name);
    if (!own(d, 'value')) throw Error('Accessor variables are not supported');
    return d.value;
  };
  const serialize = value => {
    const text = stringify(value);
    if (text === undefined) throw Error('Value is not JSON-serializable');
    return text;
  };
  // Artifact serialization never uses object JSON hooks or reads property values
  // through getters. Capture intrinsics before user cells can replace them.
  const ownKeys = Reflect.ownKeys, prototype = Object.getPrototypeOf;
  const objectPrototype = Object.prototype, arrayPrototype = Array.prototype;
  const finite = Number.isFinite, ArtifactError = Error;
  const join = Function.prototype.call.bind(Array.prototype.join);
  const artifact = value => {
    const chunks = [], ancestors = [];
    let chars = 0, nodes = 0, count = 0;
    const add = text => {
      chars += text.length;
      if (chars > 5242880) throw new ArtifactError('JSON artifact exceeds 5 MiB');
      chunks[count++] = text;
    };
    const visit = (item, depth) => {
      if (++nodes > 100000 || depth > 64) throw new ArtifactError('JSON artifact exceeds depth/node budget');
      if (item === null) { add('null'); return; }
      const type = typeof item;
      if (type === 'string' || type === 'boolean' || (type === 'number' && finite(item))) {
        if (type === 'string' && item.length > 5242880) throw new ArtifactError('JSON artifact exceeds 5 MiB');
        add(stringify(item)); return;
      }
      if (type !== 'object') throw new ArtifactError('JSON artifact contains an unsupported value');
      for (let i = 0; i < depth; i++) if (ancestors[i] === item) throw new ArtifactError('JSON artifact contains a cycle');
      ancestors[depth] = item;
      const isArray = array(item), proto = prototype(item);
      if (isArray ? proto !== arrayPrototype : proto !== objectPrototype && proto !== null)
        throw new ArtifactError('JSON artifact contains an unsupported prototype');
      const fields = ownKeys(item);
      if (fields.length > 100001) throw new ArtifactError('JSON artifact exceeds node budget');
      const length = isArray ? describe(item, 'length').value : 0;
      if (isArray && (length > 100000 || fields.length !== length + 1))
        throw new ArtifactError('JSON artifact requires dense arrays without extra properties');
      add(isArray ? '[' : '{');
      let written = 0;
      for (let i = 0; i < fields.length; i++) {
        const key = isArray ? (i === length ? 'length' : '' + i) : fields[i];
        if (isArray && key === 'length') continue;
        const d = describe(item, key);
        if (typeof key !== 'string' || !d || !own(d, 'value') || !d.enumerable)
          throw new ArtifactError('JSON artifact contains an accessor, symbol or non-enumerable property');
        if (written++) add(',');
        if (!isArray) { add(stringify(key)); add(':'); }
        visit(d.value, depth + 1);
      }
      add(isArray ? ']' : '}');
      ancestors[depth] = undefined;
    };
    visit(value, 0);
    return join(chunks, '');
  };
  const info = name => {
    const value = get(name);
    return { variable: name, type: value === null ? 'null' : array(value) ? 'array' : typeof value,
      ...(typeof value === 'string' || array(value) ? { length: value.length } : {}),
      ...(value && typeof value === 'object' && !array(value) ? { keys: keys(value).slice(0, 30) } : {}) };
  };
  define(globalThis, '__repl', { value: Object.freeze({
    has, info,
    artifact(name) { return artifact(get(name)); },
    validateArtifact(text) { artifact(parse(text)); },
    put(name, text, overwrite) {
      if (initialHas(name) || name === '__repl') throw Error('Reserved variable name');
      if (has(name) && !overwrite) throw Error('Variable exists; pass overwrite:true');
      if (has(name)) {
        const d = describe(globalThis, name);
        if (!own(d, 'value') || !d.writable) throw Error('Variable is not writable');
      }
      define(globalThis, name, { value: parse(text), writable: true, enumerable: true, configurable: true });
    },
    check(name, overwrite) {
      if (initialHas(name) || name === '__repl') throw Error('Reserved variable name');
      if (has(name) && !overwrite) throw Error('Variable exists; pass overwrite:true');
      if (has(name)) { const d = describe(globalThis, name); if (!own(d, 'value') || !d.writable) throw Error('Variable is not writable'); }
    },
    list() { return keys(globalThis).filter(name => !initialHas(name) && name !== '__repl').slice(0, 100).map(info); },
    drop(name) { get(name); if (!delete globalThis[name]) throw Error('Cannot drop this binding; reset the session'); },
    show(name, offset, limit) {
      const value = get(name), text = typeof value === 'string' ? value : serialize(value);
      return { content: text.slice(offset, offset + limit), totalChars: text.length,
        truncated: offset + limit < text.length, nextOffset: offset + limit < text.length ? offset + limit : null };
    },
    encode: serialize
  }), writable: false, configurable: false });
})();`

/** Memory-only branch workspaces. Agent identity is attribution, not namespace. */
export class ReplSessions {
  private workspaces = new Map<string, Workspace>()
  private captureSequence = 0

  private key(context: ToolExecutionContext): string {
    if (!context.conversationId || (!context.lineageId && !context.replOwnerId)) throw new Error('repl requires a branch lineage or agent identity')
    // Standalone children without a verified parent branch retain a private scope.
    return JSON.stringify([context.conversationId, context.lineageId ? ['branch', context.lineageId] : ['agent', context.replOwnerId], context.rootPath ?? null])
  }

  private disposeSession(workspace: Workspace): void {
    workspace.session?.vm.dispose()
    workspace.session?.runtime.dispose()
    workspace.session = undefined
  }

  clear(): void {
    for (const [key, workspace] of this.workspaces) {
      if (!workspace.active && !workspace.queued && !workspace.reservations.size) {
        this.disposeSession(workspace)
        this.workspaces.delete(key)
      }
    }
  }

  private workspace(key: string): Workspace {
    for (const [id, workspace] of this.workspaces) {
      if (!workspace.active && !workspace.queued && !workspace.reservations.size && Date.now() - workspace.touched > IDLE_MS) {
        this.disposeSession(workspace)
        this.workspaces.delete(id)
      }
    }
    let workspace = this.workspaces.get(key)
    if (!workspace) {
      if (this.workspaces.size >= MAX_SESSIONS) throw new Error('REPL session limit reached; reset unused sessions')
      workspace = { tail: Promise.resolve(), queued: 0, active: 0, touched: Date.now(), revision: 0, mutationEpoch: 0, lastWriter: null, reservations: new Map() }
      this.workspaces.set(key, workspace)
    }
    return workspace
  }

  /** FIFO for short state operations only. Tool/subagent waits never own this lock. */
  private cell<T>(workspace: Workspace, context: ToolExecutionContext, operation: () => Promise<T> | T): Promise<T> {
    context.signal?.throwIfAborted()
    if (workspace.queued >= MAX_QUEUED_CELLS) throw new Error('REPL cell queue limit reached')
    workspace.queued++
    const previous = workspace.tail
    const task = previous.then(async () => {
      workspace.queued--
      context.signal?.throwIfAborted()
      workspace.active++
      try { return await operation() }
      finally { workspace.active--; workspace.touched = Date.now() }
    })
    workspace.tail = task.then(() => undefined, () => undefined)
    // A cancelled waiter returns immediately; its queued operation is skipped when
    // reached. The queue retains ordering rather than releasing a running cell early.
    if (!context.signal) return task
    const signal = context.signal
    return new Promise<T>((resolve, reject) => {
      const abort = () => reject(signal.reason ?? new DOMException('REPL cell aborted', 'AbortError'))
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
      task.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
    })
  }

  private waitForTool(context: ToolExecutionContext, task: Promise<any>): Promise<any> {
    if (!context.signal) return task
    const signal = context.signal
    return new Promise((resolve, reject) => {
      const abort = () => reject(signal.reason ?? new DOMException('REPL capture aborted; tool side effects may still complete', 'AbortError'))
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
      // Observe late failures, but never store a late result after cancellation.
      task.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
    })
  }

  private async session(workspace: Workspace, context: ToolExecutionContext): Promise<Session> {
    if (!workspace.session) {
      const module = await newQuickJSWASMModuleFromVariant(variant)
      context.signal?.throwIfAborted()
      const runtime = module.newRuntime()
      runtime.setMemoryLimit(MEMORY_BYTES)
      runtime.setMaxStackSize(512 * 1024)
      const session = { runtime, vm: runtime.newContext(), touched: Date.now(), deadline: 0 }
      runtime.setInterruptHandler(() => Date.now() > session.deadline || context.signal?.aborted === true)
      try { this.eval(session, BOOTSTRAP) } catch (error) { session.vm.dispose(); runtime.dispose(); throw error }
      workspace.session = session
    }
    context.signal?.throwIfAborted()
    const session = workspace.session
    session.runtime.setInterruptHandler(() => Date.now() > session.deadline || context.signal?.aborted === true)
    return session
  }

  private eval(session: Session, code: string, milliseconds = 100, readString = false): any {
    session.deadline = Date.now() + milliseconds
    const result = session.vm.evalCode(code, 'repl.js')
    try {
      if (result.error) throw new Error(`REPL: ${String(session.vm.dump(result.error)?.message ?? 'JavaScript execution failed').slice(0, 500)}`)
      return readString && session.vm.typeof(result.value) === 'string' ? session.vm.getString(result.value) : undefined
    } finally { result.dispose() }
  }

  private query(session: Session, expression: string): any {
    const text = this.eval(session, `(() => { const text = __repl.encode(${expression}); if (text.length > 150000) throw Error('Inspection too large; narrow the value with exec'); return text; })()`, 100, true)
    return JSON.parse(text)
  }

  private changed(workspace: Workspace, context: ToolExecutionContext, invalidateCaptures = false): void {
    workspace.revision++
    if (invalidateCaptures) workspace.mutationEpoch++
    workspace.lastWriter = context.replOwnerId ?? 'main'
  }

  private receipt(workspace: Workspace): { revision: number; lastWriter: string | null } {
    return { revision: workspace.revision, lastWriter: workspace.lastWriter }
  }

  async run(args: Record<string, any>, context: ToolExecutionContext, invoke: (tool: string, args: Record<string, any>) => Promise<any>): Promise<any> {
    context.signal?.throwIfAborted()
    if (args.howto !== undefined && typeof args.howto !== 'boolean') throw new Error('howto must be a boolean')
    if (args.howto === true) return { success: true, howto: REPL_GUIDE }
    const action = args.action
    if (!['invoke', 'exec', 'inspect', 'show', 'list', 'drop', 'reset', 'export', 'import'].includes(action)) throw new Error('Unknown repl action')
    const key = this.key(context)
    if (action === 'reset' && context.replOwnerId && context.lineageId) throw new Error('Only the parent agent may reset the shared REPL workspace')
    const artifactAction = action === 'export' || action === 'import'
    if (artifactAction) {
      if (typeof args.path !== 'string' || !args.path.trim() || args.path.includes('\u0000')) throw new Error('path is required')
      if (args.overwrite !== undefined && typeof args.overwrite !== 'boolean') throw new Error('overwrite must be a boolean')
      const tool = action === 'export' ? 'create_file' : 'read_file'
      if (!context.nestedExecutor) throw new Error('REPL requires a policy-aware nested executor')
      if (!context.allowedToolNames?.has(tool)) throw new Error(`Tool is not available to this caller: ${tool}`)
      if (requiresAgentMode({ name: tool }, context.operationMode ?? 'execute')) throw new Error('REPL export is not available in Chat Mode')
      if (context.autoApprove === false && context.replOwnerId) assertToolAllowedWithoutAutoApprove({ name: tool })
    }
    const workspace = this.workspace(key)
    if (action === 'export') {
      const name = variableName(args.variable)
      const snapshot = await this.cell(workspace, context, async () => {
        const session = await this.session(workspace, context)
        // Reflection on guest proxies can run traps, so conservatively invalidate captures.
        if (workspace.reservations.size) this.changed(workspace, context, true)
        let text: string
        try { text = this.eval(session, `__repl.artifact(${JSON.stringify(name)})`, 250, true) }
        catch { throw new Error('Cannot export: expected bounded plain JSON data (no cycles, accessors or unsupported values); serialization may also exceed CPU/memory limits') }
        const sizeBytes = Buffer.byteLength(text, 'utf8')
        if (sizeBytes > MAX_ARTIFACT_BYTES) throw new Error('JSON artifact exceeds 5 MiB')
        return { text, sizeBytes, ...this.receipt(workspace) }
      })
      const result = await this.waitForTool(context, invoke('create_file', {
        path: args.path, content: snapshot.text, overwrite: args.overwrite === true, createParentDirs: true,
      }))
      context.signal?.throwIfAborted()
      if (result?.success !== true) throw new Error('REPL export write failed; file side effects may remain. Inspect the destination before retrying.')
      return { success: true, status: 'exported', variable: name, path: args.path, format: 'json',
        sizeBytes: snapshot.sizeBytes, revision: snapshot.revision, lastWriter: snapshot.lastWriter }
    }
    if (action !== 'invoke' && action !== 'import') return this.cell(workspace, context, async () => {
      if (action === 'reset') {
        if (workspace.reservations.size) throw new Error('Cannot reset while captures are in flight')
        this.disposeSession(workspace)
        this.changed(workspace, context, true)
        // No queued callers may still hold this workspace when releasing its slot.
        if (!workspace.queued) this.workspaces.delete(key)
        return { success: true, reset: true, ...this.receipt(workspace) }
      }
      const session = await this.session(workspace, context)
      if (action === 'list') {
        // Shape inspection of guest objects can run getters, just like inspect/show.
        if (workspace.reservations.size) this.changed(workspace, context, true)
        return { variables: this.query(session, '__repl.list()'), pendingCaptures: [...workspace.reservations.keys()], lifetime: 'memory-only; lazy expiration after 30 minutes idle or server restart', ...this.receipt(workspace) }
      }
      if (action === 'exec') {
        if (typeof args.code !== 'string' || !args.code.trim() || args.code.length > MAX_CODE) throw new Error('code must contain 1–32000 characters')
        const timeout = integer(args.timeoutMs, 100, 1, 250)
        // Validate disclosure parameters before running potentially mutating code.
        const show = args.show === undefined ? undefined : variableName(args.show)
        const offset = show === undefined ? 0 : integer(args.offset, 0, 0, Number.MAX_SAFE_INTEGER)
        const limit = show === undefined ? 4000 : integer(args.maxOutputChars, 4000, 1, MAX_OUTPUT)
        // Arbitrary JS (including reads with getters) can mutate shared values. A
        // cell started during capture conservatively invalidates overwriting an
        // existing destination. New, still-absent destinations can safely commit.
        try { this.eval(session, args.code, timeout) }
        finally { this.changed(workspace, context, true) }
        if (show !== undefined) {
          // Keep execution and disclosure in the same cell; no sibling can interleave.
          try {
            return { success: true, status: 'executed', variable: show,
              ...this.query(session, `__repl.show(${JSON.stringify(show)}, ${offset}, ${limit})`), ...this.receipt(workspace) }
          } catch (error) {
            throw new Error(`REPL exec completed, but show failed: ${error instanceof Error ? error.message : String(error)}. State changes remain; use inspect/show without rerunning exec.`)
          }
        }
        return { success: true, status: 'executed', output: 'Stored values are not printed. Use inspect/show/list, or pass show:"variableName" with exec.', ...this.receipt(workspace) }
      }
      const name = variableName(args.variable)
      const quoted = JSON.stringify(name)
      if (action === 'drop') {
        if (workspace.reservations.has(name)) throw new Error('Variable is reserved by an in-flight capture')
        try { this.eval(session, `__repl.drop(${quoted})`) }
        finally { this.changed(workspace, context, true) }
        return { success: true, dropped: name, ...this.receipt(workspace) }
      }
      // Object inspection/JSON serialization can execute guest getters/toJSON.
      // Treat these as possible mutation while a capture is awaiting its tool.
      if (workspace.reservations.size) this.changed(workspace, context, true)
      if (action === 'inspect') return { ...this.query(session, `__repl.info(${quoted})`), ...this.receipt(workspace) }
      return { ...this.query(session, `__repl.show(${quoted}, ${integer(args.offset, 0, 0, Number.MAX_SAFE_INTEGER)}, ${integer(args.maxOutputChars, 4000, 1, MAX_OUTPUT)})`), ...this.receipt(workspace) }
    })

    const name = variableName(args.assign)
    const quoted = JSON.stringify(name)
    const token = Symbol(name)
    let epoch = 0
    let existed = false
    try {
      await this.cell(workspace, context, async () => {
        if (workspace.reservations.has(name)) throw new Error('Variable is reserved by an in-flight capture')
        if (workspace.reservations.size >= MAX_CAPTURES) throw new Error('REPL in-flight capture limit reached')
        const session = await this.session(workspace, context)
        this.eval(session, `__repl.check(${quoted}, ${args.overwrite === true})`)
        existed = this.query(session, `__repl.has(${quoted})`)
        epoch = workspace.mutationEpoch
        workspace.reservations.set(name, token)
      })
      // Do not hold a cell while awaiting IO or a child which needs this workspace.
      let value: any
      let toolStatus = 'success'
      try {
        value = await this.waitForTool(context, action === 'import'
          ? invoke('read_file', { path: args.path, maxBytes: MAX_ARTIFACT_BYTES })
          : invoke(args.tool, args.args === undefined ? {} : argsObject(args.args)))
        if (value?.success === false || value?.isError === true) toolStatus = 'error'
      } catch (error) {
        if (context.signal?.aborted || (error instanceof Error && error.name === 'AbortError')) throw error
        toolStatus = 'error'
        value = { success: false, error: error instanceof Error ? error.message : String(error) }
      }
      context.signal?.throwIfAborted()
      const metadataOnly = !!value && typeof value === 'object' && 'modelContent' in value
      if (metadataOnly) value = value.persistedContent ?? value.displayContent ?? { unavailable: 'Use this tool directly for its multimodal output' }
      let text: string
      if (action === 'import') {
        if (toolStatus === 'error' || metadataOnly || typeof value?.content !== 'string') throw new Error('REPL import read failed; destination unchanged')
        if (value.truncated !== false || value.sizeBytes > MAX_ARTIFACT_BYTES || Buffer.byteLength(value.content, 'utf8') > MAX_ARTIFACT_BYTES)
          throw new Error('REPL import requires a complete JSON file of at most 5 MiB; destination unchanged')
        text = value.content.replace(/^\uFEFF/, '')
        // Never include native parser errors: they may quote private file contents.
        try { JSON.parse(text) } catch { throw new Error('REPL import contains invalid JSON; destination unchanged') }
      } else {
        try { text = boundedJson(value ?? null) }
        catch (error) { throw new Error(`Tool executed but ${error instanceof Error ? error.message : 'serialization failed'}; request bounded JSON output. Do not blindly repeat side effects`) }
      }
      return await this.cell(workspace, context, async () => {
        const session = await this.session(workspace, context)
        if (action === 'import') {
          try { this.eval(session, `__repl.validateArtifact(${JSON.stringify(text)})`, 250) }
          catch { throw new Error('REPL import exceeds plain JSON depth/node/CPU/memory limits or contains non-finite numbers; destination unchanged') }
        }
        if (workspace.reservations.get(name) !== token ||
          (epoch !== workspace.mutationEpoch && (existed || this.query(session, `__repl.has(${quoted})`)))) {
          let resultVariable: string
          do { resultVariable = `repl_capture_${++this.captureSequence}` }
          while (workspace.reservations.has(resultVariable) || this.query(session, `__repl.has(${JSON.stringify(resultVariable)})`))
          try { this.eval(session, `__repl.put(${JSON.stringify(resultVariable)}, ${JSON.stringify(text)}, false)`) }
          catch { throw new Error('Tool executed but conflict result could not be retained; do not blindly repeat side effects') }
          this.changed(workspace, context)
          return { status: 'conflict', variable: name, resultVariable, toolStatus, toolExecuted: true,
            error: 'Workspace changed during capture; destination was not replaced. Inspect resultVariable instead of repeating side effects.', ...this.receipt(workspace) }
        }
        try { this.eval(session, `__repl.put(${quoted}, ${JSON.stringify(text)}, ${args.overwrite === true})`) }
        catch { throw new Error('Tool executed but storing its result failed; reset or free session memory. Do not blindly repeat side effects') }
        this.changed(workspace, context)
        return { status: action === 'import' ? 'imported' : 'stored', variable: name, toolStatus,
          ...(action === 'import' ? { success: true, path: args.path, format: 'json', sizeBytes: Buffer.byteLength(text, 'utf8') } : {}),
          ...(metadataOnly ? { metadataOnly: true } : {}), ...this.receipt(workspace) }
      })
    } finally {
      if (workspace.reservations.get(name) === token) workspace.reservations.delete(name)
      workspace.touched = Date.now()
    }
  }
}

export function createReplDispatchExecutor(leaf: ToolExecutor, sessions = new ReplSessions()): ToolExecutor {
  return async (call, context) => {
    if (call.name !== 'repl') return leaf(call, context)
    return sessions.run(argsObject(call.arguments), context, async (tool, args) => {
      if (typeof tool !== 'string' || !tool.trim()) throw new Error('tool is required')
      tool = tool.trim()
      if (DIRECT_ONLY.has(tool) || (tool === 'plan_md' && args.action === 'display')) throw new Error(`Use ${tool} directly; recursive or context/UI tools cannot be captured`)
      if (!context.nestedExecutor) throw new Error('REPL requires a policy-aware nested executor')
      if (!context.allowedToolNames?.has(tool)) throw new Error(`Tool is not available to this caller: ${tool}`)
      if (requiresAgentMode({ name: tool, arguments: args }, context.operationMode ?? 'execute')) throw new Error(`Tool "${tool}" is not available in Chat Mode`)
      return context.nestedExecutor({ id: `${call.id}:invoke`, name: tool, arguments: args }, context)
    })
  }
}
