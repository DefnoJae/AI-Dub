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
  assert.deepEqual(manifest.plugin.permissions.scopes, ['storage', 'playback']);
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
  return { rows, render, fields, states, events, store, get calls() { return calls; },
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
  assert.match(ui.states[0].get(), /Connected.*Instant live dubbing remains unavailable/);
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
    getCurrentPlayerType() { return 'native'; },
    getCurrentPlaybackInfo() { return { episode: 1 }; },
    setAudioTrack() { selections++; }
  };
  const ui = load({}, fetch, videoCore);
  assert.equal(selections, 0);
  ui.events['ai-dub-denshi-probe']();
  assert.equal(selections, 0);
  assert.match(ui.states[5].get(), /Native player renderer detected/);
  assert.match(ui.states[6].get(), /bridge can open a rendered video/);
});
test('Denshi probe handles unavailable built-in player API', () => {
  const ui = load();
  ui.events['ai-dub-denshi-probe']();
  assert.match(ui.states[5].get(), /Playback API unavailable/);
  assert.match(ui.states[6].get(), /Grant the Playback permission/);
});

test('redesigned tray actions are wired and never pretend unsupported dubbing works', async () => {
  const ui = load();
  for (const name of ['ai-dub-load-track', 'ai-dub-prepare-episode',
    'ai-dub-refresh-status', 'ai-dub-open-output']) {
    assert.equal(typeof ui.events[name], 'function', name);
  }
  ui.events['ai-dub-load-track']();
  assert.match(ui.states[6].get(), /no verified external-audio insertion API/);
  await ui.events['ai-dub-prepare-episode']();
  assert.match(ui.states[7].get(), /Enable AI Dub for this session/);
  await ui.events['ai-dub-refresh-status']();
  assert.match(ui.states[7].get(), /No episode job is active/);
  ui.events['ai-dub-open-output']();
  assert.match(ui.states[7].get(), /No completed dubbed episode/);
});

test('polished tray uses styled cards and only backed actions', () => {
  const ui = load();
  const nodes = [];
  function visit(value) {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) return value.forEach(visit);
    if (value.component) {
      nodes.push(value);
      value.args.forEach(visit);
    }
  }
  visit(ui.rows);
  const cards = nodes.filter(n => n.component === 'div');
  assert.equal(cards.length, 6, 'six distinct tray cards');
  for (const card of cards) {
    const style = card.args[1] && card.args[1].style;
    assert.match(style && style.borderRadius || '', /px/);
    assert.match(style && style.background || '', /^#/);
  }
  assert.ok(nodes.some(n => n.component === 'badge'), 'status badges are visible');
  assert.ok(nodes.some(n => n.component === 'flex'), 'compact horizontal controls are present');
  const buttons = nodes.filter(n => n.component === 'button');
  for (const button of buttons) {
    const props = button.args[0];
    assert.equal(typeof ui.events[props.onClick], 'function', props.label);
    if (/^(Play Dubbed Episode|Prepare Current Episode)$/.test(props.label)) {
      assert.equal(props.disabled, true, 'episode controls must remain disabled until prerequisite complete');
    }
  }
  assert.ok(buttons.some(b => b.args[0].label === 'Check Connection'));
  assert.ok(buttons.some(b => b.args[0].label === 'Generate Clip'));
});

test('clip generation remains disabled until a saved connection and clip are available', async () => {
  function findGenerate(root) {
    const found = [];
    function visit(node) {
      if (Array.isArray(node)) return node.forEach(visit);
      if (!node || typeof node !== 'object') return;
      if (node.component === 'button' && node.args[0].label === 'Generate Clip') found.push(node);
      if (node.component) node.args.forEach(visit);
    }
    visit(root);
    assert.equal(found.length, 1);
    return found[0].args[0];
  }
  const disconnected = load();
  assert.equal(findGenerate(disconnected.rows).disabled, true);
  const authenticated = load({
    settings: { enabled: true, endpoint: 'http://127.0.0.1:43123', token: 'a'.repeat(64) }
  }, async () => ({ ok: true, json: async () => ({ clips: ['sample'] }) }));
  assert.equal(findGenerate(authenticated.rows).disabled, true, 'no clips available');
  await authenticated.events['ai-dub-clips']();
  assert.equal(findGenerate(authenticated.render()).disabled, false, 'one valid clip loaded');
});

test('player detection distinguishes missing playback from a web renderer', () => {
  const inactive = load({}, fetch, { getCurrentPlayerType() { return ''; },
    getPlaybackStatus() { return null; } });
  inactive.events['ai-dub-denshi-probe']();
  assert.match(inactive.states[5].get(), /No active episode detected/);
  const web = load({}, fetch, { getCurrentPlayerType() { return 'web'; },
    getPlaybackStatus() { return { playing: true }; } });
  web.events['ai-dub-denshi-probe']();
  assert.match(web.states[5].get(), /Web video renderer detected/);
  assert.match(web.states[6].get(), /does not mean Denshi was disconnected/);
});

