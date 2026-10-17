'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const MEDIA_EXTS = new Set(['.mp4', '.mkv', '.webm', '.mov', '.avi', '.m4v']);

function resolveInput(source, seanimeBaseUrl) {
  if (!source || typeof source !== 'object' || typeof source.value !== 'string') {
    throw new Error('Missing episode source');
  }
  if (source.type === 'file') {
    if (!path.isAbsolute(source.value) || source.value.length > 2048 ||
        !MEDIA_EXTS.has(path.extname(source.value).toLowerCase())) {
      throw new Error('Expected a supported absolute video file path');
    }
    const absolute = fs.realpathSync(source.value);
    const file = fs.statSync(absolute);
    if (!file.isFile() || file.size < 1000 || file.size > 35 * 1024 ** 3) {
      throw new Error('Video file missing or outside accepted size');
    }
    return absolute;
  }
  if (source.type !== 'url') throw new Error('Unsupported episode source');
  let raw = source.value;
  if (raw.startsWith('{{SERVER_URL}}/')) {
    if (!/^http:\/\/127\.0\.0\.1:\d{2,5}$/.test(seanimeBaseUrl)) {
      throw new Error('Seanime loopback server URL must be configured');
    }
    raw = seanimeBaseUrl + raw.slice('{{SERVER_URL}}'.length);
  }
  if (raw.length > 4096) throw new Error('Episode stream URL too long');
  const url = new URL(raw);
  if (url.username || url.password || url.hash || !['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Unsupported episode stream URL');
  }
  if (url.protocol === 'http:' && url.hostname !== '127.0.0.1') {
    throw new Error('Plain HTTP streams are accepted only from loopback');
  }
  if (url.hostname === 'localhost' || url.hostname === '::1') {
    throw new Error('Use 127.0.0.1 for local playback');
  }
  return url.toString();
}

