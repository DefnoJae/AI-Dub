const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough, Readable } = require('node:stream');
const { createQualityJobs } = require('../companion/quality-jobs.cjs');

test('quality jobs confine inputs, serialize work, and require a completed report', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-dub-quality-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  let child, launchArgs;
  const manager = createQualityJobs({ root: dataDir, python: 'python', dataDir,
    launch(...args) { launchArgs = args; child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); return child; } });
  fs.writeFileSync(path.join(dataDir, 'inbox', 'example.mp4'), 'fixture');
  fs.writeFileSync(path.join(dataDir, 'inbox', 'example.json'), '{}');
  async function request(url, method = 'GET', body) {
    const req = Readable.from(body === undefined ? [] : [JSON.stringify(body)]);
    req.url = url; req.method = method;
    return new Promise(resolve => { assert.equal(manager.handle(req, (status, data) => resolve({ status, data })), true); });
  }
  assert.deepEqual((await request('/quality/clips')).data.clips, ['example']);
  assert.equal((await request('/quality/jobs', 'POST', { clip: '../example' })).status, 400);
  assert.equal((await request('/quality/jobs', 'POST', { clip: 'example', seconds: 31 })).status, 400);
  const first = await request('/quality/jobs', 'POST', { clip: 'example', seconds: 10 });
  assert.equal(first.status, 202);
  assert.equal(launchArgs[2].shell, false);
  assert.equal(launchArgs[2].windowsHide, true);
  assert.equal((await request('/quality/jobs', 'POST', { clip: 'example' })).status, 409);
  child.emit('close', 0);
  assert.equal((await request('/quality/jobs/' + first.data.id)).data.status, 'failed');
  const second = await request('/quality/jobs', 'POST', { clip: 'example' });
  const output = path.join(dataDir, 'quality-jobs', second.data.id);
  fs.mkdirSync(output);
  fs.writeFileSync(path.join(output, 'quality-report.json'), '{}');
  child.emit('close', 0);
  assert.equal((await request('/quality/jobs/' + second.data.id)).data.status, 'completed');
  await new Promise(resolve => setTimeout(resolve, 30));
});

test('a late close after spawn error cannot clear a newer job', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-dub-quality-race-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const children = [];
  const manager = createQualityJobs({ root: dataDir, python: 'python', dataDir,
    launch() {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      children.push(child);
      return child;
    } });
  fs.writeFileSync(path.join(dataDir, 'inbox', 'example.mp4'), 'fixture');
  fs.writeFileSync(path.join(dataDir, 'inbox', 'example.json'), '{}');
  function request(url, method = 'GET', body) {
    const req = Readable.from(body === undefined ? [] : [JSON.stringify(body)]);
    req.url = url; req.method = method;
    return new Promise(resolve => manager.handle(req, (status, data) => resolve({ status, data })));
  }
  const first = await request('/quality/jobs', 'POST', { clip: 'example' });
  assert.equal(first.status, 202);
  children[0].emit('error', new Error('spawn failed'));
  assert.equal((await request('/quality/jobs/' + first.data.id)).data.status, 'failed');
  const second = await request('/quality/jobs', 'POST', { clip: 'example' });
  assert.equal(second.status, 202);
  children[0].emit('close', -1);
  assert.equal((await request('/quality/jobs', 'POST', { clip: 'example' })).status, 409);
  assert.equal((await request('/quality/jobs/' + first.data.id)).data.message,
    'Could not start local engine. Check Python configuration.');
  children[1].emit('close', 1);
  await new Promise(resolve => setTimeout(resolve, 30));
});
