import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
const client = new Client({name:'package-smoke',version:'1'});
try {
  await client.connect(new StdioClientTransport({command: resolve(process.argv[2]), args: [], cwd:'/tmp', env:{PATH:'/usr/bin:/bin'}}));
  const catalog = await client.listTools();
  assert.equal(catalog.tools.length,19);
  const out = await client.callTool({name:'status',arguments:{}});
  assert.notEqual(out.isError,true); assert.match(out.content[0].text,/No app selected|Computer Use stopped/);
  const blocked = await client.callTool({name:'inspect_window',arguments:{}});
  assert.equal(blocked.isError,true); assert.match(blocked.content[0].text,/Select an app/);
  console.log('Packaged MCP handshake, 19 tools, native status and unapproved-window denial passed.');
} finally { await client.close(); }
