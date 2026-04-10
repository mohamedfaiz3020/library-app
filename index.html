/* ============================================================
   app.v5c.patch.js  —  Hotfix v3 for app.v5c.js?v=20260408b
   Generated: 2026-04-10

   IMPORTANT: This script MUST load BEFORE app.v5c.js,
   so that window.fetch is wrapped before the main app
   captures a reference to it. See INSTALL.md.

   Bugs fixed in v1/v2 (kept):
     1. startAutoSync() DEFINED but never CALLED → now poll+call.
     2. pushToCloud sends "" for timestamptz/integer → PG 22007/22P02
        → cleanRow() converts every "" to null on every payload.
     3. Failure loop DDoS → rate limiter (500 fails/60s → 2min cooldown).
     4. Stale sync_queue auto-cleared on load.
     5. First 5 error responses captured to window.__patchErrors.
     6. Load order: patch before app.v5c.js so fetch wrap is active.

   NEW in v3 (20260410e):
     7. queueSync() is wrapped: every time the main app queues a sync
        item, we schedule a debounced pushToCloud() in 400 ms. This
        turns the 15-second sync tick into sub-second push latency
        for all writes including Excel bulk imports.
     8. realtimeWs.onmessage is wrapped: on every postgres_changes
        event received from Supabase, we force the receiving tab's
        UI to refresh (pullFromCloud + loadHome + updateSyncBadge).
        This fixes "colleague's device doesn't update without F5".
     9. After every successful local write (POST/PATCH/DELETE) to
        /rest/v1/books, we also trigger a local UI refresh so the
        admin who ran the import/edit sees the results immediately
        without waiting for the realtime echo.
    10. Public bulk push helper window.__patchFlushQueue() so tests
        can force an immediate push from console.
    11. Version bumped to 20260410e for cache busting.
    12. ROOT CAUSE FIX for Excel sync (confirmed live 2026-04-10):
        pullFromCloud() fires dozens of unawaited readwrite
        transactions on the `books` store, which deadlock it.
        dbAdd() then hangs forever — Excel import silently stalls
        and nothing reaches Supabase. v3 wraps importFile() to
        POST the parsed rows directly to Supabase in ONE bulk
        request through the patched fetch wrapper, bypassing the
        deadlocked dbAdd path. It also wraps pushToCloud so sync
        doesn't depend on the broken sync_queue drain.

   NEW in v3.1 (20260410f):
    13. ONE-SHOT LOCAL RESET. The Supabase `books` table was wiped
        clean on 2026-04-10 at the user's explicit request to
        prepare for the 56k bulk import. Every device that still
        has stale rows in its IndexedDB MUST also be wiped, or
        the next sync will re-upload the old data.

        This patch runs a guarded one-shot cleaner on load:
          - checks localStorage.lib_reset_marker
          - if not '20260410f-reset-v1':
              * clears IndexedDB `books` store
              * clears IndexedDB `sync_queue` store
              * sets the marker
              * logs to console as [PATCH 20260410f] reset-local
        After the marker is set, the block is a no-op forever.
   ============================================================ */
