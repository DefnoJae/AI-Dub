const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { createServer } = require('../companion/server.cjs');
const { createEpisodeJobs, resolveInput } = require('../companion/episode-jobs.cjs');

test('episode source selection rejects unsupported paths and unsafe URLs', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-dub-source-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'episode.mkv');
  fs.writeFileSync(file, Buffer.alloc(2048));
  assert.equal(resolveInput({ type: 'file', value: file }), fs.realpathSync(file));
  assert.throws(() => resolveInput({ type: 'file', value: path.join(root, '../something.txt') }));
  assert.throws(() => resolveInput({ type: 'url', value: 'file:///etc/passwd' }));
  assert.throws(() => resolveInput({ type: 'url', value: 'http://example.org/movie.mp4' }));
  assert.throws(() => resolveInput({ type: 'url', value: 'https://user:pass@example.org/video.mp4' }));
  assert.equal(resolveInput({ type: 'url', value: 'https://example.org/video.mp4' }), 'https://example.org/video.mp4');
  assert.equal(resolveInput({ type: 'url', value: '{{SERVER_URL}}/api/v1/directstream/stream?id=abc' },
    'http://127.0.0.1:43211'),
    'http://127.0.0.1:43211/api/v1/directstream/stream?id=abc');
});

test('authenticated episode start, final report verification and private range playback', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-dub-episode-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'episode.mp4');
  fs.writeFileSync(file, Buffer.alloc(2048));
  const started = [];
  const launch = (python, args, opts) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    started.push({ python, args, opts, child });
    return child;
  };
  const token = 'a'.repeat(64), port = 49001;
  const episodes = createEpisodeJobs({ root, dataDir: root, python: 'python',
    model: '/model', voice: '/voice', port, launch });
  const server = createServer({ token, episodeJobs: episodes });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = 'http://127.0.0.1:' + server.address().port;
  const headers = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
  for (const playbackId of ['', 'x'.repeat(4097), 'episode\n3']) {
    const invalid = await fetch(base + '/episodes', { method: 'POST', headers,
      body: JSON.stringify({ playbackId, source: { type: 'file', value: file } }) });
    assert.equal(invalid.status, 400);
  }
  // Seanime streaming IDs are opaque and can include long source URLs.
  const playbackId = 'onlinestream:episode:3:https://example.org/' + 'x'.repeat(350) + '?quality=1080&audio=ja';
  const health = await (await fetch(base + '/health', { headers })).json();
  assert.equal(health.ready, false, 'offline renderer does not imply live player injection');
  assert.equal(health.experiments.fullEpisodePlayback, true);
  const start = await fetch(base + '/episodes', { method: 'POST', headers,
    body: JSON.stringify({ playbackId, source: { type: 'file', value: file } }) });
  assert.equal(start.status, 202);
  const job = await start.json();
  assert.equal(job.status, 'running');
  assert.equal(job.playbackId, playbackId);
  assert.equal(job.playbackUrl, null, 'do not expose playable URL before completion');
  assert.equal(started.length, 1);
  assert.equal(started[0].opts.shell, false);
  assert.equal(started[0].opts.env.HF_HUB_OFFLINE, '1');
  assert.equal(started[0].args[started[0].args.indexOf('--input') + 1], fs.realpathSync(file));
  assert.equal((await fetch(base + '/episodes', { method: 'POST', headers,
    body: JSON.stringify({ playbackId: 'another', source: { type: 'file', value: file } }) })).status, 409);
  const directory = started[0].args[started[0].args.indexOf('--output') + 1];
  fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory, 'episode-report.json'), '{}');
  fs.writeFileSync(path.join(directory, 'english-ai-dub.mp4'), Buffer.alloc(5000, 23));
  started[0].child.emit('close', 0);
  const ready = await (await fetch(base + '/episodes/' + job.id, { headers })).json();
  assert.equal(ready.status, 'completed');
  assert.match(ready.playbackUrl, /^http:\/\/127\.0\.0\.1:49001\/play\/[a-f0-9]{64}$/);
  const pathname = new URL(ready.playbackUrl).pathname;
  assert.equal((await fetch(base + '/play/' + 'a'.repeat(64))).status, 404);
  const video = await fetch(base + pathname, { headers: { Range: 'bytes=3-9' } });
  assert.equal(video.status, 206);
  assert.equal(video.headers.get('Content-Range'), 'bytes 3-9/5000');
  assert.equal((await video.arrayBuffer()).byteLength, 7);
  const suffix = await fetch(base + pathname, { headers: { Range: 'bytes=-6' } });
  assert.equal(suffix.status, 206);
  assert.equal(suffix.headers.get('Content-Range'), 'bytes 4994-4999/5000');
  assert.equal((await suffix.arrayBuffer()).byteLength, 6);
  const invalid = await fetch(base + pathname, { headers: { Range: 'bytes=999999-999999' } });
  assert.equal(invalid.status, 416);
  const head = await fetch(base + pathname, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('Content-Length'), '5000');
  const reused = await fetch(base + '/episodes', { method: 'POST', headers,
    body: JSON.stringify({ playbackId, source: { type: 'file', value: file } }) });
  assert.equal(reused.status, 200);
  assert.equal((await reused.json()).id, job.id);
});

test('failed process never exposes video and can be followed by retry', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-dub-fail-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'episode.mp4');
  fs.writeFileSync(file, Buffer.alloc(2048));
  const children = [];
  const launch = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    children.push(child);
    return child;
  };
  const token = 'a'.repeat(64);
  const server = createServer({ token, episodeJobs: createEpisodeJobs({
    root, dataDir: root, python: 'python', model: '/model', voice: '/voice', launch
  }) });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = 'http://127.0.0.1:' + server.address().port;
  const headers = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
  const start = await fetch(base + '/episodes', { method: 'POST', headers,
    body: JSON.stringify({ playbackId: 'failed', source: { type: 'file', value: file } }) });
  assert.equal(start.status, 202);
  const job = await start.json();
  children[0].emit('error', new Error('mock spawn error'));
  children[0].emit('close', 0);
  const failed = await (await fetch(base + '/episodes/' + job.id, { headers })).json();
  assert.equal(failed.status, 'failed');
  assert.equal(failed.playbackUrl, null);
  assert.equal((await fetch(base + '/episodes', { method: 'POST', headers,
    body: JSON.stringify({ playbackId: 'retry', source: { type: 'file', value: file } }) })).status, 202);
});
