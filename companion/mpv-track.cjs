'use strict';
// Optional, explicit mpv IPC bridge. Never connects to or modifies a player automatically.
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');

function validateAudioFile(file) {
  if (typeof file !== 'string' || !file.toLowerCase().endsWith('.wav')) {
    throw new Error('Expected a local WAV audio file');
  }
  const resolved = fs.realpathSync(file);
  if (!fs.statSync(resolved).isFile()) throw new Error('Audio track is not a file');
  return resolved;
}

function mpvCommand(socketPath, command, { timeoutMs = 3000, connect = net.createConnection } = {}) {
  if (typeof socketPath !== 'string' || !socketPath.trim()) return Promise.reject(new Error('Missing mpv IPC socket'));
  if (!Array.isArray(command) || !command.every(v => typeof v === 'string')) {
    return Promise.reject(new Error('Invalid mpv command'));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    let buffer = '';
    const socket = connect(socketPath);
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve(result);
    };
    socket.setTimeout(timeoutMs, () => finish(new Error('mpv IPC timeout')));
    socket.on('error', finish);
    socket.on('connect', () => socket.write(JSON.stringify({ command, request_id: 1 }) + '\\n'));
    socket.on('data', chunk => {
      buffer += chunk.toString('utf8');
      if (buffer.length > 65536) return finish(new Error('mpv response too large'));
      const newline = buffer.indexOf('\\n');
      if (newline === -1) return;
      const lines = buffer.slice(0, newline).trim();
      try {
        const response = JSON.parse(lines);
        if (response.request_id !== 1) return finish(new Error('Unexpected mpv response'));
        if (response.error !== 'success') return finish(new Error('mpv command failed: ' + response.error));
        finish(null, response.data);
      } catch (error) { finish(error); }
    });
  });
}

async function addDubTrack(socketPath, wavFile, options) {
  const audio = validateAudioFile(wavFile);
  // 'select' adds the track and selects it; original audio remains in the track list.
  return mpvCommand(socketPath, ['audio-add', audio, 'select', 'English — AI-Dub', 'eng'], options);
}

module.exports = { validateAudioFile, mpvCommand, addDubTrack };