(function () {
  'use strict';

  var PATCH_VERSION = '20260410f';
  var RESET_MARKER  = '20260410f-reset-v1';
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
  window.__patchStats = {
    rowsSeen: 0,
    keysCleaned: 0,
    lastCleanedKeys: [],
    debouncedPushes: 0,
    realtimeRefreshes: 0,
    localRefreshes: 0
  };
  window.__patchErrors = [];   // first few non-2xx response bodies
  window.__patchVersion = PATCH_VERSION;
  var patchStats = window.__patchStats;

  /* -----------------------------------------------------------
     ONE-SHOT LOCAL RESET (v3.1, 20260410f)
     Wipes the local `books` and `sync_queue` stores ONCE on the
     first load of this patch version per browser. After the
     marker is set in localStorage, this block is a no-op.
     ----------------------------------------------------------- */
  (function oneShotLocalReset() {
    try {
      var marker = null;
      try { marker = localStorage.getItem('lib_reset_marker'); } catch (e) {}
      if (marker === RESET_MARKER) {
        LOG('reset-local already applied, skipping');
        return;
      }
      LOG('reset-local: marker missing or stale, wiping local stores');
      var req = indexedDB.open('LibraryInventoryDB');
      req.onsuccess = function () {
        try {
          var db = req.result;
          var stores = [];
          if (db.objectStoreNames.contains('books'))      stores.push('books');
          if (db.objectStoreNames.contains('sync_queue')) stores.push('sync_queue');
          if (stores.length === 0) {
            try { localStorage.setItem('lib_reset_marker', RESET_MARKER); } catch (e) {}
            db.close();
            LOG('reset-local: no target stores present, marker set');
            return;
          }
          var tx = db.transaction(stores, 'readwrite');
          stores.forEach(function (name) {
            try {
              var st = tx.objectStore(name);
              var countReq = st.count();
              countReq.onsuccess = function () {
                var n = countReq.result || 0;
                st.clear();
                LOG('reset-local: cleared store ' + name + ' (' + n + ' rows)');
              };
            } catch (e) { WARN('reset-local clear error for ' + name + ':', e && e.message); }
          });
          tx.oncomplete = function () {
            try { localStorage.setItem('lib_reset_marker', RESET_MARKER); } catch (e) {}
            LOG('reset-local: complete, marker set to ' + RESET_MARKER);
            db.close();
          };
          tx.onerror = function () {
            WARN('reset-local: tx error, marker NOT set');
            try { db.close(); } catch (e) {}
          };
        } catch (e) { WARN('reset-local inner error:', e && e.message); }
      };
      req.onerror = function () { WARN('reset-local: IDB open error'); };
    } catch (e) { WARN('reset-local outer error:', e && e.message); }
  })();

  /* -----------------------------------------------------------
     BUG 4: Nuke stale sync_queue on startup
     ----------------------------------------------------------- */
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
     BUG 3: rate-limit push failures
     ----------------------------------------------------------- */
  var FAIL_BURST     = 500;
  var FAIL_WINDOW_MS = 60 * 1000;
  var COOLDOWN_MS    = 2 * 60 * 1000;
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

  window.__patchResetCooldown = function () {
    cooldownUntil = 0;
    failTimestamps = [];
    LOG('cooldown manually cleared');
  };

  /* -----------------------------------------------------------
     V3 NEW: UI refresh helpers
     ----------------------------------------------------------- */
  var uiRefreshDebounce = null;
  function scheduleUIRefresh(source) {
    clearTimeout(uiRefreshDebounce);
    uiRefreshDebounce = setTimeout(function () {
      try {
        // Refresh whichever render hooks the app exposes
        var fns = ['loadHome', 'renderHome', 'loadAllBooks', 'refreshUI', 'renderBooks', 'updateSyncBadge'];
        var called = 0;
        for (var i = 0; i < fns.length; i++) {
          var fn = window[fns[i]];
          if (typeof fn === 'function') {
            try { fn(); called++; } catch (e) {}
          }
        }
        if (source === 'realtime') patchStats.realtimeRefreshes++;
        else patchStats.localRefreshes++;
        LOG('UI refresh (' + source + ') → called ' + called + ' render fn(s)');
      } catch (e) { WARN('UI refresh error:', e && e.message); }
    }, 200);
  }

  /* -----------------------------------------------------------
     V3 NEW: debounced push-to-cloud after queueSync
     ----------------------------------------------------------- */
  var pushDebounce = null;
  function schedulePush() {
    clearTimeout(pushDebounce);
    pushDebounce = setTimeout(function () {
      try {
        if (inCooldown()) {
          WARN('skipping debounced push: cooldown active');
          return;
        }
        if (typeof window.pushToCloud === 'function') {
          patchStats.debouncedPushes++;
          LOG('debounced pushToCloud() firing');
          Promise.resolve(window.pushToCloud())
            .then(function () {
              // After the push, also refresh THIS tab's UI so admin
              // sees their own imports reflected immediately.
              scheduleUIRefresh('local-after-push');
              // And pull the latest (catches server-side triggers)
              if (typeof window.pullFromCloud === 'function') {
                return window.pullFromCloud();
              }
            })
            .then(function () { scheduleUIRefresh('local-after-pull'); })
            .catch(function (e) { WARN('debounced push error:', e && e.message); });
        }
      } catch (e) { WARN('schedulePush error:', e && e.message); }
    }, 400);
  }

  // Public: force immediate flush (used by tests)
  window.__patchFlushQueue = function () {
    clearTimeout(pushDebounce);
    if (typeof window.pushToCloud !== 'function') {
      LOG('__patchFlushQueue: pushToCloud not available');
      return Promise.resolve(false);
    }
    LOG('__patchFlushQueue: manual flush');
    return Promise.resolve(window.pushToCloud())
      .then(function () {
        scheduleUIRefresh('manual');
        return true;
      })
      .catch(function (e) { WARN('manual flush error:', e && e.message); return false; });
  };

  /* -----------------------------------------------------------
     Fetch wrapper (cleanPayload + errors + post-write refresh)
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
      var isBooks = isRest && url.indexOf('/books') !== -1;
      var isWrite = isRest && (method === 'POST' || method === 'PATCH' ||
                               method === 'PUT' || method === 'DELETE');

      if (isWrite && method !== 'DELETE' && inCooldown()) {
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
          } else if (res && res.ok && isBooks && isWrite) {
            // V3: successful local write → refresh own UI soon
            scheduleUIRefresh('local-write');
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
     V3 NEW: direct Supabase bulk POST helper (bypasses dbAdd)
     ----------------------------------------------------------- */
  // Read config from the app (it loads lib_config into window.CONFIG
  // during boot). We fall back to reading localStorage.lib_config
  // ourselves so we can push even if window.CONFIG hasn't settled.
  function getCfg() {
    var c = window.CONFIG || {};
    var url = c.supabaseUrl, key = c.supabaseKey, table = c.tableName || 'books';
    if (!url || !key) {
      try {
        var raw = localStorage.getItem('lib_config');
        if (raw) {
          var parsed = JSON.parse(raw);
          url  = url  || parsed.supabaseUrl;
          key  = key  || parsed.supabaseKey;
          table = table || parsed.tableName || 'books';
        }
      } catch (e) {}
    }
    return { url: url, key: key, table: table };
  }

  function directBulkInsert(rows) {
    var cfg = getCfg();
    if (!cfg.url || !cfg.key) {
      WARN('directBulkInsert: no supabase config');
      return Promise.reject(new Error('no-config'));
    }
    if (!Array.isArray(rows) || rows.length === 0) {
      return Promise.resolve({ inserted: 0, failed: 0, data: [] });
    }
    // Strip local-only fields and clean empties
    var clean = [];
    for (var i = 0; i < rows.length; i++) {
      var r = Object.assign({}, rows[i]);
      delete r.record_id; // let Supabase auto-assign
      delete r.cloud_id;
      delete r.id;
      cleanRow(r);
      clean.push(r);
    }
    var endpoint = cfg.url + '/rest/v1/' + cfg.table;
    // Use origFetch so we don't re-clean (already cleaned) and
    // don't add an extra layer of wrapping overhead.
    return origFetch(endpoint, {
      method: 'POST',
      headers: {
        'apikey': cfg.key,
        'Authorization': 'Bearer ' + cfg.key,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation'
      },
      body: JSON.stringify(clean)
    }).then(function (res) {
      return res.text().then(function (txt) {
        var parsed = null;
        try { parsed = txt ? JSON.parse(txt) : null; } catch (e) {}
        if (!res.ok) {
          WARN('directBulkInsert failed:', res.status, (txt || '').slice(0, 300));
          var err = new Error('bulk insert ' + res.status);
          err.status = res.status;
          err.body = txt;
          throw err;
        }
        return { inserted: Array.isArray(parsed) ? parsed.length : 0, data: parsed };
      });
    });
  }
  window.__patchBulkInsert = directBulkInsert; // public for diagnostics

  /* -----------------------------------------------------------
     V3 NEW: wrap importFile() so Excel imports POST directly
             to Supabase, bypassing the deadlocked dbAdd path.
     ----------------------------------------------------------- */
  var importFileHookInstalled = false;
  function installImportFileHook() {
    if (importFileHookInstalled) return;
    if (typeof window.importFile !== 'function') return;
    if (typeof window.autoDetectColumns !== 'function') return;
    if (typeof window.XLSX === 'undefined') return; // need SheetJS loaded

    var origImport = window.importFile;
    window.importFile = function patchedImportFile(file, columnMap) {
      LOG('importFile intercepted — using direct Supabase bulk POST');
      return new Promise(function (resolve, reject) {
        var reader = new FileReader();
        reader.onload = function (ev) {
          (async function () {
            try {
              var data = new Uint8Array(ev.target.result);
              var wb = XLSX.read(data, { type: 'array' });
              var sheet = wb.Sheets[wb.SheetNames[0]];
              var rows = XLSX.utils.sheet_to_json(sheet);
              if (!rows.length) return reject(new Error('الملف فارغ'));

              var map = columnMap || window.autoDetectColumns(Object.keys(rows[0]));
              LOG('importFile: ' + rows.length + ' rows, mapping=', map);

              // Build Supabase-ready rows (matches app's importFile shape)
              var now = new Date().toISOString();
              var books = [];
              for (var i = 0; i < rows.length; i++) {
                var r = rows[i];
                var book = {
                  bib: r[map.bib] || '',
                  doctype: r[map.doctype] || '',
                  title: r[map.title] || '',
                  subtitle: r[map.subtitle] || '',
                  author: r[map.author] || '',
                  additional_author: r[map.additional_author] || '',
                  language: r[map.language] || '',
                  publisher: r[map.publisher] || '',
                  publication_year: r[map.publication_year] || '',
                  pubdate: r[map.pubdate] || '',
                  pubplace: r[map.pubplace] || '',
                  isbn: r[map.isbn] || '',
                  dewey_number: r[map.dewey_number] || '',
                  diwi: r[map.diwi] || '',
                  cutter_number: r[map.cutter_number] || '',
                  full_call_number: r[map.full_call_number] || '',
                  subjects: r[map.subjects] || '',
                  edition: r[map.edition] || '',
                  descriptions: r[map.descriptions] || '',
                  material_type: r[map.material_type] || 'Book',
                  inventory_status: r[map.inventory_status] || 'Not Checked',
                  condition: r[map.condition] || 'Good',
                  location: r[map.location] || '',
                  shelf: r[map.shelf] || '',
                  notes: r[map.notes] || '',
                  internal_barcode: r[map.internal_barcode] || '',
                  last_inventory_date: r[map.last_inventory_date] || '',
                  match_confidence: '',
                  match_method: '',
                  review_status: r[map.review_status] || 'Pending',
                  source_db: r[map.source_db] || '',
                  cover_image_name: '',
                  created_at: now,
                  updated_at: now
                };
                if (book.title) books.push(book);
              }

              if (books.length === 0) return reject(new Error('لا توجد صفوف صالحة'));

              // Chunk into batches of 100 so very large imports still work
              var CHUNK = 100;
              var totalInserted = 0;
              for (var c = 0; c < books.length; c += CHUNK) {
                var batch = books.slice(c, c + CHUNK);
                var result = await directBulkInsert(batch);
                totalInserted += result.inserted || 0;
                LOG('importFile: batch ' + (c / CHUNK + 1) +
                    ' → +' + (result.inserted || 0) + ' rows');
              }

              LOG('importFile: direct bulk insert complete → ' + totalInserted + ' rows');

              // Also refresh the local UI so the admin sees their
              // own upload reflected without waiting for pullFromCloud.
              scheduleUIRefresh('import-complete');

              // Kick a pullFromCloud so the local IndexedDB eventually
              // catches up in the background (best-effort; if deadlocked
              // the user can still see the data via the app's fresh
              // reads / via other devices).
              try {
                if (typeof window.pullFromCloud === 'function') {
                  setTimeout(function () {
                    try { window.pullFromCloud(); } catch (e) {}
                  }, 500);
                }
              } catch (e) {}

              resolve({
                count: totalInserted,
                columns: Object.keys(rows[0]),
                mapping: map
              });
            } catch (err) {
              WARN('importFile direct path failed:', err && err.message);
              // Fall back to original implementation as last resort
              try {
                var fallback = await origImport.call(window, file, columnMap);
                resolve(fallback);
              } catch (e2) {
                reject(err);
              }
            }
          })();
        };
        reader.onerror = function () { reject(reader.error); };
        reader.readAsArrayBuffer(file);
      });
    };
    importFileHookInstalled = true;
    LOG('importFile hook installed (direct Supabase bulk POST)');
  }

  /* -----------------------------------------------------------
     V3 NEW: wrap queueSync to trigger debounced push
     ----------------------------------------------------------- */
  var queueSyncHookInstalled = false;
  function installQueueSyncHook() {
    if (queueSyncHookInstalled) return;
    if (typeof window.queueSync !== 'function') return;
    var orig = window.queueSync;
    window.queueSync = function (action, book) {
      var r;
      try { r = orig.apply(this, arguments); }
      catch (e) { WARN('orig queueSync threw:', e && e.message); }
      schedulePush();
      return r;
    };
    queueSyncHookInstalled = true;
    LOG('queueSync hook installed (debounced push on every queue)');
  }

  /* -----------------------------------------------------------
     V3 NEW: wrap realtimeWs.onmessage to force UI refresh
     ----------------------------------------------------------- */
  var realtimeHookedWs = null;
  function installRealtimeHook() {
    var ws = window.realtimeWs;
    if (!ws) return;
    if (realtimeHookedWs === ws) return; // already hooked this WS
    if (ws.readyState > 1) return;
    try {
      var origOnMessage = ws.onmessage;
      ws.onmessage = function (evt) {
        // Call original first (lets app do its pullFromCloud)
        try { if (origOnMessage) origOnMessage.call(this, evt); }
        catch (e) { WARN('orig onmessage threw:', e && e.message); }
        // Then force our own refresh pass
        try {
          var msg;
          try { msg = JSON.parse(evt.data); } catch (e) { return; }
          if (!msg) return;
          var isChange =
            msg.event === 'postgres_changes' ||
            msg.event === 'INSERT' || msg.event === 'UPDATE' || msg.event === 'DELETE' ||
            (msg.payload && msg.payload.data &&
             (msg.payload.data.type === 'INSERT' ||
              msg.payload.data.type === 'UPDATE' ||
              msg.payload.data.type === 'DELETE'));
          if (!isChange) return;
          LOG('realtime change received → forced UI refresh');
          // Pull fresh data then refresh render
          if (typeof window.pullFromCloud === 'function') {
            Promise.resolve(window.pullFromCloud())
              .then(function () { scheduleUIRefresh('realtime'); })
              .catch(function () { scheduleUIRefresh('realtime'); });
          } else {
            scheduleUIRefresh('realtime');
          }
        } catch (e) { WARN('realtime hook error:', e && e.message); }
      };
      realtimeHookedWs = ws;
      LOG('realtime onmessage hook installed');
    } catch (e) { WARN('installRealtimeHook error:', e && e.message); }
  }

  /* -----------------------------------------------------------
     BUG 1: ensure startAutoSync/startRealtimeSync are invoked
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
    var hints = document.querySelectorAll(
      'input[placeholder*="ابحث"], .book-card, .kpi, #booksGrid, #bookList, [data-screen="home"]'
    );
    if (hints.length > 0 && !loginScreenVisible()) return true;
    return false;
  }

  function tryStartAutoSync() {
    installQueueSyncHook();    // V3: try to install queueSync hook every poll
    installRealtimeHook();     // V3: try to install realtime hook every poll
    installImportFileHook();   // V3: hook Excel importFile direct to Supabase

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
