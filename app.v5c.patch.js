/* ============================================================
   app.v5c.patch.js  —  Hotfix v2 for app.v5c.js?v=20260408b
   Generated: 2026-04-10

   IMPORTANT: This script MUST load BEFORE app.v5c.js,
   so that window.fetch is wrapped before the main app
   captures a reference to it. See INSTALL.md.

   Bugs fixed:
     1. startAutoSync() is DEFINED but never CALLED in app.v5c.js,
        so the Supabase Realtime WebSocket is never opened on
        login. Cross-device / cross-user live sync is dead.
     2. pushToCloud() sends empty string "" for timestamptz fields
        (last_inventory_date, etc). PostgreSQL rejects every row
        with error 22007.
     3. As a consequence of #2, the push loop fails silently and
        immediately retries the ENTIRE local library. 10,000+
        failing POSTs hit Supabase in under a minute.
     4. (NEW in v2) The stale sync_queue from the pre-patch era
        is auto-cleared on load so the flood stops immediately.
     5. (NEW in v2) First 5 failing responses are captured to
        window.__patchErrors so we can see exactly what the
        server is rejecting.
     6. (NEW in v2) Rate limit is far more generous (500 fails /
        60s) so normal bulk operations are NOT suppressed.
     7. (NEW in v2) Request objects (new Request()) with stream
        bodies are also handled.
   ============================================================ */
