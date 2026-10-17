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
    var sessionEnabled = ctx.fieldRef(false);
    var episodeMessage = ctx.state('No episode job running.');
    var autoClips = ctx.state([]);
    var autoClipChoice = ctx.fieldRef('');
    var autoJob = ctx.state(null);
    var autoMessage = ctx.state('Automatic short-clip dubbing requires the opt-in local models.');
    var autoAvailable = ctx.state(false);
    var tray = ctx.newTray({
      iconUrl: 'https://raw.githubusercontent.com/DefnoJae/AI-Dub/main/icon.svg',
      withContent: true, width: '430px'
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
        autoClips.set([]);
        autoClipChoice.setValue('');
        autoJob.set(null);
        autoAvailable.set(false);
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
        var autoReady = !!(health.experiments && health.experiments.automaticClips === true);
        autoAvailable.set(autoReady);
        status.set('Connected to local companion. ' + (autoReady ?
          'Automatic offline clip processing enabled.' :
          'Automatic offline clip processing not enabled on the companion.') +
          ' Full-episode AI dubbing is unavailable.');
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
    ctx.registerEventHandler('ai-dub-auto-clips', async function () {
      try {
        var response = await qualityRequest('/auto/clips');
        var names = response && Array.isArray(response.clips) ? response.clips.filter(function (n) {
          return typeof n === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(n);
        }) : [];
        autoClips.set(names);
        if (names.length) autoClipChoice.setValue(names[0]);
        autoAvailable.set(true);
        autoMessage.set(names.length ? 'Choose a prepared local clip. Speech will use the generic English voice.' :
          'No local media clips found in the companion inbox.');
      } catch (_) {
        autoAvailable.set(false);
        autoMessage.set('Automatic local clip mode unavailable. Start the companion with AI_DUB_AUDIO=1 and installed offline models.');
      }
    });
    ctx.registerEventHandler('ai-dub-auto-start', async function () {
      if (autoJob.get() && autoJob.get().status === 'running') return;
      try {
        if (!autoAvailable.get() || autoClips.get().indexOf(autoClipChoice.current) < 0) {
          throw new Error('Select a prepared clip');
        }
        var job = await qualityRequest('/auto/jobs', { clip: autoClipChoice.current, start: 0, seconds: 20 });
        if (!job || !/^[a-f0-9]{32}$/.test(job.id)) throw new Error('Invalid job');
        autoJob.set(job);
        autoMessage.set('Generating English dialogue locally. Refresh to check progress.');
      } catch (_) {
        autoMessage.set('Automatic clip failed to start. Check the Python models and local companion logs.');
      }
    });
    ctx.registerEventHandler('ai-dub-auto-refresh', async function () {
      var current = autoJob.get();
      if (!current || !/^[a-f0-9]{32}$/.test(current.id)) {
        autoMessage.set('No automatic clip job has been started.');
        return;
      }
      try {
        var result = await qualityRequest('/auto/jobs/' + current.id);
        autoJob.set(result);
        autoMessage.set(result.status === 'completed' ?
          'English dialogue WAV generated. Review the translation and timing before use.' :
          result.status === 'failed' ? 'Generation failed. Inspect the companion job log.' :
          'Still processing locally. This is not real-time playback.');
      } catch (_) { autoMessage.set('Could not refresh automatic clip job.'); }
    });
    ctx.registerEventHandler('ai-dub-denshi-probe', function () {
      try {
        var core = ctx.videoCore;
        if (!core) {
          denshiStatus.set('Playback API unavailable.');
          denshiInfo.set('Grant the Playback permission on the AI Dub extension page and reload the plugin.');
          return;
        }
        // The player APIs are bound only when the manifest requests "playback".
        // These getters are read-only: detection never changes tracks or playback.
        var playerType = typeof core.getCurrentPlayerType === 'function' ?
          String(core.getCurrentPlayerType() || '') : '';
        var playback = typeof core.getPlaybackStatus === 'function' ?
          core.getPlaybackStatus() : null;
        var state = typeof core.getPlaybackState === 'function' ?
          core.getPlaybackState() : null;
        var info = typeof core.getCurrentPlaybackInfo === 'function' ?
          core.getCurrentPlaybackInfo() : null;
        if (!playerType && state && state.playerType) {
          playerType = String(state.playerType);
        }
        if (playerType === 'native') {
          denshiStatus.set('Native player renderer detected.');
        } else if (playerType === 'web') {
          denshiStatus.set('Web video renderer detected. Playback API works.');
        } else if (playerType) {
          denshiStatus.set('Player renderer: ' + playerType + '.');
        } else if (playback || state || info) {
          denshiStatus.set('Playback detected; player type unavailable.');
        } else {
          denshiStatus.set('Playback API connected. No active episode detected.');
        }
        denshiInfo.set((playerType === 'web' ?
          'Denshi desktop can play using the web renderer. This does not mean Denshi was disconnected. ' : '') +
          'Audio selection: ' + (typeof core.setAudioTrack === 'function' ? 'available' : 'not exposed') +
          '. Importing an additional AI audio track is not supported by the documented API.');
      } catch (_) {
        denshiStatus.set('Could not inspect Denshi. Check your Seanime version.');
        denshiInfo.set('');
      }
    });
    ctx.registerEventHandler('ai-dub-load-track', function () {
      denshiInfo.set('Cannot load an AI audio track: this Denshi plugin runtime has no verified external-audio insertion API.');
    });
    ctx.registerEventHandler('ai-dub-prepare-episode', function () {
      episodeMessage.set('Full-episode preparation is not available yet. Try the prepared quality-clip experiment below.');
    });
    ctx.registerEventHandler('ai-dub-refresh-status', async function () {
      var current = qualityJob.get();
      if (!current || !/^[a-f0-9]{32}$/.test(current.id)) {
        episodeMessage.set('No quality clip job is active.');
        return;
      }
      try {
        var job = await qualityRequest('/quality/jobs/' + current.id);
        qualityJob.set(job);
        episodeMessage.set(job.status === 'completed' ? 'Quality clip completed.' :
          job.status === 'failed' ? 'Quality clip failed; inspect the local logs.' : 'Quality clip is still processing.');
      } catch (_) {
        episodeMessage.set('Could not refresh. Check companion connection.');
      }
    });
    ctx.registerEventHandler('ai-dub-open-output', function () {
      var job = qualityJob.get();
      episodeMessage.set(job && job.status === 'completed' && job.output ?
        'Output path: ' + String(job.output) : 'There is no completed quality clip output yet.');
    });
    tray.render(function () {
      var job = qualityJob.get();
      var cardStyle = { padding: '14px', border: '1px solid #303248',
        borderRadius: '14px', background: '#171923', marginBottom: '10px' };
      var titleStyle = { fontWeight: '700', fontSize: '14px', color: '#f4f4fa' };
      var hintStyle = { fontSize: '12px', color: '#a2a4b8' };
      var headerStyle = { fontWeight: '800', fontSize: '18px', color: '#fafaff' };
      var mutedStyle = { fontSize: '11px', color: '#9699ae' };
      var primaryButton = { background: '#5346d9', color: '#ffffff',
        borderRadius: '9px' };
      function heading(label) { return tray.text(label, { style: titleStyle }); }
      function hint(value) { return tray.text(value, { style: hintStyle }); }
      function card(items) { return tray.div(items, { style: cardStyle }); }
      function actions(left, right) {
        return tray.flex([left, right], { direction: 'row', gap: 2,
          style: { width: '100%', marginTop: '6px' } });
      }
      return tray.stack([
        tray.flex([
          tray.img({ src: 'https://raw.githubusercontent.com/DefnoJae/AI-Dub/main/icon.svg',
            alt: 'AI Dub', width: '36px', height: '36px' }),
          tray.stack([
            tray.flex([
              tray.text('AI Dub', { style: headerStyle }),
              tray.badge({ text: 'Prototype', intent: 'primary', size: 'sm' })
            ], { gap: 2, direction: 'row' }),
            tray.text('Local-first dubbing for Seanime', { style: mutedStyle })
          ], { gap: 1 })
        ], { direction: 'row', gap: 3, style: { marginBottom: '8px' } }),
        card([
          tray.flex([
            tray.stack([
              heading('AI Dub session'),
              hint('On-demand English dubbing · preview only')
            ], { gap: 1 }),
            tray.switch({ label: 'Enable AI Dub for this session', fieldRef: sessionEnabled })
          ], { gap: 2, direction: 'column' }),
          hint(sessionEnabled.current ?
            'Requested for this session. Audio track injection is not available yet.' :
            'Original audio remains unchanged.')
        ]),
        card([
          tray.flex([
            heading('Local Companion'),
            tray.badge({ text: status.get().indexOf('Connected') === 0 ? 'Connected' : 'Not connected',
              intent: status.get().indexOf('Connected') === 0 ? 'success' : 'gray', size: 'sm' })
          ], { direction: 'row', gap: 2 }),
          hint(status.get()),
          !saved.token ? hint('To pair: start the companion with npm start, copy the 64-character token from .ai-dub/pairing-token, enable local checks, then Save and Check Connection.') :
            hint('Saved token present. Run Check Connection to verify the local companion.'),
          tray.switch({ label: 'Allow local checks', fieldRef: enabled }),
          tray.input({ label: 'Companion URL', fieldRef: endpoint }),
          tray.input({ label: 'Pairing token (stored locally)', fieldRef: token }),
          actions(
            tray.button({ label: 'Save', onClick: 'ai-dub-save', style: primaryButton }),
            tray.button({ label: 'Check Connection', onClick: 'ai-dub-check', disabled: busy.get() })
          ),
          tray.button({ label: 'Forget Token', onClick: 'ai-dub-forget', size: 'xs' })
        ]),
        card([
          tray.flex([
            heading('Denshi Player'),
            tray.badge({ text: 'Experimental', intent: 'warning', size: 'sm' })
          ], { direction: 'row', gap: 2 }),
          hint(denshiStatus.get()),
          denshiInfo.get() ? hint(denshiInfo.get()) : hint('Check the built-in player connection.'),
          actions(
            tray.button({ label: 'Detect Playback', onClick: 'ai-dub-denshi-probe', style: primaryButton }),
            tray.button({ label: 'Load AI Audio Track', onClick: 'ai-dub-load-track',
              disabled: true })
          ),
          hint('When supported, choose English — AI Dub in the player audio menu.')
        ]),
        card([
          heading('Episode Tools'),
          hint(episodeMessage.get()),
          tray.button({ label: 'Prepare Current Episode', onClick: 'ai-dub-prepare-episode',
            disabled: true }),
          actions(
            tray.button({ label: 'Refresh Status', onClick: 'ai-dub-refresh-status' }),
            tray.button({ label: 'Show Output Path', onClick: 'ai-dub-open-output' })
          )
        ]),
        card([
          tray.flex([
            heading('Automatic English Clip'),
            tray.badge({ text: autoAvailable.get() ? 'Configured' : 'Opt-in setup', intent: autoAvailable.get() ? 'success' : 'gray', size: 'sm' })
          ], { direction: 'row', gap: 2 }),
          hint('Whisper translation + Piper speech. Processes a prepared local clip; not a full streaming episode.'),
          hint(autoMessage.get()),
          tray.button({ label: 'Load Local Clips', onClick: 'ai-dub-auto-clips' }),
          tray.select({ label: 'Local Clip', fieldRef: autoClipChoice,
            options: autoClips.get().map(function (name) { return { label: name, value: name }; }) }),
          actions(
            tray.button({ label: 'Generate English Clip', onClick: 'ai-dub-auto-start',
              style: primaryButton, disabled: !saved.enabled || !saved.token || !autoAvailable.get() ||
                autoClips.get().indexOf(autoClipChoice.current) < 0 ||
                !!(autoJob.get() && autoJob.get().status === 'running') }),
            tray.button({ label: 'Check Clip Progress', onClick: 'ai-dub-auto-refresh' })
          ),
          autoJob.get() && autoJob.get().status === 'completed' ?
            hint('Output folder: ' + String(autoJob.get().output || '')) :
            hint('Original player audio is never altered.')
        ]),
        card([
          heading('Quality Clip Experiments'),
          hint(qualityMessage.get()),
          !saved.enabled || !saved.token ? hint('Save a valid companion token in Local Companion to enable clip processing.') : hint('Select a prepared clip to generate locally.'),
          tray.button({ label: 'Load Prepared Clips', onClick: 'ai-dub-clips' }),
          tray.select({ label: 'Prepared Clip', fieldRef: clipChoice,
            options: clips.get().map(function (name) { return { label: name, value: name }; }) }),
          actions(
            tray.button({ label: 'Generate Clip', onClick: 'ai-dub-quality-start',
              style: primaryButton, disabled: !!(job && job.status === 'running') || !saved.enabled || !saved.token || clips.get().indexOf(clipChoice.current) < 0 }),
            tray.button({ label: 'Refresh Result', onClick: 'ai-dub-quality-refresh' })
          ),
          job && job.status === 'completed' ? hint(String(job.output || '')) :
            hint('Clips are processed locally from prepared files.')
        ]),
        tray.text('Prototype · Full-episode dubbing and audio-track injection are not yet implemented.',
          { style: mutedStyle })
      ], { gap: 2 });
    });
  });
}
