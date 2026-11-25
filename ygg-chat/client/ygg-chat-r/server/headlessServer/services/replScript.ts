import { newQuickJSWASMModuleFromVariant, type QuickJSDeferredPromise } from 'quickjs-emscripten-core'
import variant from '@jitl/quickjs-singlefile-cjs-release-sync'

const ALLOWED_TOOLS = new Set(['read_file', 'glob', 'ripgrep'])
const MAX_CALLS = 8
const MAX_JOBS = 2048
const MAX_ARGUMENT_BYTES = 64 * 1024
const MAX_RESULT_BYTES = 5 * 1024 * 1024

const startScript = `((code, request, capture) => {
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const parse = JSON.parse, serialize = __repl.serializePlain;
  const tools = Object.freeze({
    async call(name, args = {}) {
      return parse(await request(name, serialize(args, ${MAX_ARGUMENT_BYTES})));
    }
  });
  return (async () => {
    const value = await new AsyncFunction('tools', code)(tools);
    return capture ? serialize(value) : '';
  })();
})`

type Request = {
  name: string
  args: Record<string, unknown>
  index: number
  deferred: QuickJSDeferredPromise
}

/** Use a fresh runtime: draining QuickJS jobs in a shared session could run another
 * cell's continuation with this caller's tool authority. No guest survives the call. */
export async function runReplScript(options: {
  code: string
  bootstrap: string
  timeout: number
  capture: boolean
  signal?: AbortSignal
  invoke: (name: string, args: Record<string, unknown>, index: number) => Promise<string>
}): Promise<string> {
  const { code, bootstrap, timeout, capture, signal, invoke } = options
  const module = await newQuickJSWASMModuleFromVariant(variant)
  signal?.throwIfAborted()
  using runtime = module.newRuntime()
  runtime.setMemoryLimit(32 * 1024 * 1024)
  runtime.setMaxStackSize(512 * 1024)
  using vm = runtime.newContext()
  let remaining = timeout
  let deadline = 0
  let calls = 0
  let jobs = 0
  let pending: Request | undefined
  let violation: string | undefined
  runtime.setInterruptHandler(() => performance.now() >= deadline || signal?.aborted === true)
  const slice = <T>(operation: () => T): T => {
    signal?.throwIfAborted()
    if (remaining <= 0) throw new Error('REPL script exceeded its JavaScript CPU budget')
    const start = performance.now()
    deadline = start + remaining
    try { return operation() }
    finally { remaining -= performance.now() - start }
  }
  try {
    using request = vm.newFunction('request', (name, text) => {
      const fail = (message: string) => {
        // Fatal host policy errors are checked before dispatch, even if guest code catches the error.
        violation ??= message
        return { error: vm.newError(message) }
      }
      if (++calls > MAX_CALLS) return fail(`REPL scripts may make at most ${MAX_CALLS} tool calls`)
      if (pending) return fail('REPL scripts must await each tool call before starting another')
      const tool = vm.typeof(name) === 'string' ? vm.getString(name) : ''
      if (!ALLOWED_TOOLS.has(tool)) return fail('REPL scripts can only call read_file, glob, and ripgrep')
      const json = vm.getString(text)
      if (Buffer.byteLength(json, 'utf8') > MAX_ARGUMENT_BYTES) return fail('REPL script tool arguments exceed 64 KiB')
      const args = JSON.parse(json)
      if (!args || typeof args !== 'object' || Array.isArray(args)) return fail('REPL script tool arguments must be a plain object')
      const deferred = vm.newPromise()
      pending = { name: tool, args, index: calls, deferred }
      return deferred.handle
    })
    using entry = slice(() => {
      using result = vm.evalCode(`${bootstrap}\n${startScript}`, 'repl-script.js')
      if (result.error) throw new Error('Could not initialize the REPL script')
      return result.value.dup()
    })
    using codeHandle = vm.newString(code)
    using script = slice(() => {
      using result = vm.callFunction(entry, vm.undefined, codeHandle, request, capture ? vm.true : vm.false)
      if (result.error) throw new Error('Could not start the REPL script')
      return result.value.dup()
    })
    const checkSlice = () => {
      signal?.throwIfAborted()
      if (performance.now() >= deadline) throw new Error('REPL script exceeded its JavaScript CPU budget')
    }
    const step = () => slice(() => {
      while (runtime.hasPendingJob()) {
        checkSlice()
        if (++jobs > MAX_JOBS) throw new Error('REPL script exceeded its promise job budget')
        using job = runtime.executePendingJobs(1)
        checkSlice()
        if (job.error) throw new Error('REPL script promise job failed')
        if (violation) throw new Error(violation)
      }
      if (violation) throw new Error(violation)
      checkSlice()
      const state = vm.getPromiseState(script)
      if (state.type === 'pending') return undefined
      // Do not dump guest-thrown values: they may contain captured tool data.
      if (state.type === 'rejected') {
        state.error.dispose()
        throw new Error('REPL script failed; check syntax/runtime errors and return plain JSON when assigning')
      }
      using value = state.value
      if (pending) throw new Error('REPL script finished with an unawaited tool call')
      const text = vm.getString(value)
      if (Buffer.byteLength(text, 'utf8') > MAX_RESULT_BYTES) throw new Error('REPL script return value exceeds 5 MiB')
      return text
    })
    for (;;) {
      const done = step()
      if (done !== undefined) return done
      const next = pending
      if (!next) throw new Error('REPL script is waiting on a promise with no pending tool call')
      // No workspace cell or QuickJS stack is held across host dispatch/approval.
      signal?.throwIfAborted()
      const text = await invoke(next.name, next.args, next.index)
      slice(() => {
        using value = vm.newString(text)
        next.deferred.resolve(value)
      })
      next.deferred.dispose()
      pending = undefined
    }
  } finally {
    pending?.deferred.dispose()
  }
}
