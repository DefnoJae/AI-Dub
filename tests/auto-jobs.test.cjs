'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { createServer } = require('../companion/server.cjs');
const { createAutoJobs } = require('../companion/auto-jobs.cjs');

test('opt-in automatic clips require auth, reject traversal and launch offline processor', async t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-dub-auto-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const inbox = path.join(tmp, 'inbox');
  fs.mkdirSync(inbox, { recursive: true });
  fs.writeFileSync(path.join(inbox, 'sample.mp4'), 'mock media');
  fs.writeFileSync(path.join(inbox, 'orphan.mkv'), 'mock media');
  fs.writeFileSync(path.join(inbox, 'orphan.webm'), 'ambiguous ID');
  let invoked = 0, supplied;
  const launch = (program, args, options) => {
    invoked++;
    supplied = { program, args, options };
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    queueMicrotask(() => {
      const output = args[args.indexOf('--output') + 1];
      fs.mkdirSync(output, { recursive: true });
      fs.writeFileSync(path.join(output, 'report.json'), '{}');
      fs.writeFileSync(path.join(output, 'english-dialogue.wav'), 'RIFF');
      child.emit('close', 0);
    });
    return child;
  };
  const autoJobs = createAutoJobs({ root: tmp, dataDir: tmp, python: '/fake/python',
    model: '/fake/whisper-base', voice: '/fake/voice.onnx', launch });
  const token = 'a'.repeat(64);
  const server = createServer({ token, autoJobs });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const rootUrl = 'http://127.0.0.1:' + server.address().port;
  const headers = { Authorization: 'Bearer ' + token };
  const json = { ...headers, 'Content-Type': 'application/json' };
  assert.equal((await fetch(rootUrl + '/auto/clips')).status, 401);
  const health = await (await fetch(rootUrl + '/health', { headers })).json();
  assert.equal(health.ready, false);
  assert.equal(health.capabilities.dubbing, false);
  assert.equal(health.experiments.automaticClips, true);
  assert.equal(health.capabilities.translation, true);
  const list = await (await fetch(rootUrl + '/auto/clips', { headers })).json();
  assert.deepEqual(list.clips, ['sample']);
  for (const clip of ['../secret', 'orphan', 'missing']) {
    const res = await fetch(rootUrl + '/auto/jobs', {
      method: 'POST', headers: json, body: JSON.stringify({ clip, seconds: 20 })
    });
    assert.equal(res.status, 400);
  }
  assert.equal(invoked, 0);
  const start = await fetch(rootUrl + '/auto/jobs', {
    method: 'POST', headers: json, body: JSON.stringify({ clip: 'sample', seconds: 12 })
  });
  assert.equal(start.status, 202);
  const job = await start.json();
  assert.match(job.id, /^[a-f0-9]{32}$/);
  assert.equal(invoked, 1);
  assert.equal(supplied.options.shell, false);
  assert.equal(supplied.options.env.HF_HUB_OFFLINE, '1');
  assert.equal(supplied.args[supplied.args.indexOf('--seconds') + 1], '12');
  assert.ok(supplied.args.includes('--model'));
  await new Promise(resolve => setImmediate(resolve));
  const done = await (await fetch(rootUrl + '/auto/jobs/' + job.id, { headers })).json();
  assert.equal(done.status, 'completed');
  assert.equal(done.clip, 'sample');
  assert.equal((await fetch(rootUrl + '/auto/jobs/' + 'b'.repeat(32), { headers })).status, 404);
});

test('server without automatic local clip mode does not expose jobs or claim readiness', async t => {
  const token = 'a'.repeat(64);
  const server = createServer({ token });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const rootUrl = 'http://127.0.0.1:' + server.address().port;
  const headers = { Authorization: 'Bearer ' + token };
  const health = await (await fetch(rootUrl + '/health', { headers })).json();
  assert.equal(health.experiments.automaticClips, false);
  assert.equal(health.capabilities.transcription, false);
  assert.equal((await fetch(rootUrl + '/auto/clips', { headers })).status, 404);
});
