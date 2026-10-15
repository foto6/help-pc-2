import test from 'node:test';
import assert from 'node:assert/strict';
import {registerUniversalTools, mediaResult} from '../src/server.js';

function registry(run) {
  const tools = new Map();
  registerUniversalTools({registerTool(name, definition, call) {tools.set(name, {definition, call});}}, run);
  return tools;
}
test('all 17 tools expose explicit strict schemas and coherent effects', () => {
  const tools = registry();
  assert.equal(tools.size, 17);
  for (const [name, {definition}] of tools) {
    assert.equal(definition.inputSchema.safeParse({unexpected: 1}).success, false);
    assert.equal(definition._meta['pc.control/automatic_replay'], false);
    if (name === 'ui.set_text') assert.equal(definition.annotations.readOnlyHint, false);
  }
});
test('mutation identity and snapshot reach worker unchanged', async () => {
  let actual;
  const tools = registry(async r => {actual = r; return {ok: true, data: {}};});
  await tools.get('ui.set_text').call({request_id: 'literal-test-001', snapshot_id: 'a'.repeat(32), index: 2, text: 'Привет {Enter} 😀\nстрока'});
  assert.equal(actual.request_id, 'literal-test-001');
  assert.equal(actual.params.text, 'Привет {Enter} 😀\nстрока');
  assert.equal(actual.snapshot_id, 'a'.repeat(32));
});
test('native image content is returned without duplicating base64 in text', () => {
  const result = mediaResult({ok: true, data: {image_base64: 'YWJj', image_size: [3, 2]}});
  assert.equal(result.content[1].type, 'image');
  assert.equal(result.content[1].mimeType, 'image/png');
  assert.equal(result.content[0].text.includes('YWJj'), false);
});
test('uncertain worker failure retains request ID and forbids replay', async () => {
  const tools = registry(async () => {throw new Error('WORKER_TIMEOUT');});
  const result = await tools.get('process.start').call({request_id: 'launch-test-001', executable: 'C:\\test.exe'});
  const data = JSON.parse(result.content[0].text);
  assert.equal(data.status, 'needs_reconciliation');
  assert.equal(data.request_id, 'launch-test-001');
  assert.equal(data.automatic_replay, false);
});
test('read-only outcome queries keep the original ID as a parameter', async () => {
  let request;
  const tools = registry(async r => {request = r; return {ok: true, data: {state: 'unknown'}};});
  await tools.get('action.outcome').call({request_id: 'original-send-001'});
  assert.deepEqual(request, {action: 'action.outcome', params: {request_id: 'original-send-001'}});
});