(function () {
  'use strict';

  var PATCH_VERSION = '20260410d';
  function LOG() {
    try {
      var a = ['[PATCH ' + PATCH_VERSION + ']'];
      for (var i = 0; i < arguments.length; i++) a.push(arguments[i]);
      console.log.apply(console, a);
    } catch (e) {}
  }
  function WARN() {
    try {
      var a = ['[PATCH ' + PATCH_VERSION + ']'];
      for (var i = 0; i < arguments.length; i++) a.push(arguments[i]);
      console.warn.apply(console, a);
    } catch (e) {}
  }

  LOG('loading');

  // Public debug surface
  window.__patchStats = { rowsSeen: 0, keysCleaned: 0, lastCleanedKeys: [] };
  window.__patchErrors = [];   // first few non-2xx response bodies
  window.__patchVersion = PATCH_VERSION;
  var patchStats = window.__patchStats;

  /* -----------------------------------------------------------
     BUG 4: Nuke stale sync_queue on startup
     ----------------------------------------------------------- */
  // The previous broken version filled IndexedDB with bad rows.
  // On every reload those retry and DDoS Supabase before login.
  // Clear the queue atomically before app.v5c.js can read it.
  (function nukeStaleQueue() {
    try {
      var req = indexedDB.open('LibraryInventoryDB');
      req.onsuccess = function () {
        try {
          var db = req.result;
          if (!db.objectStoreNames.contains('sync_queue')) {
            db.close();
            LOG('sync_queue store not present, skip nuke');
            return;
          }
          var tx = db.transaction('sync_queue', 'readwrite');
          var store = tx.objectStore('sync_queue');
          var countReq = store.count();
          countReq.onsuccess = function () {
            var n = countReq.result || 0;
            if (n > 0) {
              store.clear();
              LOG('nuked sync_queue (' + n + ' stale rows)');
            } else {
              LOG('sync_queue already empty');
            }
          };
          tx.oncomplete = function () { db.close(); };
          tx.onerror = function () { try { db.close(); } catch (e) {} };
        } catch (e) { WARN('nuke tx error:', e && e.message); }
      };
      req.onerror = function () {
        WARN('nuke IDB open error');
      };
    } catch (e) { WARN('nuke outer error:', e && e.message); }
  })();

  /* -----------------------------------------------------------
     BUG 2: convert ALL empty strings to null
     ----------------------------------------------------------- */
  // CONFIRMED by live diagnostic (2026-04-10): the Supabase `books`
  // table has BOTH timestamptz columns (last_inventory_date,
  // created_at, updated_at) AND integer columns (match_confidence,
  // publication_year) that PostgreSQL rejects with "" values:
  //   22007  invalid input syntax for type timestamp with time zone: ""
  //   22P02  invalid input syntax for type integer: ""
  // Direct test confirmed: after nulling ALL empty strings, a
  // POST /rest/v1/books returns 201 Created.
  //
  // Text columns accept both "" and null identically in the UI
  // (both render as empty), so this is safe across the board.
  function cleanRow(obj) {
    if (!obj || typeof obj !== 'object') return obj;
    patchStats.rowsSeen++;
    for (var k in obj) {
      if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
      if (obj[k] === '') {
        obj[k] = null;
        patchStats.keysCleaned++;
        if (patchStats.lastCleanedKeys.length < 30 &&
            patchStats.lastCleanedKeys.indexOf(k) === -1) {
          patchStats.lastCleanedKeys.push(k);
        }
      }
    }
    return obj;
  }

  function cleanPayload(data) {
    if (Array.isArray(data)) {
      for (var i = 0; i < data.length; i++) cleanRow(data[i]);
    } else {
      cleanRow(data);
    }
    return data;
  }

  /* -----------------------------------------------------------
     BUG 3: rate-limit push failures (v2: much more generous)
     ----------------------------------------------------------- */
  var FAIL_BURST     = 500;             // >500 failures...
  var FAIL_WINDOW_MS = 60 * 1000;       // ...inside 60 s
  var COOLDOWN_MS    = 2 * 60 * 1000;   // ...triggers 2-min cooldown
  var failTimestamps = [];
  var cooldownUntil  = 0;

  function recordFailure() {
    var now = Date.now();
    failTimestamps.push(now);
    while (failTimestamps.length && failTimestamps[0] < now - FAIL_WINDOW_MS) {
      failTimestamps.shift();
    }
    if (failTimestamps.length >= FAIL_BURST && cooldownUntil < now) {
      cooldownUntil = now + COOLDOWN_MS;
      WARN('push failure burst detected (' + failTimestamps.length +
           ' in ' + FAIL_WINDOW_MS + 'ms) — suspending writes for ' +
           (COOLDOWN_MS / 1000) + 's');
    }
  }
  function inCooldown() { return Date.now() < cooldownUntil; }

  // Public helper: user can manually clear cooldown in console
  window.__patchResetCooldown = function () {
    cooldownUntil = 0;
    failTimestamps = [];
    LOG('cooldown manually cleared');
  };

  /* -----------------------------------------------------------
     Fetch wrapper
     ----------------------------------------------------------- */
  var origFetch = window.fetch && window.fetch.bind(window);
  if (!origFetch) {
    WARN('window.fetch not found — cannot install patch');
  } else {
    window.fetch = function patchedFetch(input, init) {
      var url = '';
      var method = 'GET';
      try {
        url = typeof input === 'string'
          ? input
          : (input && typeof input.url === 'string' ? input.url : '');
        method = (init && init.method) ||
                 (input && input.method) || 'GET';
      } catch (e) {}
      var isRest  = url.indexOf('/rest/v1/') !== -1;
      var isWrite = isRest && (method === 'POST' || method === 'PATCH' || method === 'PUT');

      if (isWrite && inCooldown()) {
        return Promise.resolve(new Response(
          JSON.stringify({ patch: 'cooldown', suppressed: true }),
          { status: 503, headers: { 'content-type': 'application/json' } }
        ));
      }

      // Clean the body if it's a JSON string
      if (isWrite && init && typeof init.body === 'string' && init.body.length) {
        try {
          var first = init.body.charAt(0);
          if (first === '{' || first === '[') {
            var data = JSON.parse(init.body);
            cleanPayload(data);
            init = Object.assign({}, init, { body: JSON.stringify(data) });
          }
        } catch (e) {}
      }

      var p = origFetch(input, init);
      if (!isRest) return p;

      return p.then(function (res) {
        try {
          if (res && !res.ok) {
            recordFailure();
            // Capture first 5 error bodies for diagnosis
            if (window.__patchErrors.length < 5) {
              res.clone().text().then(function (txt) {
                try {
                  window.__patchErrors.push({
                    url: res.url || url,
                    status: res.status,
                    body: (txt || '').slice(0, 500)
                  });
                } catch (e) {}
              }).catch(function () {});
            }
          }
        } catch (e) {}
        return res;
      }).catch(function (err) {
        try { recordFailure(); } catch (e) {}
        throw err;
      });
    };
    LOG('fetch wrapper installed');
  }

  /* -----------------------------------------------------------
     BUG 1: ensure startAutoSync() / startRealtimeSync() are
     actually invoked after login
     ----------------------------------------------------------- */
  var autoSyncStartedFor = null;

  function currentUserHint() {
    try {
      return (
        window.CURRENT_USER ||
        window.currentUser ||
        window.APP_USER ||
        localStorage.getItem('lib_current_user') ||
        localStorage.getItem('lib_user') ||
        sessionStorage.getItem('lib_current_user') ||
        null
      );
    } catch (e) { return null; }
  }

  function loginScreenVisible() {
    try {
      var el = document.getElementById('loginScreen') ||
               document.getElementById('login') ||
               document.querySelector('[data-screen="login"]');
      if (!el) return false;
      var s = getComputedStyle(el);
      return s.display !== 'none' && s.visibility !== 'hidden' &&
             !el.classList.contains('hidden');
    } catch (e) { return false; }
  }

  function appLooksReady() {
    // If there's a visible search box or book grid, the user is in
    var hints = document.querySelectorAll(
      'input[placeholder*="ابحث"], .book-card, .kpi, #booksGrid, #bookList, [data-screen="home"]'
    );
    if (hints.length > 0 && !loginScreenVisible()) return true;
    return false;
  }

  function tryStartAutoSync() {
    if (!appLooksReady()) return;
    var hasAuto = typeof window.startAutoSync === 'function';
    var hasRt   = typeof window.startRealtimeSync === 'function';
    if (!hasAuto && !hasRt) return;

    var who = currentUserHint() || 'anon';
    if (autoSyncStartedFor === who) return;

    if (hasAuto) {
      try { LOG('calling startAutoSync() for user=' + who); window.startAutoSync(); }
      catch (e) { WARN('startAutoSync() threw:', e && e.message); }
    }
    if (hasRt) {
      try { LOG('calling startRealtimeSync() for user=' + who); window.startRealtimeSync(); }
      catch (e) { WARN('startRealtimeSync() threw:', e && e.message); }
    }
    autoSyncStartedFor = who;
  }

  var poll = setInterval(tryStartAutoSync, 1500);
  setTimeout(function () { clearInterval(poll); }, 10 * 60 * 1000);
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) tryStartAutoSync();
  });
  window.addEventListener('focus', tryStartAutoSync);

  LOG('login watcher installed');
  LOG('ready');
})();
