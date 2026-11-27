import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { z } from 'zod';

export type DesktopRequest =
  | { method: 'list_apps' | 'list_windows' | 'request_permissions' | 'select_app' | 'select_window' | 'get_app_state' | 'set_value' | 'input_click' | 'drag' | 'scroll' | 'press_key' | 'type_text' | 'paste' | 'select_text' | 'perform_secondary_action'; [field: string]: unknown }
  | { method: 'status' }
  | { method: 'inspect_window'; screenshot?: boolean }
  | { method: 'click'; snapshotId: string; elementId: number }
  | { method: 'set_text'; snapshotId: string; elementId: number; text: string };
export type DesktopReply = { text: string; jpeg?: string };

export interface DesktopBackend {
  request(request: DesktopRequest, signal: AbortSignal): Promise<DesktopReply>;
  close(): void;
}

const replySchema = z.union([
  z.strictObject({ error: z.string() }),
  z.strictObject({ text: z.string(), jpeg: z.base64().optional() }),
]);
const maxReplyBytes = 2 * 1024 * 1024;

// One native session per MCP process. Never retry an action when the outcome is uncertain.
export class StdioDesktopBackend implements DesktopBackend {
  private child?: ChildProcessWithoutNullStreams;
  private tail = Promise.resolve();
  private closed = false;

  constructor(private readonly command: string, private readonly args: string[], private readonly timeoutMs = 12_000) {}

  request(request: DesktopRequest, signal: AbortSignal): Promise<DesktopReply> {
    const job = this.tail.then(() => this.exchange(request, signal));
    this.tail = job.then(() => undefined, () => undefined);
    return job;
  }

  close(): void {
    this.closed = true;
    this.reset(this.child);
  }

  private reset(child?: ChildProcessWithoutNullStreams): void {
    if (!child || this.child !== child) return;
    this.child = undefined;
    child.kill('SIGKILL');
  }

  private getChild(): ChildProcessWithoutNullStreams {
    if (this.child) return this.child;
    // No shell and no model-controlled command or arguments.
    const child = spawn(this.command, this.args, { stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    child.stderr.resume(); // Native diagnostics must not echo UI content into host logs.
    child.stdin.on('error', () => this.reset(child));
    child.on('error', () => this.reset(child));
    child.once('close', () => { if (this.child === child) this.child = undefined; });
    return child;
  }

  private async exchange(request: DesktopRequest, signal: AbortSignal): Promise<DesktopReply> {
    if (this.closed || signal.aborted) throw new Error('Computer Use request cancelled before starting.');
    const child = this.getChild();
    const raw = await new Promise<unknown>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      let settled = false;
      const uncertain = 'Inspect the window again before deciding whether to retry.';
      const cleanup = () => {
        settled = true;
        clearTimeout(timer);
        child.stdout.off('data', onData);
        child.off('error', onError);
        child.off('close', onClose);
        signal.removeEventListener('abort', onAbort);
      };
      const fail = (message: string) => {
        if (settled) return;
        cleanup();
        this.reset(child);
        reject(new Error(message));
      };
      const onError = (error: Error) => fail(`Could not start the native helper: ${error.message}`);
      const onClose = () => fail(`Native helper exited before responding. ${uncertain}`);
      const onAbort = () => fail(`Computer Use request cancelled. ${uncertain}`);
      const onData = (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxReplyBytes) return fail(`Native helper response exceeded the limit. ${uncertain}`);
        const newline = chunk.indexOf(10);
        if (newline === -1) {
          chunks.push(chunk);
          return;
        }
        if (newline !== chunk.length - 1) return fail(`Unexpected data from the native helper. ${uncertain}`);
        chunks.push(chunk.subarray(0, newline));
        try {
          const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          cleanup();
          resolve(parsed);
        } catch {
          fail(`Invalid response from the native helper. ${uncertain}`);
        }
      };
      const timer = setTimeout(() => fail(`Native helper timed out. ${uncertain}`), request.method === 'select_app' || request.method === 'request_permissions' || (request.method === 'get_app_state' && request.app) ? Math.max(this.timeoutMs, 55_000) : this.timeoutMs);
      child.stdout.on('data', onData);
      child.once('error', onError);
      child.once('close', onClose);
      signal.addEventListener('abort', onAbort, { once: true });
      child.stdin.write(`${JSON.stringify(request)}\n`, (error) => {
        if (error) fail(`Could not send the request to the native helper. ${uncertain}`);
      });
    });
    const reply = replySchema.safeParse(raw);
    if (!reply.success) {
      this.reset(child);
      throw new Error('Invalid response from the native helper. Inspect the window again before retrying.');
    }
    if ('error' in reply.data) throw new Error(reply.data.error);
    return reply.data;
  }
}
