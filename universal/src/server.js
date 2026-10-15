import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const python = process.env.PC_CONTROL_PYTHON || 'C:\\Users\\foto6\\AppData\\Local\\Programs\\Python\\Python312\\python.exe';
const id = z.string().regex(/^[A-Za-z0-9._-]{8,120}$/);
const snapshot = z.string().regex(/^[a-f0-9]{32}$/);
const hwnd = z.number().int().positive();
const path = z.string().min(3).max(2000);
const bound = { request_id: id, snapshot_id: snapshot };
const schemas = {
  'pc.health': [{}, 'Check this PC, available actions and the owner pause switch.'],
  'window.list': [{}, 'List visible windows with exact HWND/PID identities and the foreground window.'],
  'window.observe': [{hwnd}, 'Read bounded UI Automation elements of one chosen window. Returns a fresh snapshot_id and element indices; password values are omitted.'],
  'screen.capture': [{scope: z.enum(['window', 'desktop']).default('window'), hwnd: hwnd.optional(), return_image: z.boolean().default(true)}, 'Return a real PNG image of the requested window or explicitly requested desktop. Window capture uses PrintWindow without changing focus; some apps cannot be captured this way. Image origin and scaling are returned.'],
  'window.activate': [bound, 'Activate the exact observed window. Requires a current snapshot. This may interrupt the owner.'],
  'ui.set_text': [{...bound, index: z.number().int().nonnegative(), text: z.string().max(12000), replace_existing: z.boolean().default(false)}, 'Set literal Unicode text in an observed editable control through UI Automation, then verify its value. Existing text is preserved unless replace_existing is explicitly true. Does not press Enter.'],
  'ui.invoke': [{...bound, index: z.number().int().nonnegative()}, 'Invoke one observed button or default action through native UI Automation. Observe afterward to verify the application result. Send communications only within the user-authorized recipient and task.'],
  'ui.click': [{...bound, x: z.number().int(), y: z.number().int(), button: z.enum(['left', 'right', 'middle']).default('left')}, 'Click physical screen coordinates inside the observed foreground window. Observe or capture first. Refuses changed windows, sensitive focus or points outside the window.'],
  'ui.keys': [{...bound, keys: z.array(z.string().min(1).max(30)).min(1).max(4)}, 'Press one key or a simultaneous shortcut in the exact observed foreground window. Refuses sensitive focus.'],
  'ui.scroll': [{...bound, clicks: z.number().int().min(-12).max(12).refine(v => v !== 0)}, 'Scroll at the current pointer inside the observed foreground window. Refuses points outside that window.'],
  'process.start': [{request_id: id, executable: path, args: z.array(z.string().max(16000)).max(80).default([]), cwd: path.optional(), hidden: z.boolean().default(true)}, 'Launch an existing absolute .exe path with an argument array, without shell interpolation. Returns PID and process creation time.'],
  'shell.run': [{request_id: id, argv: z.array(z.string().max(32000)).min(1).max(80), cwd: path.optional(), timeout_seconds: z.number().int().min(1).max(25).default(20)}, 'Run a bounded command through the existing PC Executor safety adapter and durable outcome journal. Use argv arrays and appropriate shell quoting. Never read credentials or protected paths. No automatic replay after uncertainty.'],
  'file.list': [{path}, 'List at most 200 entries in an authorized local directory, without recursion.'],
  'file.read': [{path}, 'Read an authorized UTF-8 text file up to 64 KiB with its SHA-256. Never request credential or session files.'],
  'file.write': [{request_id: id, path, text: z.string().max(65536), mode: z.enum(['replace', 'append']).default('replace'), expected_sha256: z.string().regex(/^[a-f0-9]{64}$/).optional()}, 'Create, replace or append UTF-8 text up to 64 KiB. An existing file requires its current expected_sha256. Identical request_id/payload returns its durable result without a second write.'],
  'process.list': [{}, 'List bounded PID, name and creation time, without command lines or environment variables.'],
  'action.outcome': [{request_id: id}, 'Look up the durable outcome of an earlier mutation. A started or unknown result requires reconciliation; never resubmit as a new action.'],
};

export function worker(request) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(python, ['-X', 'utf8', resolve(root, 'runtime/pc_control.py')], {
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '', size = 0, finished = false;
    const finish = (error, value) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      error ? reject(error) : resolvePromise(value);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error('WORKER_TIMEOUT_LOOK_UP_ORIGINAL_REQUEST_ID'));
    }, 35000);
    child.stdout.on('data', chunk => {
      size += chunk.length;
      if (size > 10 * 1024 * 1024) {
        child.kill();
        finish(new Error('WORKER_OUTPUT_LIMIT_LOOK_UP_ORIGINAL_REQUEST_ID'));
      } else output += chunk.toString('utf8');
    });
    child.stderr.on('data', () => {});
    child.on('error', () => finish(new Error('WORKER_START_FAILED')));
    child.on('close', code => {
      if (code !== 0) return finish(new Error('WORKER_EXIT_LOOK_UP_ORIGINAL_REQUEST_ID'));
      try { finish(null, JSON.parse(output)); }
      catch { finish(new Error('WORKER_INVALID_RESPONSE_LOOK_UP_ORIGINAL_REQUEST_ID')); }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(request));
  });
}

export function mediaResult(result) {
  const image = result?.data?.image_base64;
  const data = {...result, data: result?.data ? {...result.data} : result?.data};
  if (data.data) delete data.data.image_base64;
  const content = [{type: 'text', text: JSON.stringify(data)}];
  if (image) content.push({type: 'image', mimeType: 'image/png', data: image});
  return {content, isError: result.ok !== true};
}

export function registerUniversalTools(server, run = worker) {
  for (const [action, [fields, description]] of Object.entries(schemas)) {
    const mutation = Boolean(fields.request_id) && action !== 'action.outcome';
    server.registerTool(action, {
      description, inputSchema: z.object(fields).strict(),
      annotations: {readOnlyHint: !mutation, destructiveHint: mutation,
        idempotentHint: true, openWorldHint: mutation},
      _meta: {'pc.control/transport': 'local_windows', 'pc.control/durable_ids': mutation,
        'pc.control/automatic_replay': false, 'pc.control/pixels_to_github': false},
    }, async args => {
      const {snapshot_id, request_id, ...params} = args;
      const request = {action, params};
      if (snapshot_id) request.snapshot_id = snapshot_id;
      if (request_id && action !== 'action.outcome') request.request_id = request_id;
      if (action === 'action.outcome') request.params.request_id = request_id;
      try { return mediaResult(await run(request)); }
      catch (error) {
        return {isError: true, content: [{type: 'text', text: JSON.stringify({ok: false,
          status: mutation ? 'needs_reconciliation' : 'error', request_id,
          error: error.message, automatic_replay: false})}]};
      }
    });
  }
  return Object.keys(schemas);
}

export async function createUniversalServer() {
  const server = new McpServer({name: 'pc-control-universal', version: '0.4.0'}, {capabilities: {tools: {}}});
  registerUniversalTools(server);
  if (process.env.PC_CONTROL_ENABLE_BROWSER_TAB_CAPTURE === '1') {
    const source = process.env.PC_CONTROL_CHROME_MODULE || 'E:\\PC-Control\\BrowserTabMCP-Canary-20261009\\src\\browser-tab-mcp-sidecar.js';
    const {registerBrowserTabTools} = await import(pathToFileURL(source).href);
    registerBrowserTabTools(server);
  }
  return server;
}
