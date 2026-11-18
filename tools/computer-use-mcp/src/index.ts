import { existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StdioDesktopBackend } from './backend.js';
import { createComputerUseServer } from './server.js';

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { 'app-bundle-id': { type: 'string' } } });
  const bundleID = values['app-bundle-id'];
  if (bundleID !== undefined && !/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(bundleID)) {
    throw new Error('Supply one --app-bundle-id, e.g. com.apple.TextEdit.');
  }
  if (process.platform !== 'darwin') throw new Error('Only the macOS backend is available in this prototype.');
  const { dirname, join } = await import('node:path');
  const packaged = join(dirname(process.execPath), 'Graviton Computer Use.app', 'Contents', 'MacOS', 'graviton-computer-use');
  const helper = existsSync(packaged) ? packaged : fileURLToPath(new URL('../.build/release/graviton-computer-use', import.meta.url));
  if (!existsSync(helper)) throw new Error('Native helper not found. Run npm run build in the prototype directory.');

  const backend = new StdioDesktopBackend(helper, bundleID ? ['--app-bundle-id', bundleID] : []);
  const server = createComputerUseServer(backend);
  const stop = () => {
    backend.close();
    void server.close().finally(() => process.exit());
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  process.stdin.once('end', stop);
  await server.connect(new StdioServerTransport());
}

await main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Computer Use server could not start.');
  process.exitCode = 1;
});
