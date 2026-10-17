// Seanime runs this in Goja, not Node. Keep UI logic inside the registered callback.
function init() {
  console.log('[AI Dub] Settings/status prototype loaded. Dubbing is not implemented.');
  $ui.register(function (ctx) {
    var saved = { enabled: false, endpoint: 'http://127.0.0.1:43123', token: '' };
    var storageError = false;
    try {
      var stored = $storage.get('settings');
      if (stored && typeof stored === 'object') {
        saved.enabled = stored.enabled === true;
        if (typeof stored.endpoint === 'string') saved.endpoint = stored.endpoint;
        if (typeof stored.token === 'string') saved.token = stored.token;
      }
    } catch (_) { storageError = true; }
    var enabled = ctx.fieldRef(saved.enabled);
    var endpoint = ctx.fieldRef(saved.endpoint);
    var token = ctx.fieldRef(saved.token);
    var status = ctx.state(storageError ? 'Storage unavailable. Approve the storage permission and reload.' : 'Not checked.');
    var busy = ctx.state(false);
    var clips = ctx.state([]);
    var clipChoice = ctx.fieldRef('');
    var qualityJob = ctx.state(null);
    var qualityMessage = ctx.state('Quality clip experiments use prepared local inbox files.');
    var revision = 0;
    var denshiStatus = ctx.state('Denshi not inspected.');
    var denshiInfo = ctx.state('');
    var tray = ctx.newTray({
      iconUrl: 'https://raw.githubusercontent.com/DefnoJae/AI-Dub/main/icon.svg',
      withContent: true, width: '380px'
    });

    function validate(value) {
      var match = /^http:\/\/127\.0\.0\.1:([0-9]{1,5})$/.exec(value.endpoint);
      if (!match || Number(match[1]) < 1024 || Number(match[1]) > 65535) {
        throw new Error('Use http://127.0.0.1:PORT with a port from 1024 to 65535.');
      }
      if (value.token && !/^[a-f0-9]{64}$/.test(value.token)) {
        throw new Error('Pairing token must contain exactly 64 lowercase hex characters.');
      }
      if (value.enabled && !value.token) throw new Error('Paste the pairing token before enabling checks.');
    }

    ctx.registerEventHandler('ai-dub-save', function () {
      try {
        var next = { enabled: enabled.current === true,
          endpoint: String(endpoint.current || '').trim().replace(/\/$/, ''),
          token: String(token.current || '').trim() };
        validate(next);
        $storage.set('settings', next);
        saved = next;
        clips.set([]);
        clipChoice.setValue('');
        qualityJob.set(null);
        revision++;
        busy.set(false);
        status.set('Settings saved. Connection not checked.');
      } catch (error) { status.set('Settings not saved: ' + error.message); }
    });
    ctx.registerEventHandler('ai-dub-forget', function () {
      try {
        var next = { enabled: false, endpoint: saved.endpoint, token: '' };
        $storage.set('settings', next);
        saved = next;
        clips.set([]);
        clipChoice.setValue('');
        qualityJob.set(null);
        enabled.setValue(false);
        token.setValue('');
        revision++;
        busy.set(false);
        status.set('Token forgotten. Local checks disabled.');
      } catch (_) { status.set('Could not clear saved token. Check storage permission.'); }
    });
    ctx.registerEventHandler('ai-dub-check', async function () {
      if (busy.get()) return;
      var requestRevision = ++revision;
      try {
        validate(saved);
        if (!saved.enabled) throw new Error('Enable local checks and save first.');
        busy.set(true);
        status.set('Checking saved companion settings...');
        var response = await ctx.fetch(saved.endpoint + '/health', {
          headers: { Authorization: 'Bearer ' + saved.token }, timeout: 5, redirect: 'error'
        });
        if (requestRevision !== revision) return;
        if (response.status === 401) throw new Error('Pairing rejected. Copy the companion token and save again.');
        if (!response.ok) throw new Error('Companion returned HTTP ' + response.status + '.');
        var health = await response.json();
        if (requestRevision !== revision) return;
        if (!health || health.service !== 'ai-dub-companion' || health.apiVersion !== 1 ||
          health.mode !== 'local' || health.cloudEnabled !== false || health.ready !== false ||
          !health.capabilities || health.capabilities.dubbing !== false) {
          throw new Error('Unexpected companion response or unsupported API. Update both components.');
        }
        status.set('Connected to local companion. Dubbing unavailable; no engines or player integration.');
      } catch (error) {
        // Do not surface network exception strings: these can contain request details.
        if (requestRevision === revision) {
          var message = error && error.message || '';
          var safe = /^(Use http:|Pairing token must|Paste the pairing|Enable local checks|Pairing rejected|Companion returned HTTP|Unexpected companion)/.test(message);
          status.set(safe ? message : 'Connection failed. Start the companion on the Seanime server machine and verify the saved port.');
        }
      } finally {
        if (requestRevision === revision) busy.set(false);
      }
    });
    async function qualityRequest(route, body) {
      validate(saved);
      if (!saved.enabled) throw new Error('Enable local checks first.');
      var options = { headers: { Authorization: 'Bearer ' + saved.token }, timeout: 5, redirect: 'error' };
      if (body) {
        options.method = 'POST';
        options.headers['Content-Type'] = 'application/json';
        options.body = JSON.stringify(body);
      }
      var requestSettings = saved;
      var response = await ctx.fetch(saved.endpoint + route, options);
      if (saved !== requestSettings) throw new Error('Settings changed');
      if (!response.ok) throw new Error('Local quality request failed (HTTP ' + response.status + ').');
      return await response.json();
    }
    ctx.registerEventHandler('ai-dub-clips', async function () {
      try {
        var result = await qualityRequest('/quality/clips');
        if (!result || !Array.isArray(result.clips)) throw new Error('Invalid clip list');
        var names = result.clips.filter(function (name) { return typeof name === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(name); });
        clips.set(names);
        if (names.length) clipChoice.setValue(names[0]);
        qualityMessage.set(names.length ? 'Choose a prepared clip. Processing stays on this computer.' : 'No prepared clips found in the local inbox.');
      } catch (_) { qualityMessage.set('Could not load clips. Start the companion with quality experiments enabled.'); }
    });
    ctx.registerEventHandler('ai-dub-quality-start', async function () {
      if (qualityJob.get() && qualityJob.get().status === 'running') return;
      try {
        if (clips.get().indexOf(clipChoice.current) < 0) throw new Error('Choose a clip');
        var job = await qualityRequest('/quality/jobs', { clip: clipChoice.current, seconds: 20 });
        if (!job || !/^[a-f0-9]{32}$/.test(job.id)) throw new Error('Invalid job');
        qualityJob.set(job);
        qualityMessage.set('Processing locally. This may take several minutes. Use Refresh result to check.');
      } catch (_) { qualityMessage.set('Could not start the clip. Check local setup or an already-running job.'); }
    });
    ctx.registerEventHandler('ai-dub-quality-refresh', async function () {
      var current = qualityJob.get();
      if (!current || !/^[a-f0-9]{32}$/.test(current.id)) return;
      try {
        var job = await qualityRequest('/quality/jobs/' + current.id);
        qualityJob.set(job);
        qualityMessage.set(job.status === 'completed' ? 'Clip generated; listening review required. Open the output folder below.' :
          job.status === 'failed' ? 'Processing failed. Inspect the local job log.' : 'Still processing on this computer.');
      } catch (_) { qualityMessage.set('Could not refresh the result. Check the companion connection.'); }
    });
    ctx.registerEventHandler('ai-dub-denshi-probe', function () {
      try {
        var core = ctx.videoCore;
        if (!core) {
          denshiStatus.set('VideoCore not exposed to this plugin session.');
          denshiInfo.set('');
          return;
        }
        var playback = typeof core.getPlaybackStatus === 'function' ? core.getPlaybackStatus() : null;
        var info = typeof core.getCurrentPlaybackInfo === 'function' ? core.getCurrentPlaybackInfo() : null;
        // No audio mutation: this checks the active built-in player only.
        denshiStatus.set('VideoCore exposed; audio selection: ' + (typeof core.setAudioTrack === 'function' ? 'yes' : 'no') + '; playback getter: ' + (typeof core.getPlaybackStatus === 'function' ? 'yes' : 'no') + '.');
        denshiInfo.set('External audio insertion is not exposed by the public VideoCore API. ' +
          (info ? 'Current playback information available.' : 'Start an episode to test playback detection.'));
      } catch (_) {
        denshiStatus.set('Could not inspect Denshi. Check your Seanime version.');
        denshiInfo.set('');
      }
    });
    tray.render(function () {
      return tray.stack([
        tray.text('AI Dub — local companion'),
        tray.text('Short-clip experiments only. Automatic playback dubbing is unavailable.'),
        tray.text(status.get()),
        tray.switch({ label: 'Allow local status checks', fieldRef: enabled }),
        tray.input({ label: 'Companion URL', fieldRef: endpoint }),
        tray.input({ label: 'Pairing token (visible; stored locally)', fieldRef: token }),
        tray.text('Cloud processing is disabled and unavailable. Save before checking.'),
        tray.button({ label: 'Save settings', onClick: 'ai-dub-save' }),
        tray.button({ label: 'Check saved connection', onClick: 'ai-dub-check', disabled: busy.get() }),
        tray.button({ label: 'Forget token / disable checks', onClick: 'ai-dub-forget' }),
        tray.text('Denshi built-in player'),
        tray.text(denshiStatus.get()),
        tray.text(denshiInfo.get()),
        tray.button({ label: 'Detect Denshi playback', onClick: 'ai-dub-denshi-probe' }),
        tray.text('Native AI audio track loading is not supported by the published Denshi plugin API.'),
        tray.text('Local quality clip experiments'),
        tray.text(qualityMessage.get()),
        tray.button({ label: 'Load prepared clips', onClick: 'ai-dub-clips' }),
        tray.select({ label: 'Prepared clip', fieldRef: clipChoice, options: clips.get().map(function (name) { return { label: name, value: name }; }) }),
        tray.button({ label: 'Generate quality clip', onClick: 'ai-dub-quality-start', disabled: !!(qualityJob.get() && qualityJob.get().status === 'running') }),
        tray.button({ label: 'Refresh result', onClick: 'ai-dub-quality-refresh' }),
        tray.text(qualityJob.get() && qualityJob.get().status === 'completed' ? String(qualityJob.get().output || '') : '')
      ], { gap: 3 });
    });
  });
}
