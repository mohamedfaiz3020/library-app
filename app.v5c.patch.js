/* ============================================================
   app.v5c.patch.js  —  Hotfix for app.v5c.js?v=20260408b
   Generated: 2026-04-10
   Bugs fixed:
     1. startAutoSync() is DEFINED but never CALLED in app.v5c.js,
        so the Supabase Realtime WebSocket is never opened on
        login. Cross-device / cross-user live sync is dead.
     2. pushToCloud() sends empty string "" for timestamptz fields
        (e.g. updated_at / created_at). PostgreSQL rejects every
        row with error 22007:
          "invalid input syntax for type timestamp with time zone"
     3. As a consequence of #2, the push loop fails silently and
        immediately retries the ENTIRE local library (56K+ rows).
        10,000+ failing POSTs hit Supabase in under a minute.

   Strategy: do NOT rewrite the 1400-line main file. Instead:
     A) Wrap window.fetch so any POST/PATCH to /rest/v1/<table>
        cleans empty-string values for timestamp-ish keys
        (converts "" → null).
     B) Watch for the user becoming logged in, then invoke
        window.startAutoSync() exactly once per session.
     C) Rate-limit push failures: if more than FAIL_BURST errors
        happen inside FAIL_WINDOW_MS, suppress further pushes for
        COOLDOWN_MS to prevent runaway load on Supabase.

   Install:
     1. Place this file next to app.v5c.js in the repo root:
          /library-app/app.v5c.patch.js
     2. In index.html, immediately AFTER the existing line:
          <script src="app.v5c.js?v=20260408b"></script>
        add:
          <script src="app.v5c.patch.js?v=20260410b"></script>
     3. Commit + push. No other file needs to change.
   ============================================================ */