test('automatic clip tray submits authenticated local job and refreshes status', async () => {
  const store = { settings: { enabled: true, endpoint: 'http://127.0.0.1:43123', token: 'a'.repeat(64) } };
  const jobId = 'e'.repeat(32);
  const events = [];
  const ui = load(store, async (url, options) => {
    events.push({ url, options });
    if (url.endsWith('/auto/clips')) return { ok: true, json: async () => ({ clips: ['local_episode', '../wrong'] }) };
    if (url.endsWith('/auto/jobs')) {
      assert.deepEqual(JSON.parse(options.body), { clip: 'local_episode', start: 0, seconds: 20 });
      assert.equal(options.headers.Authorization, 'Bearer ' + 'a'.repeat(64));
      return { ok: true, json: async () => ({ id: jobId, status: 'running' }) };
    }
    if (url.endsWith('/auto/jobs/' + jobId)) {
      return { ok: true, json: async () => ({ id: jobId, status: 'completed', output: '/local/jobs/complete' }) };
    }
    throw Error('unexpected endpoint');
  });
  await ui.events['ai-dub-auto-clips']();
  assert.equal(ui.states[11].get()[0], 'local_episode');
  assert.equal(ui.fields[5].current, 'local_episode');
  assert.equal(ui.states[14].get(), true);
  await ui.events['ai-dub-auto-start']();
  assert.equal(ui.states[12].get().status, 'running');
  await ui.events['ai-dub-auto-refresh']();
  assert.equal(ui.states[12].get().status, 'completed');
  assert.match(ui.states[13].get(), /English dialogue WAV generated/);
  assert.equal(events.length, 3);
});

test('Seanime detects current episode, submits render and opens dubbed stream only on request', async () => {
  const store = { settings: { enabled: true, endpoint: 'http://127.0.0.1:43123', token: 'a'.repeat(64) } };
  const id = 'f'.repeat(32), playbackUrl = 'http://127.0.0.1:43123/play/' + 'b'.repeat(64);
  const media = { id: 1234, title: { romaji: 'Example Anime' } };
  const info = { id: 'episode-playback-uuid', playbackType: 'onlinestream',
    streamUrl: '{{SERVER_URL}}/api/v1/directstream/stream?id=example',
    episode: { aniDBEpisode: '3', episodeNumber: 3, displayTitle: 'Episode 3' }, media };
  const playbackCalls = [];
  const core = {
    getCurrentPlaybackInfo() { return info; },
    getCurrentPlayerType() { return 'web'; },
    getPlaybackStatus() { return { currentTime: 45 }; },
    playStream(...args) { playbackCalls.push(args); return Promise.resolve(); }
  };
  const ui = load(store, async (url, options) => {
    if (url.endsWith('/health')) return { ok: true, json: async () => ({
      service: 'ai-dub-companion', apiVersion: 1, mode: 'local', cloudEnabled: false,
      ready: false, capabilities: { dubbing: false },
      experiments: { automaticClips: true, fullEpisodePlayback: true } }) };
    if (url.endsWith('/episodes')) {
      assert.equal(options.method, 'POST');
      assert.equal(options.headers.Authorization, 'Bearer ' + 'a'.repeat(64));
      const body = JSON.parse(options.body);
      assert.equal(body.playbackId, info.id);
      assert.equal(body.source.type, 'url');
      assert.equal(body.source.value, info.streamUrl);
      return { ok: true, json: async () => ({ id, status: 'running', stage: 'Capturing episode' }) };
    }
    if (url.endsWith('/episodes/' + id)) {
      return { ok: true, json: async () => ({
        id, status: 'completed', playbackUrl, playbackFile: 'C:/safe/dub.mp4' }) };
    }
    throw new Error('unexpected request');
  }, core);
  await ui.check();
  assert.equal(ui.states[9].get(), true, 'full-episode engine available');
  ui.events['ai-dub-denshi-probe']();
  assert.match(ui.states[10].get(), /Episode 3/);
  ui.fields[4].current = true;
  await ui.events['ai-dub-prepare-episode']();
  assert.equal(playbackCalls.length, 0, 'rendering must not change playback');
  assert.equal(ui.states[8].get().status, 'running');
  await ui.events['ai-dub-refresh-status']();
  assert.equal(ui.states[8].get().status, 'completed');
  await ui.events['ai-dub-load-track']();
  assert.equal(playbackCalls.length, 1);
  assert.equal(playbackCalls[0][0], playbackUrl);
  assert.equal(playbackCalls[0][1], '3');
  assert.deepEqual(playbackCalls[0][2], media);
});
