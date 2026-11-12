const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { waitForAuthorizationCode, writePrivateJson } = require('../dist/oauth-security');

test('wrong state/path cannot complete login; valid callback succeeds', async () => {
  let ready; const listening = new Promise(resolve => ready = resolve);
  const pending = waitForAuthorizationCode('http://127.0.0.1:0/callback', 'synthetic-state', ready);
  const url = await listening;
  assert.equal((await fetch(url + '?code=attacker&state=wrong')).status, 400);
  assert.equal((await fetch(url.replace('/callback', '/other') + '?code=x&state=synthetic-state')).status, 400);
  assert.equal((await fetch(url + '?code=valid&state=synthetic-state')).status, 200);
  assert.equal(await pending, 'valid');
});
test('callback errors are plain text and never reflected', async () => {
  let ready; const listening = new Promise(resolve => ready = resolve);
  const pending = waitForAuthorizationCode('http://127.0.0.1:0/callback', 'synthetic-state', ready);
  const rejected = assert.rejects(pending, /Authorization failed/);
  const res = await fetch((await listening) + '?error=%3Cscript%3Ebad%3C/script%3E&state=synthetic-state');
  assert.match(res.headers.get('content-type'), /^text\/plain/);
  assert.doesNotMatch(await res.text(), /script/);
  await rejected;
});
test('pending login expires', async () => {
  await assert.rejects(waitForAuthorizationCode('http://127.0.0.1:0/callback', 'state', undefined, 20), /timed out/);
});
test('credential creation and refresh remain owner-only', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oauth-test-'));
  try {
    const file = path.join(dir, 'token.json'); writePrivateJson(file, { token: 'synthetic' });
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    fs.chmodSync(file, 0o644); writePrivateJson(file, { token: 'refreshed' });
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(JSON.parse(fs.readFileSync(file)).token, 'refreshed');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
