import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StdioDesktopBackend } from '../dist/backend.js';
import { createComputerUseServer } from '../dist/server.js';

const fixture = fileURLToPath(new URL('./fixture-backend.mjs', import.meta.url));
const executable = fileURLToPath(new URL('../.build/release/graviton-computer-use', import.meta.url));
const script = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const snapshotId = '74d9edd7-4093-4f4b-b7fd-1985cfcf2d67';
const action = { snapshot_id: snapshotId, element_id: 1, text: 'Hello' };
const cancellation = () => new AbortController().signal;

test('MCP exposes typed tools, relays image blocks and surfaces stale snapshot errors', async (t) => {
  const backend = new StdioDesktopBackend(process.execPath, [fixture]);
  const server = createComputerUseServer(backend);
  const client = new Client({ name: 'test', version: '0.1.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  t.after(async () => { backend.close(); await client.close(); await server.close(); });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const expected = ['status','inspect_window','click','set_text','list_apps','select_app','request_permissions','list_windows','select_window','get_app_state','input_click','drag','scroll','press_key','type_text','paste','select_text','perform_secondary_action','set_value'];
  assert.deepEqual((await client.listTools()).tools.map(tool => tool.name).sort(), expected.sort());
  const invalid = await client.callTool({ name: 'inspect_window', arguments: { app: 'com.apple.Safari' } });
  assert.equal(invalid.isError, true);
  const inspection = await client.callTool({ name: 'inspect_window', arguments: { screenshot: true } });
  assert.deepEqual(inspection.content[1], { type: 'image', mimeType: 'image/jpeg', data: '/9j/2Q==' });
  const changed = await client.callTool({ name: 'set_text', arguments: action });
  assert.equal(changed.content[0].text, 'fixture set Hello');
  const stale = await client.callTool({ name: 'set_text', arguments: action });
  assert.equal(stale.isError, true);
  assert.equal(stale.content[0].text, 'stale snapshot');
  assert.equal((await client.callTool({ name: 'inspect_window' })).content.length, 1);
});

test('a timed out native action is not retried and the next request starts a fresh session', async (t) => {
  const backend = new StdioDesktopBackend(process.execPath, [fixture], 600);
  t.after(() => backend.close());
  await backend.request({ method: 'inspect_window' }, cancellation());
  await assert.rejects(backend.request({ method: 'click', snapshotId, elementId: 1 }, cancellation()), /timed out/);
  await assert.rejects(backend.request({ method: 'set_text', snapshotId, elementId: 1, text: 'Hello' }, cancellation()), /stale snapshot/);
  assert.equal((await backend.request({ method: 'status' }, cancellation())).text, 'fixture ready');
});

test('abort cancels an active helper call and already-aborted calls do not run', async (t) => {
  const backend = new StdioDesktopBackend(process.execPath, [fixture]);
  t.after(() => backend.close());
  await backend.request({ method: 'inspect_window' }, cancellation());
  const controller = new AbortController();
  const pending = backend.request({ method: 'click', snapshotId, elementId: 1 }, controller.signal);
  const expected = assert.rejects(pending, /cancelled/);
  await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  await expected;
  await assert.rejects(backend.request({ method: 'status' }, controller.signal), /before starting/);
  assert.equal((await backend.request({ method: 'status' }, cancellation())).text, 'fixture ready');
});

test('stdio MCP startup reaches the real macOS helper without inspecting UI', { skip: process.platform !== 'darwin' }, async (t) => {
  const { existsSync } = await import('node:fs');
  if (!existsSync(executable)) return t.skip('Run npm run build first to compile the native helper.');
  const client = new Client({ name: 'stdio-test', version: '0.1.0' });
  t.after(() => client.close());
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [script, '--app-bundle-id', 'com.apple.TextEdit'] }));
  assert.equal((await client.listTools()).tools.length, 19);
  const result = await client.callTool({ name: 'status' });
  assert.notEqual(result.isError, true);
  assert.match(result.content[0].text, /^App: com\.apple\.TextEdit .*Accessibility: .*Screen Recording: /);
  const stale = await client.callTool({ name: 'click', arguments: { snapshot_id: snapshotId, element_id: 1 } });
  assert.equal(stale.isError, true);
  assert.match(stale.content[0].text, /fresh inspect_window snapshot/);
});

test('v2 native backend refuses all actions without a selected window or local approval', { skip: process.platform !== 'darwin' }, async (t) => {
  const { existsSync } = await import('node:fs');
  if (!existsSync(executable)) return t.skip('Build the helper first.');
  const client = new Client({ name: 'deny-test', version: '1' });
  t.after(() => client.close());
  await client.connect(new StdioClientTransport({command:process.execPath,args:[script]}));
  const calls = [
    ['select_app',{app:'local.graviton.fixture.nonexistent.27936'}], ['list_windows',{}], ['select_window',{window_id:snapshotId}], ['get_app_state',{}],
    ['input_click',{x:5,y:10}], ['drag',{from_x:0,from_y:0,to_x:42,to_y:25}], ['scroll',{direction:'down'}],
    ['press_key',{key:'super+n'}], ['type_text',{text:'a'}], ['paste',{text:'abc',format:'md'}],
    ['select_text',{element_id:1,text:'abc'}], ['set_value',{element_id:1,value:'abc'}], ['perform_secondary_action',{element_id:1,action:'AXShowMenu'}],
  ];
  for (const [name,args] of calls) {
    const input = ['select_app','list_windows','select_window','get_app_state'].includes(name) ? args : { snapshot_id:snapshotId,...args };
    const result = await client.callTool({ name, arguments: input });
    assert.equal(result.isError,true,name);
    assert.doesNotMatch(result.content[0].text,/Unknown helper method|Invalid arguments/,name);
  }
});
