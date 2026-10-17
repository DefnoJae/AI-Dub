'use strict';
// Opt-in local transcription -> English translation -> generic Piper synthesis.
// This pipeline processes only files manually placed in the private inbox.
// It is deliberately separate from full-episode playback and never fetches URLs.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const FILE_RE = /^([a-zA-Z0-9_-]{1,64})\.(mp4|mkv|webm|mov)$/i;
const CLIP_RE = /^[a-zA-Z0-9_-]{1,64}$/;

function createAutoJobs({ root, dataDir, python, model, voice, launch = spawn }) {
  if (!root || !dataDir || !python || !model || !voice) throw new Error('root, dataDir, python, model and voice are required');
  const inbox = path.resolve(dataDir, 'inbox');
  const jobsDir = path.resolve(dataDir, 'auto-jobs');
  fs.mkdirSync(inbox, { recursive: true });
  fs.mkdirSync(jobsDir, { recursive: true });
  let active = null;
  const jobs = new Map();

  function resolveClip(name) {
    if (typeof name !== 'string' || !CLIP_RE.test(name)) throw new Error('Invalid clip ID');
    const files = fs.readdirSync(inbox).filter(file => {
      const m = FILE_RE.exec(file);
      return m && m[1] === name;
    });
    if (files.length !== 1) throw new Error('Missing or ambiguous clip');
    const directory = fs.realpathSync(inbox);
    const candidate = fs.realpathSync(path.join(inbox, files[0]));
    const relative = path.relative(directory, candidate);
    if (!relative || relative === '..' || relative.startsWith('..' + path.sep) ||
        path.isAbsolute(relative) || !fs.statSync(candidate).isFile()) {
      throw new Error('Clip must be a regular file inside the inbox');
    }
    return candidate;
  }
  function listClips() {
    return [...new Set(fs.readdirSync(inbox).map(file => {
      const match = FILE_RE.exec(file);
      return match ? match[1] : null;
    }).filter(Boolean))].filter(name => {
      try { resolveClip(name); return true; } catch { return false; }
    }).sort();
  }
  function publicJob(job) {
    return { id: job.id, clip: job.clip, status: job.status,
      message: job.message, output: job.status === 'completed' ? job.output : null };
  }
  function handle(req, send) {
    if (req.url === '/auto/clips' && req.method === 'GET') {
      send(200, { clips: listClips() });
      return true;
    }
    const match = /^\/auto\/jobs\/([a-f0-9]{32})$/.exec(req.url || '');
    if (match && req.method === 'GET') {
      const job = jobs.get(match[1]);
      send(job ? 200 : 404, job ? publicJob(job) : { error: 'Unknown job' });
      return true;
    }
    if (req.url !== '/auto/jobs' || req.method !== 'POST') return false;
    if (active !== null) {
      send(409, { error: 'An automatic clip job is already running' });
      return true;
    }
    if (jobs.size >= 100) {
      send(429, { error: 'Job limit reached; restart the companion to clear history' });
      return true;
    }
    let body = '';
    let oversized = false;
    req.on('data', chunk => {
      if (oversized) return;
      body += chunk.toString();
      if (Buffer.byteLength(body) > 4096) {
        oversized = true;
        send(413, { error: 'Request too large' });
      }
    });
    req.on('end', () => {
      if (oversized) return;
      // Another POST can be received while this request body is streaming.
      // Re-check at commit time to enforce a single offline worker.
      if (active !== null) return send(409, { error: 'An automatic clip job is already running' });
      if (jobs.size >= 100) return send(429, { error: 'Job limit reached' });
      try {
        const params = JSON.parse(body);
        if (!params || typeof params !== 'object') throw new Error('Invalid request');
        const clip = params.clip;
        const source = resolveClip(clip);
        const start = params.start === undefined ? 0 : params.start;
        const seconds = params.seconds === undefined ? 20 : params.seconds;
        if (typeof start !== 'number' || !Number.isFinite(start) || start < 0 || start > 10800 ||
            typeof seconds !== 'number' || !Number.isFinite(seconds) ||
            seconds <= 0 || seconds > 30) throw new Error('Invalid interval');
        const id = crypto.randomBytes(16).toString('hex');
        const output = path.join(jobsDir, id);
        const job = { id, clip, output, status: 'running',
          message: 'Offline transcription, translation and synthesis in progress.' };
        const args = [path.join(root, 'companion', 'dub_clip.py'), source,
          '--start', String(start), '--seconds', String(seconds), '--output', output,
          '--model', path.resolve(model), '--voice', path.resolve(voice)];
        const child = launch(python, args, {
          cwd: root, shell: false, windowsHide: true,
          env: { ...process.env, HF_HUB_OFFLINE: '1' },
          stdio: ['ignore', 'pipe', 'pipe']
        });
        jobs.set(id, job);
        active = id;
        const log = fs.createWriteStream(path.join(jobsDir, id + '.log'), { flags: 'wx' });
        child.stdout?.pipe(log, { end: false });
        child.stderr?.pipe(log, { end: false });
        log.on('error', () => {});
        let settled = false;
        function finish(ok) {
          if (settled) return;
          settled = true;
          const report = path.join(output, 'report.json');
          const wav = path.join(output, 'english-dialogue.wav');
          const completed = ok && fs.existsSync(report) && fs.existsSync(wav);
          job.status = completed ? 'completed' : 'failed';
          job.message = completed ?
            'Generic English dialogue WAV generated. Human timing/translation review required.' :
            'Local clip generation failed; inspect the companion job log.';
          if (active === id) active = null;
          log.end();
        }
        child.on('error', () => finish(false));
        child.on('close', code => finish(code === 0));
        send(202, publicJob(job));
      } catch {
        send(400, { error: 'Invalid request or missing prepared clip' });
      }
    });
    return true;
  }
  return { handle, listClips };
}
module.exports = { createAutoJobs };
