const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { createServer } = require('../companion/server.cjs');
const code = fs.readFileSync(path.join(__dirname, '../code.js'), 'utf8');

test('manifest grants the loopback network access required by ctx.fetch', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../Manifest.json'), 'utf8'));
  assert.deepEqual(manifest.plugin.permissions.allow.networkAccess.allowedDomains, ['http://127.0.0.1']);
  assert.deepEqual(manifest.plugin.permissions.scopes, ['storage']);
});

function load(store = {}, fetcher = fetch, videoCore = undefined) {
  const events = {}, fields = [], states = [];
  let render, calls = 0, rows;
  const tray = new Proxy({ render(fn) { render = fn; } }, {
    get(target, key) { return target[key] || ((...args) => ({ component: key, args })); }
  });
  const ctx = {
    newTray: () => tray,
    videoCore,
    fieldRef(value) { const field = { current: value, setValue(v) { this.current = v; } }; fields.push(field); return field; },
    state(value) { const state = { get: () => value, set(v) { value = v; } }; states.push(state); return state; },
    registerEventHandler(name, fn) { events[name] = fn; },
    fetch(url, options) { calls++; return fetcher(url, options); }
  };
  const context = vm.createContext({ console: { log() {} },
    $ui: { register(fn) { fn(ctx); } },
    $storage: { get: key => store[key], set(key, value) { store[key] = JSON.parse(JSON.stringify(value)); } }
  });
  vm.runInContext(code, context);
  context.init();
  rows = render();
  assert.equal(rows.component, 'stack');
  return { fields, states, events, store, get calls() { return calls; },
    save() { events['ai-dub-save'](); }, check() { return events['ai-dub-check'](); } };
}

test('plugin is opt-in, validates destinations, persists and forgets settings', async () => {
  const ui = load();
  await ui.check();
  assert.equal(ui.calls, 0);
  ui.fields[0].current = true;
  ui.fields[1].current = 'http://evil.example:43123';
  ui.fields[2].current = 'a'.repeat(64);
  ui.save();
  assert.match(ui.states[0].get(), /not saved/);
  assert.equal(ui.store.settings, undefined);
  for (const endpoint of ['http://127.0.0.1:80', 'http://127.0.0.1:65536', 'http://127.0.0.1:43123@evil.example', 'https://127.0.0.1:43123']) {
    ui.fields[1].current = endpoint;
    ui.save();
    assert.equal(ui.store.settings, undefined);
  }
  ui.fields[1].current = 'http://127.0.0.1:43123/';
  ui.save();
  assert.equal(ui.store.settings.endpoint, 'http://127.0.0.1:43123');
  const reloaded = load(ui.store);
  assert.equal(reloaded.fields[0].current, true);
  assert.equal(reloaded.fields[2].current, 'a'.repeat(64));
  reloaded.events['ai-dub-forget']();
  assert.equal(ui.store.settings.token, '');
  await reloaded.check();
  assert.equal(reloaded.calls, 0);
});

test('plugin bridge checks the real companion health and authentication', async t => {
  const token = 'a'.repeat(64), server = createServer({ token });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const store = { settings: { enabled: true, endpoint: `http://127.0.0.1:${server.address().port}`, token } };
  const ui = load(store);
  await ui.check();
  assert.match(ui.states[0].get(), /Connected.*Dubbing unavailable/);
  ui.fields[2].current = 'b'.repeat(64);
  ui.save();
  await ui.check();
  assert.match(ui.states[0].get(), /Pairing rejected/);
  assert.equal(ui.states[1].get(), false);
});

test('unsupported responses, network errors and stale checks never show ready', async () => {
  const store = { settings: { enabled: true, endpoint: 'http://127.0.0.1:43123', token: 'a'.repeat(64) } };
  const invalid = load(store, async () => ({ ok: true, json: () => ({ service: 'other' }) }));
  await invalid.check();
  assert.match(invalid.states[0].get(), /Unexpected companion/);
  const failed = load(store, async () => { throw new Error('secret token value'); });
  await failed.check();
  assert.match(failed.states[0].get(), /^Connection failed/);
  assert.doesNotMatch(failed.states[0].get(), /secret/);
  let resolve;
  const stale = load(store, () => new Promise(r => { resolve = r; }));
  const pending = stale.check();
  await stale.check();
  assert.equal(stale.calls, 1);
  stale.events['ai-dub-forget']();
  resolve({ ok: true, json: () => ({}) });
  await pending;
  assert.match(stale.states[0].get(), /Token forgotten/);
});

test('quality controls use prepared clip IDs and refresh completion', async () => {
  const store = { settings: { enabled: true, endpoint: 'http://127.0.0.1:43123', token: 'a'.repeat(64) } };
  const id = 'c'.repeat(32);
  const ui = load(store, async (url, options) => {
    if (url.endsWith('/quality/clips')) return { ok: true, json: () => ({ clips: ['example', '../bad'] }) };
    if (url.endsWith('/quality/jobs')) {
      assert.equal(JSON.parse(options.body).clip, 'example');
      return { ok: true, json: () => ({ id, status: 'running' }) };
    }
    assert.ok(url.endsWith('/quality/jobs/' + id));
    return { ok: true, json: () => ({ id, status: 'completed', output: '/local/output' }) };
  });
  await ui.events['ai-dub-clips']();
  assert.equal(ui.fields[3].current, 'example');
  assert.equal(ui.states[2].get().length, 1);
  await ui.events['ai-dub-quality-start']();
  assert.equal(ui.states[3].get().status, 'running');
  await ui.events['ai-dub-quality-refresh']();
  assert.equal(ui.states[3].get().status, 'completed');
});

test('Denshi probe is explicit and does not alter player audio', () => {
  let selections = 0;
  const videoCore = {
    getPlaybackStatus() { return { playing: true }; },
    getCurrentPlaybackInfo() { return { episode: 1 }; },
    setAudioTrack() { selections++; }
  };
  const ui = load({}, fetch, videoCore);
  assert.equal(selections, 0);
  ui.events['ai-dub-denshi-probe']();
  assert.equal(selections, 0);
  assert.match(ui.states[5].get(), /VideoCore exposed/);
  assert.match(ui.states[6].get(), /External audio insertion/);
});
test('Denshi probe handles unavailable built-in player API', () => {
  const ui = load();
  ui.events['ai-dub-denshi-probe']();
  assert.match(ui.states[5].get(), /not exposed/);
});
