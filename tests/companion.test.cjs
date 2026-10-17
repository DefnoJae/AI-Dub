const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createServer, loadToken } = require('../companion/server.cjs');

test('authenticated loopback health is honest; jobs fail explicitly', async t => {
  const token = 'a'.repeat(64);
  const server = createServer({ token });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { Authorization: 'Bearer ' + token };
  assert.equal((await fetch(base + '/health')).status, 401);
  assert.equal((await fetch(base + '/health', { headers: { Authorization: 'Bearer ' + 'b'.repeat(64) } })).status, 401);
  const health = await (await fetch(base + '/health', { headers })).json();
  assert.equal(health.service, 'ai-dub-companion');
  assert.equal(health.ready, false);
  assert.ok(Object.values(health.capabilities).every(value => value === false));
  assert.equal((await fetch(base + '/health', { headers: { ...headers, Origin: 'http://evil.example' } })).status, 403);
  const rebindingStatus = await new Promise((resolve, reject) => {
    http.get(base + '/health', { headers: { ...headers, Host: 'evil.example' } }, res => {
      res.resume();
      resolve(res.statusCode);
    }).on('error', reject);
  });
  assert.equal(rebindingStatus, 403);
  assert.equal((await fetch(base + '/jobs', { method: 'POST', headers })).status, 501);
  assert.equal((await fetch(base + '/health', { method: 'POST', headers })).status, 405);
  assert.equal((await fetch(base + '/missing', { headers })).status, 404);
});

test('pairing survives restart; corrupt tokens fail closed', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-dub-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true }));
  const first = loadToken(dir);
  assert.match(first.token, /^[a-f0-9]{64}$/);
  assert.equal(loadToken(dir).token, first.token);
  fs.writeFileSync(first.file, 'bad');
  assert.throws(() => loadToken(dir), /Invalid pairing-token/);
  assert.throws(() => createServer({ token: '' }), /pairing token/);
});
