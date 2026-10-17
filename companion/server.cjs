'use strict';
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const VERSION = '0.2.0';
const CAPABILITIES = Object.freeze({ dubbing: false, transcription: false,
  translation: false, synthesis: false, playerIntegration: false, cloud: false });

function createServer({ token }) {
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) {
    throw new Error('A 32-byte hex pairing token is required');
  }
  return http.createServer((req, res) => {
    const send = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json',
        'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
        'Connection': 'close' });
      res.end(JSON.stringify(body));
    };
    // No browser origins or CORS: the Seanime server makes authenticated requests.
    // Validate Host as well as binding loopback to reject DNS rebinding.
    if (!/^127\.0\.0\.1:\d+$/.test(req.headers.host || '') || req.headers.origin) {
      return send(403, { error: 'Loopback server-to-server requests only' });
    }
    const auth = Buffer.from(req.headers.authorization || '');
    const expected = Buffer.from('Bearer ' + token);
    if (auth.length !== expected.length || !crypto.timingSafeEqual(auth, expected)) {
      return send(401, { error: 'Pairing token required' });
    }
    if (req.url === '/health' && req.method === 'GET') {
      return send(200, { service: 'ai-dub-companion', apiVersion: 1, version: VERSION,
        status: 'prototype', ready: false, mode: 'local', cloudEnabled: false,
        capabilities: CAPABILITIES,
        message: 'Connected. Dubbing engines and player integration are not implemented.' });
    }
    if (req.url === '/jobs' && req.method === 'POST') {
      return send(501, { error: 'Dubbing jobs are not implemented', code: 'ENGINE_UNAVAILABLE' });
    }
    if (req.url === '/health') return send(405, { error: 'Use GET' });
    return send(404, { error: 'Not found' });
  });
}

function loadToken(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const file = path.join(dataDir, 'pairing-token');
  try {
    fs.writeFileSync(file, crypto.randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  const token = fs.readFileSync(file, 'utf8').trim();
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('Invalid pairing-token file');
  return { token, file };
}

if (require.main === module) {
  try {
    const port = Number(process.env.AI_DUB_PORT || 43123);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid AI_DUB_PORT');
    const { token, file } = loadToken(path.resolve(process.env.AI_DUB_DATA_DIR || '.ai-dub'));
    const server = createServer({ token });
    server.requestTimeout = 5000;
    server.headersTimeout = 5000;
    server.on('error', error => { console.error('Companion startup failed:', error.message); process.exitCode = 1; });
    server.listen(port, '127.0.0.1', () => {
      console.log(`AI Dub companion ${VERSION}: http://127.0.0.1:${port}`);
      console.log(`Copy the token from ${file} into the Seanime AI Dub panel.`);
      console.log('Prototype only: no audio processing, cloud uploads, or player control.');
    });
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close());
  } catch (error) {
    console.error('Companion startup failed:', error.message);
    process.exitCode = 1;
  }
}
module.exports = { createServer, loadToken };
