const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { mpvCommand, addDubTrack } = require('../companion/mpv-track.cjs');

test('mpv bridge adds the user-selected English audio track', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-dub-mpv-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'dub.wav');
  fs.writeFileSync(file, 'fixture');
  let sent;
  const connect = () => {
    const socket = new EventEmitter();
    socket.setTimeout = () => {};
    socket.destroy = () => {};
    socket.write = data => {
      sent = JSON.parse(data.trim());
      process.nextTick(() => socket.emit('data', Buffer.from('{"request_id":1,"error":"success"}\n')));
    };
    process.nextTick(() => socket.emit('connect'));
    return socket;
  };
  await addDubTrack('fake-socket', file, { connect });
  assert.deepEqual(sent.command, ['audio-add', fs.realpathSync(file), 'select', 'English — AI-Dub', 'eng']);
  assert.equal(sent.request_id, 1);
});
test('mpv bridge rejects invalid commands and missing socket', async () => {
  await assert.rejects(mpvCommand('', ['get_property', 'time-pos']));
  await assert.rejects(mpvCommand('socket', ['get_property', 1]));
});
