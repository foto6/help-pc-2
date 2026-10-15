#!/usr/bin/env node
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { createBrowserTabMcpServer } from '../src/browser-tab-mcp-sidecar.js';
if (process.env.PC_CONTROL_ENABLE_BROWSER_TAB_CAPTURE !== '1') throw new Error('BROWSER_CAPTURE_EXPLICIT_OPT_IN_REQUIRED');
const factory = process.env.PC_CONTROL_ENABLE_UNIVERSAL === '1'
  ? (await import('../universal/src/server.js')).createUniversalServer
  : createBrowserTabMcpServer;
const handle = serveStdio(factory, {legacy: 'serve', onerror: error => console.error('[pc-control]', error?.name || 'Error')});
process.once('SIGINT', () => handle.close().finally(() => process.exit(0)));
process.once('SIGTERM', () => handle.close().finally(() => process.exit(0)));