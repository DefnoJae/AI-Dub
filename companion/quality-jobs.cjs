'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

function createQualityJobs({ root, python, dataDir, launch = spawn }) {
  const inbox = path.resolve(dataDir, 'inbox');
  const jobsDir = path.resolve(dataDir, 'quality-jobs');
  fs.mkdirSync(inbox, { recursive: true });
  fs.mkdirSync(jobsDir, { recursive: true });
  const jobs = new Map();
  let active = null;
  function inside(file, parent) {
    const relative = path.relative(fs.realpathSync(parent), fs.realpathSync(file));
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Invalid inbox path');
    return fs.realpathSync(file);
  }
  function files(clip) {
    if (typeof clip !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(clip)) throw new Error('Invalid clip identifier');
    return { input: inside(path.join(inbox, clip + '.mp4'), inbox),
      script: inside(path.join(inbox, clip + '.json'), inbox) };
  }
  const publicJob = job => ({ id: job.id, clip: job.clip, status: job.status,
    message: job.message, output: job.status === 'completed' ? job.output : null });
  return {
    handle(req, send) {
      if (req.url === '/quality/clips' && req.method === 'GET') {
        const clips = fs.readdirSync(inbox).filter(name => /^[a-zA-Z0-9_-]{1,64}\.mp4$/.test(name))
          .map(name => name.slice(0, -4)).filter(clip => { try { files(clip); return true; } catch { return false; } });
        send(200, { clips });
        return true;
      }
      const match = /^\/quality\/jobs\/([a-f0-9]{32})$/.exec(req.url || '');
      if (match && req.method === 'GET') {
        const job = jobs.get(match[1]);
        send(job ? 200 : 404, job ? publicJob(job) : { error: 'Unknown job' });
        return true;
      }
      if (req.url !== '/quality/jobs' || req.method !== 'POST') return false;
      let body = '', oversized = false;
      req.on('data', chunk => {
        if (oversized) return;
        body += chunk;
        if (Buffer.byteLength(body) > 4096) { oversized = true; send(413, { error: 'Request too large' }); }
      });
      req.on('end', () => {
        if (oversized) return;
        if (active) return send(409, { error: 'A quality job is already running' });
        if (jobs.size >= 100) return send(429, { error: 'Restart companion to clear completed job history' });
        try {
          const request = JSON.parse(body);
          const source = files(request.clip);
          const seconds = request.seconds === undefined ? 20 : request.seconds;
          if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0 || seconds > 30) {
            return send(400, { error: 'Select 0–30 seconds' });
          }
          const id = crypto.randomBytes(16).toString('hex');
          const output = path.join(jobsDir, id);
          const job = { id, clip: request.clip, status: 'running', output, message: 'Local CPU processing. This can take several minutes.' };
          const child = launch(python, [path.join(root, 'companion', 'quality_clip.py'), source.input,
            '--script', source.script, '--output', output, '--seconds', String(seconds)], {
            cwd: root, windowsHide: true, shell: false, env: { ...process.env, HF_HUB_OFFLINE: '1' },
            stdio: ['ignore', 'pipe', 'pipe']
          });
          jobs.set(id, job);
          active = id;
          const log = fs.createWriteStream(path.join(jobsDir, id + '.log'), { flags: 'wx' });
          child.stdout.pipe(log, { end: false });
          child.stderr.pipe(log, { end: false });
          log.on('error', () => {});
          let finalized = false;
          function finish(status, message) {
            // Both 'error' and 'close' can fire for one child. Never let a stale
            // callback clear a newer job or overwrite the original failure.
            if (finalized) return;
            finalized = true;
            job.status = status;
            job.message = message;
            if (active === id) active = null;
            log.end();
          }
          child.on('error', () => {
            finish('failed', 'Could not start local engine. Check Python configuration.');
          });
          child.on('close', code => {
            const report = path.join(output, 'quality-report.json');
            const completed = code === 0 && fs.existsSync(report);
            finish(completed ? 'completed' : 'failed', completed
              ? 'Generated; listening review required. Playback is unchanged.'
              : 'Processing failed. Inspect the local job log; no completed dub is claimed.');
          });
          send(202, publicJob(job));
        } catch { send(400, { error: 'Invalid request or missing paired inbox clip/script' }); }
      });
      return true;
    }
  };
}
module.exports = { createQualityJobs };
