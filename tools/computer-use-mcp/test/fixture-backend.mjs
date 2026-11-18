import { createInterface } from 'node:readline';

const snapshotId = '74d9edd7-4093-4f4b-b7fd-1985cfcf2d67';
let active = false;
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  let result;
  switch (request.method) {
    case 'status': result = { text: 'fixture ready' }; break;
    case 'inspect_window':
      active = true;
      result = { text: `snapshot_id: ${snapshotId}\n1. AXTextArea`, ...(request.screenshot && { jpeg: '/9j/2Q==' }) };
      break;
    case 'set_text':
      result = active && request.snapshotId === snapshotId && request.elementId === 1
        ? { text: `fixture set ${request.text}` }
        : { error: 'stale snapshot' };
      active = false;
      break;
    case 'click':
      // Slow action: lets the parent exercise the cancellation/timeout path.
      await new Promise(resolve => setTimeout(resolve, 10_000));
      result = { text: 'fixture click' };
      break;
    default: result = { error: 'unknown method' };
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
