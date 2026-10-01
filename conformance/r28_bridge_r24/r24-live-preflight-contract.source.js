'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const test=require('node:test');

function source(file){return fs.readFileSync(path.join(__dirname,file),'utf8');}

test('live collector is read-only by construction',()=>{
  const code=source('r24-live-preflight.js');
  assert.match(code,/method:'GET'/);
  assert.doesNotMatch(code,/method:'POST'|method:'PUT'|method:'DELETE'/);
  assert.doesNotMatch(code,/\/json\/new/);
  assert.doesNotMatch(code,/process\.kill|taskkill|Stop-Process|Restart-Service|Start-Process/);
  assert.doesNotMatch(code,/writeFileSync\([^,]*state|renameSync|unlinkSync|copyFileSync/);
  assert.doesNotMatch(code,/assignments['"\s,)]|confirmChatLifecycle|chatgptDeleteScript/);
});

test('collector only emits summarized process/config/state/provider evidence',()=>{
  const code=source('r24-live-preflight.js');
  assert.match(code,/commandFingerprint/);
  assert.match(code,/digest:sha256\(raw\)/);
  assert.match(code,/strictStateSummary/);
  assert.doesNotMatch(code,/Authorization|Cookie|Set-Cookie|access_token|refresh_token/);
});

test('R24 package/workflow retains R23 validation and NO_LIVE_DEPLOY report',()=>{
  const pkg=JSON.parse(source('package.json'));
  const workflow=fs.readFileSync(
    path.join(__dirname,'..','.github','workflows','r24-live-preflight.yml'),'utf8');
  const report=source('r24-readiness-report.js');
  assert.equal(pkg.scripts['validate:r24'],
    'npm run validate:r23 && npm run test:r24');
  assert.match(workflow,/npm run validate:r23/);
  assert.match(workflow,/npm run test:r24/);
  assert.match(workflow,/npm test/);
  assert.match(report,/NO_LIVE_DEPLOY/);
  assert.match(report,/GITHUB_SHA/);
  assert.match(report,/GITHUB_RUN_ID/);
});