function createEpisodeJobs({ root, dataDir, python, model, voice, port = 43123,
                             seanimeBaseUrl = 'http://127.0.0.1:43211', launch = spawn }) {
  if (![root, dataDir, python, model, voice].every(Boolean)) throw new Error('Incomplete episode job configuration');
  const folder = path.resolve(dataDir, 'episode-jobs');
  fs.mkdirSync(folder, { recursive: true });
  const jobs = new Map();
  const access = new Map();
  let active = null;

  const present = job => ({
    id: job.id, status: job.status, stage: job.stage,
    playbackId: job.playbackId,
    playbackUrl: job.status === 'completed' ? job.playbackUrl : null,
    playbackFile: job.status === 'completed' ? job.playbackFile : null
  });

  function start(params, send) {
    if (!params || typeof params !== 'object' ||
        typeof params.playbackId !== 'string' ||
        !/^[\w-]{1,100}$/.test(params.playbackId)) {
      return send(400, { error: 'Invalid playback identifier' });
    }
    const old = [...jobs.values()].find(j => j.playbackId === params.playbackId && j.status === 'completed');
    if (old) return send(200, present(old));
    if (active !== null) return send(409, { error: 'An episode is already being rendered' });
    if (jobs.size >= 40) return send(429, { error: 'Too many jobs this session' });

    let source;
    try { source = resolveInput(params.source, seanimeBaseUrl); }
    catch (error) { return send(400, { error: error.message }); }

    const id = crypto.randomBytes(16).toString('hex');
    const playbackKey = crypto.randomBytes(32).toString('hex');
    const output = path.join(folder, id);
    const playbackFile = path.join(output, 'english-ai-dub.mp4');
    const playbackUrl = 'http://127.0.0.1:' + port + '/play/' + playbackKey;
    const job = { id, playbackId: params.playbackId, status: 'running',
      stage: 'Starting local processing', output, playbackFile, playbackUrl };
    const args = [path.join(root, 'companion', 'episode_dub.py'),
      '--input', source, '--output', output, '--model', model, '--voice', voice];
    let child;
    try {
      child = launch(python, args, { cwd: root, shell: false, windowsHide: true,
        env: { ...process.env, HF_HUB_OFFLINE: '1' },
        stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      return send(500, { error: 'Failed to launch offline engine' });
    }
    jobs.set(id, job);
    active = id;
    const log = fs.createWriteStream(path.join(folder, id + '.log'), { flags: 'wx' });
    log.on('error', () => {});
    let buffer = '';
    child.stdout?.on('data', chunk => {
      log.write(chunk);
      buffer = (buffer + chunk.toString('utf8')).slice(-8192);
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (line.startsWith('STAGE: ')) job.stage = line.slice(7).slice(0, 140);
        else if (line.startsWith('SEGMENTS: ')) job.stage = 'Synthesized ' + line.slice(10).trim() + ' segments';
      }
    });
    child.stderr?.on('data', chunk => log.write(chunk));
    let finished = false;
    function finish(ok) {
      if (finished) return;
      finished = true;
      const report = path.join(output, 'episode-report.json');
      const isReady = ok && fs.existsSync(playbackFile) && fs.existsSync(report) &&
        fs.statSync(playbackFile).size > 1000;
      job.status = isReady ? 'completed' : 'failed';
      job.stage = isReady ? 'Dubbed episode ready; Japanese and English tracks available' :
        'Episode processing failed; inspect the local .log file';
      if (isReady) access.set(playbackKey, job);
      if (active === id) active = null;
      log.end();
    }
    child.on('error', () => finish(false));
    child.on('close', code => finish(code === 0));
    send(202, present(job));
  }

  function handle(req, send) {
    if (/^\/episodes\/[a-f0-9]{32}$/.test(req.url || '') && req.method === 'GET') {
      const id = req.url.split('/')[2];
      const job = jobs.get(id);
      send(job ? 200 : 404, job ? present(job) : { error: 'Unknown episode job' });
      return true;
    }
    if (req.url !== '/episodes' || req.method !== 'POST') return false;
    let text = '', oversized = false;
    req.on('data', chunk => {
      if (oversized) return;
      text += chunk.toString('utf8');
      if (Buffer.byteLength(text) > 8192) {
        oversized = true;
        send(413, { error: 'Episode request too large' });
      }
    });
    req.on('end', () => {
      if (oversized) return;
      if (active !== null) return send(409, { error: 'An episode is already being rendered' });
      try { start(JSON.parse(text), send); }
      catch { send(400, { error: 'Invalid episode request' }); }
    });
    return true;
  }

  function serve(req, res) {
    const m = /^\/play\/([a-f0-9]{64})$/.exec(req.url || '');
    if (!m) return false;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' });
      res.end(); return true;
    }
    const job = access.get(m[1]);
    if (!job || job.status !== 'completed') {
      res.writeHead(404); res.end(); return true;
    }
    const size = fs.statSync(job.playbackFile).size;
    const range = req.headers.range;
    let start = 0, end = size - 1, status = 200;
    if (range !== undefined) {
      const match = /^bytes=(\d+)-(\d*)$/.exec(range);
      if (!match) {
        res.writeHead(416, { 'Content-Range': 'bytes */' + size });
        res.end(); return true;
      }
      start = Number(match[1]);
      end = match[2] ? Number(match[2]) : end;
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) {
        res.writeHead(416, { 'Content-Range': 'bytes */' + size });
        res.end(); return true;
      }
      end = Math.min(end, size - 1);
      status = 206;
    }
    const headers = { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1, 'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff' };
    if (status === 206) headers['Content-Range'] = 'bytes ' + start + '-' + end + '/' + size;
    res.writeHead(status, headers);
    if (req.method === 'HEAD') res.end();
    else {
      const stream = fs.createReadStream(job.playbackFile, { start, end });
      stream.on('error', () => res.destroy());
      stream.pipe(res);
    }
    return true;
  }
  return { handle, serve, resolveInput, present };
}

module.exports = { createEpisodeJobs, resolveInput };
