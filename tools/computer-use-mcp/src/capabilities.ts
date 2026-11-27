import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { DesktopRequest } from './backend.js';

const app = z.string().trim().min(1).max(1024);
const snapshot = { snapshot_id: z.uuid() };
const el = z.int().min(1).max(120);
const point = z.number().min(0).max(16384);
const text = z.string().max(4000);
const duration = z.number().min(0).max(2).optional().describe('Hold time in seconds (0–2).');
const modifiers = z.string().max(64).optional().describe('Modifier chord, e.g. super+shift.');

export function registerMacCapabilities(server: McpServer, run: (req: DesktopRequest, signal: AbortSignal) => Promise<CallToolResult>) {
  // Use shared wire names for these tools; legacy v1 calls remain available.
  function add(method: DesktopRequest['method'], description: string, shape: z.ZodRawShape) {
    server.registerTool(method, { description, inputSchema: z.strictObject(shape) }, (args, { signal }) =>
      run({ method, ...args } as DesktopRequest, signal));
  }
  add('list_apps', 'List installed and running apps without inspecting their windows.', {});
  add('select_app', 'Select by name, bundle ID or absolute .app path; asks the local user before launch or first access.', { app });
  add('request_permissions', 'Open the macOS permission flow on explicit user request.', { permission: z.enum(['accessibility', 'screen_recording']) });
  add('list_windows', 'List windows of the selected approved app.', {});
  add('select_window', 'Focus a window from the last list_windows result.', { window_id: z.uuid() });
  add('get_app_state', 'Inspect the selected app or request access to another. Screenshot is optional. Use disableDiff for a full tree. Use fresh snapshot IDs for all actions.', { app: app.optional(), screenshot: z.boolean().optional(), disableDiff: z.boolean().optional() });
  add('input_click', 'Click a screenshot point or an indexed control. Coordinates use the returned screenshot pixels.', { ...snapshot, element_id: el.optional(), x: point.optional(), y: point.optional(), mouse_button: z.enum(['left','right','middle']).optional(), click_count: z.int().min(1).max(3).optional(), key: modifiers, duration });
  add('drag', 'Drag between two positions in the last screenshot.', { ...snapshot, from_x: point, from_y: point, to_x: point, to_y: point });
  add('scroll', 'Scroll at an indexed element or a screenshot point.', { ...snapshot, element_id: el.optional(), x: point.optional(), y: point.optional(), direction: z.enum(['up','down','left','right']), pages: z.int().min(1).max(10).optional() });
  add('press_key', 'Send a key chord to the selected app, e.g. super+n, Return or super+shift+Left.', { ...snapshot, key: z.string().min(1).max(80), duration });
  add('type_text', 'Type Unicode text into the selected app’s focused control.', { ...snapshot, text });
  add('paste', 'Paste text, Markdown or HTML and restore the prior pasteboard if unchanged.', { ...snapshot, text, format: z.enum(['text','md','html']) });
  add('select_text', 'Select exact text or position the cursor. Supply prefix/suffix to disambiguate.', { ...snapshot, element_id: el, text: text.min(1), prefix: text.optional(), suffix: text.optional(), selection_type: z.enum(['text','cursor_before','cursor_after']).optional() });
  add('perform_secondary_action', 'Invoke an AX action listed for the indexed element.', { ...snapshot, element_id: el, action: z.string().min(1).max(120) });
  add('set_value', 'Replace the value of a writable text field or text area.', { ...snapshot, element_id: el, value: text });
}
