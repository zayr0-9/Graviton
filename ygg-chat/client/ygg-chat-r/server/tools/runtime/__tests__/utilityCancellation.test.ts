import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ bash: vi.fn(), powershell: vi.fn(), post: vi.fn(), receive: undefined as undefined | ((message: unknown) => void) }))
vi.mock('../../bash.js', () => ({ runBashCommand: mocks.bash }))
vi.mock('../../powershell.js', () => ({ runPowerShellCommand: mocks.powershell }))
vi.mock('../../createFile.js', () => ({ createTextFile: vi.fn() }))
vi.mock('../../deleteFile.js', () => ({ deleteFile: vi.fn(), safeDeleteFile: vi.fn() }))
vi.mock('../../directory.js', () => ({ extractDirectoryStructure: vi.fn() }))
vi.mock('../../editFile.js', () => ({ editFile: vi.fn(), multiEdit: vi.fn() }))
vi.mock('../../glob.js', () => ({ globSearch: vi.fn() }))
vi.mock('../../htmlRenderer.js', () => ({ default: {} }))
vi.mock('../../readFile.js', () => ({ readFileContinuation: vi.fn(), readTextFile: vi.fn() }))
vi.mock('../../readFiles.js', () => ({ formatReadFilesContent: vi.fn(), readMultipleTextFiles: vi.fn() }))
vi.mock('../../ripgrep.js', () => ({ ripgrepSearch: vi.fn() }))
vi.mock('../../viewImage.js', () => ({ viewImage: vi.fn() }))
vi.mock('../../streamUndoManager.js', () => ({ recordPreEditBackup: vi.fn(), recordToolEditSuccess: vi.fn() }))
vi.mock('../../customToolLoader.js', () => ({ customToolRegistry: { initialize: vi.fn().mockResolvedValue(undefined) } }))

let originalPort: unknown
beforeEach(async () => {
  vi.useFakeTimers(); vi.resetModules(); vi.clearAllMocks()
  originalPort = (process as any).parentPort
  ;(process as any).parentPort = { postMessage: mocks.post, on: (_event: string, listener: (message: unknown) => void) => { mocks.receive = listener } }
  await import('../../../toolRuntimeUtility.js')
})
afterEach(() => { (process as any).parentPort = originalPort; vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks() })
const send = (requestId: string, toolName: string, deadlineMs?: number) => mocks.receive!({ type: 'execute_tool', requestId, toolName, args: { command: 'echo ok', description: 'test' }, options: { deadlineMs } })

it('forwards per-request signals and deadlines to both shells, cancelling only the requested command', async () => {
  const options: any[] = []
  const run = (_command: string, opts: any) => { options.push(opts); return new Promise(resolve => opts.signal.addEventListener('abort', () => resolve({ cancelled: true }))) }
  mocks.bash.mockImplementation(run); mocks.powershell.mockImplementation(run)
  send('a', 'bash', 123); send('b', 'powershell', 456)
  expect(options.map(o => o.deadlineMs)).toEqual([123, 456])
  expect(options[0].signal).toBeInstanceOf(AbortSignal)
  mocks.receive!({ type: 'cancel_tool', requestId: 'a' })
  expect(options[0].signal.aborted).toBe(true)
  expect(options[1].signal.aborted).toBe(false)
  await vi.advanceTimersByTimeAsync(0)
  expect(mocks.post).toHaveBeenCalledWith(expect.objectContaining({ type: 'tool_result', requestId: 'a', success: true }))
  mocks.receive!({ type: 'cancel_tool', requestId: 'b' })
  await vi.advanceTimersByTimeAsync(0)
})

it('aborts active requests before shutdown ack and bounds cleanup for uncooperative handlers', async () => {
  const options: any[] = []
  mocks.bash.mockImplementation((_command, opts) => { options.push(opts); return new Promise(() => {}) })
  const exit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any)
  send('a', 'bash')
  mocks.receive!({ type: 'shutdown', requestId: 'shutdown' })
  expect(options[0].signal.aborted).toBe(true)
  expect(exit).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(399)
  expect(exit).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(mocks.post).toHaveBeenCalledWith({ type: 'shutdown_ack', requestId: 'shutdown' })
  expect(exit).toHaveBeenCalledWith(0)
  send('b', 'bash')
  expect(mocks.bash).toHaveBeenCalledTimes(1)
})
