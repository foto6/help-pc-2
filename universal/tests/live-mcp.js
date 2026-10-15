import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
import {randomUUID, createHash} from 'node:crypto';
import {readFile, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';

const root = resolve(import.meta.dirname, '..');
const client = new Client({name: 'pc-control-live-verifier', version: '0.4.0'}, {capabilities: {}});
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['E:/PC-Control/BrowserTabMCP-Canary-20261009/bin/pc-browser-tab-mcp-stdio.js'],
  env: {...process.env, PC_CONTROL_ENABLE_UNIVERSAL: '1', PC_CONTROL_ENABLE_BROWSER_TAB_CAPTURE: '1', PC_CONTROL_BROWSER_CDP_ALLOWED_PORTS: '17410,17447'},
  stderr: 'pipe',
});
const prefix = 'live-' + randomUUID();
async function call(name, args = {}) {
  const result = await client.callTool({name, arguments: args});
  const data = JSON.parse(result.content.find(c => c.type === 'text').text);
  if (!data.ok) throw new Error(name + ': ' + JSON.stringify(data));
  return {result, data: data.data, response: data};
}
try {
  await client.connect(transport);
  const listed = await client.listTools();
  if (listed.tools.length !== 19) throw new Error('Expected 19 tools');
  const health = await call('pc.health');
  const launch = await call('process.start', {request_id: prefix + '-launch',
    executable: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    args: ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', resolve(root, 'tests/fixture-window.ps1')]});
  let window;
  for (let i = 0; i < 10; i++) {
    const windows = await call('window.list');
    window = windows.data.windows.find(w => w.pid === launch.data.pid && w.title === 'PC Control Universal Test');
    if (window) break;
    await new Promise(r => setTimeout(r, 250));
  }
  if (!window) throw new Error('Fixture window not found');
  const observation = await call('window.observe', {hwnd: window.hwnd});
  const editor = observation.data.nodes.find(n => n.name === 'PcControlTestInput' && n.role === 'EditControl');
  if (!editor) throw new Error('Fixture editor not found');
  const literal = 'Привет {Enter} 😀\r\nПроверка нашего MCP';
  await call('ui.set_text', {request_id: prefix + '-text', snapshot_id: observation.data.snapshot_id, index: editor.index, text: literal});
  const afterText = await call('window.observe', {hwnd: window.hwnd});
  const button = afterText.data.nodes.find(n => n.name === 'PcControlTestButton');
  if (!button) throw new Error('Fixture button not found');
  const invoke = {request_id: prefix + '-button', snapshot_id: afterText.data.snapshot_id, index: button.index};
  await call('ui.invoke', invoke);
  const duplicate = await call('ui.invoke', invoke);
  if (duplicate.response.duplicate !== true) throw new Error('Missing durable duplicate result');
  const fixture = JSON.parse(await readFile(resolve(root, 'state/fixture-result.json'), 'utf8'));
  if (fixture.clicks !== 1 || fixture.text !== literal) throw new Error('Fixture effect mismatch');
  const image = await call('screen.capture', {scope: 'window', hwnd: window.hwnd});
  const pixels = image.result.content.find(c => c.type === 'image');
  if (!pixels || createHash('sha256').update(Buffer.from(pixels.data, 'base64')).digest('hex') !== image.data.sha256) throw new Error('Image evidence invalid');
  const shell = await call('shell.run', {request_id: prefix + '-shell', argv: ['powershell.exe','-NoProfile','-Command','Write-Output pc-control-shell-ok'], timeout_seconds: 10});
  if (!shell.data.stdout.includes('pc-control-shell-ok')) throw new Error('Shell mismatch');
  const fixtureFile = resolve(root, 'state', prefix + '.txt');
  const write = {request_id: prefix + '-file', path: fixtureFile, text: 'one\n', mode: 'append'};
  await call('file.write', write);
  await call('file.write', write);
  const file = await call('file.read', {path: fixtureFile});
  if (file.data.text !== 'one\n') throw new Error('Duplicate physical append');
  const evidence = {version: health.data.version, tool_count: listed.tools.length,
    retained_chrome_tools: listed.tools.filter(t => t.name.startsWith('browser.tab.')).map(t => t.name),
    program_launch: true, literal_unicode_text: true, button_clicks: fixture.clicks,
    duplicate_did_not_replay: true, image_content_verified: true, image_path: image.data.image_path,
    image_size: image.data.image_size, shell_command: true, file_append_once: true,
    fixture_pid: launch.data.pid, fixture_hwnd: window.hwnd, timestamp: new Date().toISOString(),
    transport_verified: 'real local MCP stdio through existing tunnel entrypoint', remote_tunnel_verified: false};
  await writeFile(resolve(root, 'verification.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence));
} finally {
  await client.close();
}
