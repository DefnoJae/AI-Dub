// Seanime runs this in Goja, not Node. Keep UI logic inside the registered callback.
function init() {
  console.log('[AI Dub] Offline episode bridge loaded. Live dubbing is not implemented.');
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
    var episodeJob = ctx.state(null);
    var episodeAvailable = ctx.state(false);
    var episodeContext = null;
    var episodeTitle = ctx.state('No episode detected.');

    var autoClips = ctx.state([]);
    var autoClipChoice = ctx.fieldRef('');
    var autoJob = ctx.state(null);
    var autoMessage = ctx.state('Automatic short-clip dubbing requires the opt-in local models.');
    var autoAvailable = ctx.state(false);
    var episodeSetup = ctx.state('Run Check Connection to detect full-episode support.');
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
        episodeAvailable.set(false);
        episodeSetup.set('Settings changed. Run Check Connection to detect full-episode support.');
        episodeJob.set(null);
        episodeContext = null;
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
        var episodeReady = !!(health.experiments && health.experiments.fullEpisodePlayback === true);
        episodeAvailable.set(episodeReady);
        var companionVersion = typeof health.version === 'string' && /^[0-9]+\.[0-9]+\.[0-9]+$/.test(health.version) ?
          health.version : 'unknown';
        if (episodeReady) {
          episodeSetup.set('Companion v' + companionVersion + ': full-episode engine ready. Enable AI Dub for this session and prepare the playing episode.');
        } else if (autoReady) {
          episodeSetup.set('Companion v' + companionVersion + ' supports short clips but not full episodes. Stop the old companion with Ctrl+C, update your local AI-Dub repository, then start it with Start-Audio.ps1 and click Check Connection.');
        } else {
          episodeSetup.set('Companion v' + companionVersion + ': full-episode mode is disabled. Start the updated local companion with Start-Audio.ps1, then click Check Connection.');
        }
        status.set('Connected to local companion. ' + (autoReady ?
          'Automatic offline clip processing enabled.' :
          'Automatic offline clip processing not enabled on the companion.') +
          (episodeReady ? ' Offline episode playback bridge enabled.' :
            ' Full-episode processing not enabled.') +
          ' Instant live dubbing remains unavailable.');
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
    function inspectCurrentEpisode() {
      var core = ctx.videoCore;
      if (!core || typeof core.getCurrentPlaybackInfo !== 'function') {
        throw new Error('Playback API unavailable');
      }
      var info = core.getCurrentPlaybackInfo();
      if (!info || !info.id) throw new Error('No current episode playing');
      var file = info.localFile && info.localFile.path || info.streamPath;
      var source;
      if (info.playbackType === 'localfile' && typeof file === 'string' && file) {
        source = { type: 'file', value: file };
      } else if (typeof info.streamUrl === 'string' && info.streamUrl) {
        source = { type: 'url', value: info.streamUrl };
      } else {
        throw new Error('The current player did not expose an accessible media source');
      }
      var episode = info.episode || {};
      var media = info.media || (typeof core.getCurrentMedia === 'function' ? core.getCurrentMedia() : null);
      var title = episode.displayTitle || ('Episode ' + String(episode.episodeNumber || 'unknown'));
      var aniDBEpisode = String(episode.aniDBEpisode || episode.episodeNumber || '');
      if (!media || !aniDBEpisode) throw new Error('Missing anime metadata required for Seanime playback');
      episodeContext = { playbackId: String(info.id), source: source,
        aniDBEpisode: aniDBEpisode, media: media };
      episodeTitle.set(title);
      return episodeContext;
    }
    ctx.registerEventHandler('ai-dub-prepare-episode', async function () {
      if (episodeJob.get() && episodeJob.get().status === 'running') return;
      try {
        if (!sessionEnabled.current) throw new Error('Enable AI Dub for this session first');
        if (!episodeAvailable.get()) throw new Error('Enable full-episode processing in the local companion');
        var current = inspectCurrentEpisode();
        episodeMessage.set('Submitting ' + episodeTitle.get() + ' for offline English dubbing...');
        var result = await qualityRequest('/episodes', { playbackId: current.playbackId,
          source: current.source });
        if (!result || !/^[a-f0-9]{32}$/.test(result.id)) throw new Error('Invalid episode job response');
        episodeJob.set(result);
        episodeMessage.set(result.stage || 'Episode is being prepared locally.');
      } catch (error) {
        var message = error && error.message || '';
        var http = /HTTP (\d{3})/.exec(message);
        var safe = /^(Enable AI Dub|Enable full-episode|Playback API|No current episode|The current player|Missing anime|Invalid episode)/.test(message);
        if (http && http[1] === '409') {
          episodeMessage.set('An episode is already rendering. Check the companion terminal or retry after it finishes.');
        } else if (http && http[1] === '400') {
          episodeMessage.set('The playing media source was rejected. Check that the video is locally accessible or that the Seanime backend uses the configured loopback port.');
        } else if (http) {
          episodeMessage.set('Episode processing could not start (HTTP ' + http[1] + '). Inspect the companion terminal.');
        } else {
          episodeMessage.set(safe ? message :
            'Could not start episode processing. Check the local companion log and stream accessibility.');
        }
      }
    });
    ctx.registerEventHandler('ai-dub-refresh-status', async function () {
      var current = episodeJob.get();
      if (!current || !/^[a-f0-9]{32}$/.test(current.id)) {
        episodeMessage.set('No episode job is active. Start by preparing the playing episode.');
        return;
      }
      try {
        var result = await qualityRequest('/episodes/' + current.id);
        episodeJob.set(result);
        episodeMessage.set(result.status === 'completed' ?
          'Your dubbed episode is ready. Click Play Dubbed Episode to load it into Seanime.' :
          result.status === 'failed' ? 'Episode render failed. See the local episode-jobs log.' :
          (result.stage || 'Rendering offline. Refresh to check the progress.'));
      } catch (_) {
        episodeMessage.set('Could not refresh the current episode job.');
      }
    });
    ctx.registerEventHandler('ai-dub-load-track', async function () {
      var job = episodeJob.get(), context = episodeContext;
      if (!job || job.status !== 'completed' || !job.playbackUrl) {
        denshiInfo.set('Cannot insert an audio track into the existing player: no verified external-audio insertion API. Prepare and complete an episode first.');
        return;
      }
      if (!context || !context.media || !context.aniDBEpisode) {
        denshiInfo.set('Episode context expired. Re-open the original episode, then prepare it again.');
        return;
      }
      var core = ctx.videoCore;
      if (!core || typeof core.playStream !== 'function') {
        denshiInfo.set('This player does not expose the playStream API.');
        return;
      }
      try {
        episodeMessage.set('Opening the English AI Dub version in Seanime...');
        await core.playStream(job.playbackUrl, context.aniDBEpisode, context.media);
        episodeMessage.set('Opened dubbed episode. English AI audio is the default; use the player audio menu for Japanese where supported.');
      } catch (_) {
        episodeMessage.set('The player could not open the dubbed stream. Check the Seanime server and companion log.');
      }
    });
    ctx.registerEventHandler('ai-dub-open-output', function () {
      var job = episodeJob.get();
      episodeMessage.set(job && job.status === 'completed' && job.playbackFile ?
        'Episode output path: ' + String(job.playbackFile) : 'No completed dubbed episode yet.');
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
        try {
          if (info && info.id) inspectCurrentEpisode();
        } catch (_) { episodeTitle.set('Episode detected; source unavailable for dubbing.'); }
        denshiInfo.set((playerType === 'web' ?
          'Denshi desktop can play using the web renderer. This does not mean Denshi was disconnected. ' : '') +
          'Audio selection: ' + (typeof core.setAudioTrack === 'function' ? 'available' : 'not exposed') +
          '. The episode playback bridge can open a rendered video with embedded English and Japanese tracks.');
      } catch (_) {
        denshiStatus.set('Could not inspect Denshi. Check your Seanime version.');
        denshiInfo.set('');
      }
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
              tray.badge({ text: 'Experimental', intent: 'warning', size: 'sm' })
            ], { gap: 2, direction: 'row' }),
            tray.text('Local-first dubbing for Seanime', { style: mutedStyle })
          ], { gap: 1 })
        ], { direction: 'row', gap: 3, style: { marginBottom: '8px' } }),
        card([
          tray.flex([
            tray.stack([
              heading('AI Dub session'),
              hint('Manual, offline English episode dubbing')
            ], { gap: 1 }),
            tray.switch({ label: 'Enable AI Dub for this session', fieldRef: sessionEnabled })
          ], { gap: 2, direction: 'column' }),
          hint(sessionEnabled.current ?
            'Manual episode preparation enabled. Existing playback stays unchanged until you select Play Dubbed Episode.' :
            'Original audio remains unchanged.')
        ]),
        card([
          tray.flex([
            heading('Local Companion'),
            tray.badge({ text: status.get().indexOf('Connected') === 0 ? 'Connected' : 'Not connected',
              intent: status.get().indexOf('Connected') === 0 ? 'success' : 'gray', size: 'sm' })
          ], { direction: 'row', gap: 2 }),
          hint(status.get()),
          !saved.token ? hint('To pair: start the companion, enter the 64-character local token, enable checks, then Save and Check Connection.') :
            status.get().indexOf('Connected') === 0 ?
              hint('Paired locally. Your saved token remains unchanged.') :
              hint('Saved token present. Run Check Connection to verify the companion.'),
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
            tray.button({ label: 'Play Dubbed Episode', onClick: 'ai-dub-load-track',
              disabled: !(episodeJob.get() && episodeJob.get().status === 'completed') })
          ),
          hint('A rendered video opens as a new Seanime stream with embedded Japanese and English audio.')
        ]),
        card([
          tray.flex([
            heading('Episode Tools'),
            tray.badge({ text: episodeAvailable.get() ? 'Engine enabled' :
              autoAvailable.get() ? 'Update companion' : 'Needs setup',
              intent: episodeAvailable.get() ? 'success' : 'gray', size: 'sm' })
          ], { direction: 'row', gap: 2 }),
          hint(episodeTitle.get()),
          hint(episodeSetup.get()),
          hint(episodeMessage.get()),
          tray.button({ label: 'Prepare Current Episode', onClick: 'ai-dub-prepare-episode',
            style: primaryButton,
            disabled: !sessionEnabled.current || !episodeAvailable.get() || !saved.enabled || !saved.token ||
              !!(episodeJob.get() && episodeJob.get().status === 'running') }),
          actions(
            tray.button({ label: 'Refresh Status', onClick: 'ai-dub-refresh-status' }),
            tray.button({ label: 'Show Output Path', onClick: 'ai-dub-open-output' })
          ),
          hint('Rendering is offline and may be slow. Keep the original stream available until capture finishes.')
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
        tray.text('Experimental · Offline episode remux. Live audio injection and natural character voices are not yet available.',
          { style: mutedStyle })
      ], { gap: 2 });
    });
  });
}
