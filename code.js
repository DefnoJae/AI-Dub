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
    var revision = 0;
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
    tray.render(function () {
      return tray.stack([
        tray.text('AI Dub — local companion'),
        tray.text('Prototype only. No audio dubbing or playback changes.'),
        tray.text(status.get()),
        tray.switch({ label: 'Allow local status checks', fieldRef: enabled }),
        tray.input({ label: 'Companion URL', fieldRef: endpoint }),
        tray.input({ label: 'Pairing token (visible; stored locally)', fieldRef: token }),
        tray.text('Cloud processing is disabled and unavailable. Save before checking.'),
        tray.button({ label: 'Save settings', onClick: 'ai-dub-save' }),
        tray.button({ label: 'Check saved connection', onClick: 'ai-dub-check', disabled: busy.get() }),
        tray.button({ label: 'Forget token / disable checks', onClick: 'ai-dub-forget' }),
        tray.text('Player integration has not been verified in Seanime.')
      ], { gap: 3 });
    });
  });
}