(function () {
  'use strict';

  var PATCH_VERSION = '20260410b';
  var LOG = function () {
    try {
      var a = ['[PATCH ' + PATCH_VERSION + ']'];
      for (var i = 0; i < arguments.length; i++) a.push(arguments[i]);
      console.log.apply(console, a);
    } catch (e) {}
  };
  var WARN = function () {
    try {
      var a = ['[PATCH ' + PATCH_VERSION + ']'];
      for (var i = 0; i < arguments.length; i++) a.push(arguments[i]);
      console.warn.apply(console, a);
    } catch (e) {}
  };

  LOG('loading');

  /* -----------------------------------------------------------
     BUG 2 & 3: clean payloads + rate-limit push failures
     ----------------------------------------------------------- */

  // Any key we believe is a timestamptz on the Supabase side.
  // We convert "" → null for these keys (PG accepts NULL, not "").
  //
  // Broad heuristic: matches any field name that ends in a timestamp-ish
  // token in either snake_case or camelCase:
  //   *_at        updated_at, created_at, scanned_at, inventoried_at, ...
  //   *At         updatedAt, createdAt, scannedAt, ...
  //   *_time      sync_time, last_time, ...
  //   *Time       syncTime, lastTime, ...
  //   *_date      due_date, ...
  //   *Date       dueDate, ...
  //   *_on        created_on, ...
  //   *On         createdOn, ...
  //   timestamp, last_seen, last_updated, lastUpdated, lastSeen, etc.
  var TS_KEY_RX = new RegExp(
    '(^|_)(at|on|time|date|timestamp|seen|updated|modified|created|scanned|inventoried|synced|logged)$' +
    '|' +
    '(At|On|Time|Date|Timestamp|Seen|Updated|Modified|Created|Scanned|Inventoried|Synced|Logged)$'
  );

  // Values we treat as "empty / invalid" for timestamp fields → null
  function isEmptyTsValue(v) {
    if (v === '' || v === null || v === undefined) return true;
    if (typeof v !== 'string') return false;
    var s = v.trim();
    if (!s) return true;
    if (s === 'Invalid Date' || s === 'NaN' || s === 'null' || s === 'undefined') return true;
    // ISO-ish check: must contain at least a digit and a dash or colon
    if (!/\d/.test(s)) return true;
    return false;
  }

  // Stats for debugging what the patch actually cleaned
  var patchStats = { rowsSeen: 0, keysCleaned: 0, lastCleanedKeys: [] };
  window.__patchStats = patchStats;

  function cleanRow(obj) {
    if (!obj || typeof obj !== 'object') return obj;
    patchStats.rowsSeen++;
    for (var k in obj) {
      if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
      var v = obj[k];
      if (TS_KEY_RX.test(k) && isEmptyTsValue(v)) {
        obj[k] = null;
        patchStats.keysCleaned++;
        if (patchStats.lastCleanedKeys.length < 20 &&
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

  // Rate limiter state for BUG 3 mitigation
  var FAIL_BURST = 50;            // >50 failures...
  var FAIL_WINDOW_MS = 30 * 1000; // ...inside 30 s
  var COOLDOWN_MS = 5 * 60 * 1000;// ...triggers a 5-min cooldown
  var failTimestamps = [];
  var cooldownUntil = 0;

  function recordFailure() {
    var now = Date.now();
    failTimestamps.push(now);
    // prune
    while (failTimestamps.length && failTimestamps[0] < now - FAIL_WINDOW_MS) {
      failTimestamps.shift();
    }
    if (failTimestamps.length >= FAIL_BURST && cooldownUntil < now) {
      cooldownUntil = now + COOLDOWN_MS;
      WARN('push failure burst detected (' + failTimestamps.length +
           ' in ' + FAIL_WINDOW_MS + 'ms) — suspending writes for ' +
           (COOLDOWN_MS / 1000) + 's to protect Supabase quota');
    }
  }

  function inCooldown() { return Date.now() < cooldownUntil; }

  var origFetch = window.fetch && window.fetch.bind(window);
  if (!origFetch) {
    WARN('window.fetch not found — cannot install BUG 2/3 fix');
  } else {
    window.fetch = function patchedFetch(input, init) {
      try {
        var url = typeof input === 'string'
          ? input
          : (input && typeof input.url === 'string' ? input.url : '');
        var method = (init && init.method) || (input && input.method) || 'GET';
        var isWrite =
          url.indexOf('/rest/v1/') !== -1 &&
          (method === 'POST' || method === 'PATCH' || method === 'PUT');

        if (isWrite) {
          // Suppress writes during cooldown
          if (inCooldown()) {
            WARN('suppressing write to', url, '(cooldown)');
            return Promise.resolve(new Response(
              JSON.stringify({ patch: 'cooldown', suppressed: true }),
              { status: 503, headers: { 'content-type': 'application/json' } }
            ));
          }

          // Clean the body
          if (init && typeof init.body === 'string' && init.body.length) {
            var raw = init.body;
            var first = raw.charAt(0);
            if (first === '{' || first === '[') {
              try {
                var data = JSON.parse(raw);
                cleanPayload(data);
                init = Object.assign({}, init, { body: JSON.stringify(data) });
              } catch (e) {
                // not JSON, leave alone
              }
            }
          }
        }
      } catch (e) {
        WARN('fetch wrap pre-call error:', e && e.message);
      }

      var p = origFetch(input, init);

      // Record failures for rate limiting
      return p.then(function (res) {
        try {
          if (res && !res.ok) {
            var u = res.url || '';
            if (u.indexOf('/rest/v1/') !== -1) recordFailure();
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
     BUG 1: ensure startAutoSync() is actually invoked after login
     ----------------------------------------------------------- */

  var autoSyncStartedFor = null; // remembers which user we started for

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
    // Heuristic: if the main screen (home/reports/settings nav)
    // is present in the DOM and the login form is NOT visible,
    // we consider the user logged in.
    if (loginScreenVisible()) return false;
    var mainEls = document.querySelectorAll(
      '[data-screen="home"], #homeScreen, .bottom-nav, nav.tabbar, .tab-bar, .main-screen'
    );
    if (mainEls.length > 0) return true;
    // Fallback: any visible KPI card / welcome banner
    return !!document.querySelector('.kpi, .welcome, .hero-card');
  }

  function tryStartAutoSync() {
    if (!appLooksReady()) return;
    var hasAuto = typeof window.startAutoSync === 'function';
    var hasRt   = typeof window.startRealtimeSync === 'function';
    if (!hasAuto && !hasRt) return;

    // Determine who we are; use "anon" if unknown
    var who = currentUserHint() || 'anon';
    if (autoSyncStartedFor === who) return;

    if (hasAuto) {
      try {
        LOG('calling startAutoSync() for user=' + who);
        window.startAutoSync();
      } catch (e) {
        WARN('startAutoSync() threw:', e && e.message);
      }
    }
    // Also kick the Realtime WebSocket channel if it exists as a
    // separate entry point. Some builds split polling-sync vs.
    // Realtime-WS sync into two functions.
    if (hasRt) {
      try {
        LOG('calling startRealtimeSync() for user=' + who);
        window.startRealtimeSync();
      } catch (e) {
        WARN('startRealtimeSync() threw:', e && e.message);
      }
    }
    autoSyncStartedFor = who;
  }

  // Poll every 1.5 s; this is cheap and handles every
  // possible entry point (login form, team-code modal, refresh,
  // tab re-focus, etc.) without having to hook into app internals.
  var poll = setInterval(tryStartAutoSync, 1500);
  // Stop polling after 10 minutes; by then sync is either up or
  // the user abandoned the page.
  setTimeout(function () { clearInterval(poll); }, 10 * 60 * 1000);

  // Also run once on visibility change, since some browsers
  // throttle setInterval on hidden tabs.
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) tryStartAutoSync();
  });

  // Also run once on window focus
  window.addEventListener('focus', tryStartAutoSync);

  LOG('login watcher installed');
  LOG('ready');
})();
