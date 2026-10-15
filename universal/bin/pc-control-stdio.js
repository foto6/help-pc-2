#!/usr/bin/env node
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { createUniversalServer } from '../src/server.js';

if (process.env.PC_CONTROL_ENABLE_UNIVERSAL !== '1') throw new Error('PC_CONTROL_ENABLE_UNIVERSAL_REQUIRED');
const handle = serveStdio(() => createUniversalServer(), {
  legacy: 'serve', onerror: error => console.error('[pc-control]', error?.name || 'Error'),
});
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  try { await handle.close(); } catch {}
}
process.once('SIGINT', () => close().finally(() => process.exit(0)));
process.once('SIGTERM', () => close().finally(() => process.exit(0)));
