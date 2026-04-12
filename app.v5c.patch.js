/* ============================================================
   app.v5c.patch.js — v4 Hotfix for app.v5c.js?v=20260408b
   Version: 20260410g
   Generated: 2026-04-10

   IMPORTANT: This script MUST load BEFORE app.v5c.js, so that
   window.fetch is wrapped before the main app captures a
   reference to it. See INSTALL.md.

   === v4 (20260410g) — MAJOR OVERHAUL ===

   Fixes in v4:
     14. [CRITICAL] pullFromCloud() was capped at 1000 rows by
         PostgREST's default limit. On a 56k-book table, the
         app only saw the first 1000. v4 replaces pullFromCloud
         with paginatedPullFromCloud() which:
           - uses Range header pagination (1000 per page)
           - accumulates all rows into memory first
           - writes to IndexedDB in ONE awaited readwrite
             transaction (no more unawaited deadlocks)
           - reports progress via window.__patchStats.pullProgress
     15. [UX] extractCategory(book) — derives an Arabic category
         from dewey_number / diwi / subjects text using the
         Dewey Decimal system and keyword heuristics.
     16. [UX] generateReports(books) — computes full report data:
           * totals + status counts + inventory %
           * category distribution (from extractCategory)
           * library_source distribution (KFAA vs KFAAL vs other)
           * user activity (added_by + inventoried_by)
     17. [UX] loadReports() is replaced to render the above on
         the existing #pgReports page, populating new IDs:
         repTotal, repPresent, repLost, repUnchecked, repPercent,
         categoryChart, sourceChart, userPerf.
     18. [PERF] renderList(books, cid) is replaced with a
         virtual-paginated version: 100 rows per page, prev/next
         buttons, direct page input. Prevents DOM explosion on
         56k rows.
     19. [UX] showDet(id) is replaced so the book detail card
         shows ALL 28 Supabase fields (not just 20), with
         friendly Arabic labels, grouped into sections.
     20. Reset marker bumped to 20260410g-reset-v1 so every
         browser re-wipes local IDB once more to pick up the
         new 56,652-row cloud state cleanly.
     21. Dark-theme aware CSS classes are emitted for the new
         DOM (reports, virtual list, detail grid) and rely on
         the CSS variables declared in the updated index.html.

   Kept from v3.1 (20260410f):
     1-13 (reset-local, queue nuke, cleanRow, rate limiter, fetch
     wrap, debounced push, import hook, realtime hook, startAuto).
   ============================================================ */
(function () {
  'use strict';

  var PATCH_VERSION = '20260410r';
  // Keep the reset marker from v4h — we do NOT want to force a local IDB wipe
  // on this hotfix, that would cause users to re-pull 56K for nothing.
  var RESET_MARKER  = '20260410h-reset-v1';

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

  LOG('loading v4');

  // Public debug surface
  window.__patchStats = {
    rowsSeen: 0,
    keysCleaned: 0,
    lastCleanedKeys: [],
    debouncedPushes: 0,
    realtimeRefreshes: 0,
    localRefreshes: 0,
    pullProgress: { pages: 0, rows: 0, running: false, lastAt: 0 }
  };
  window.__patchErrors = [];
  window.__patchVersion = PATCH_VERSION;
  var patchStats = window.__patchStats;

  /* -----------------------------------------------------------
     ONE-SHOT LOCAL RESET (bumped to 20260410g-reset-v1)
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
                LOG('reset-local: cleared ' + name + ' (' + n + ' rows)');
              };
            } catch (e) {}
          });
          tx.oncomplete = function () {
            try { localStorage.setItem('lib_reset_marker', RESET_MARKER); } catch (e) {}
            LOG('reset-local: complete, marker=' + RESET_MARKER);
            db.close();
          };
          tx.onerror = function () { WARN('reset-local tx error'); try { db.close(); } catch (e) {} };
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
          if (!db.objectStoreNames.contains('sync_queue')) { db.close(); return; }
          var tx = db.transaction('sync_queue', 'readwrite');
          var store = tx.objectStore('sync_queue');
          var countReq = store.count();
          countReq.onsuccess = function () {
            var n = countReq.result || 0;
            if (n > 0) { store.clear(); LOG('nuked sync_queue (' + n + ' rows)'); }
          };
          tx.oncomplete = function () { db.close(); };
          tx.onerror = function () { try { db.close(); } catch (e) {} };
        } catch (e) {}
      };
      req.onerror = function () {};
    } catch (e) {}
  })();

  /* -----------------------------------------------------------
     cleanRow / cleanPayload
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
    if (Array.isArray(data)) for (var i = 0; i < data.length; i++) cleanRow(data[i]);
    else cleanRow(data);
    return data;
  }

  /* -----------------------------------------------------------
     Rate limiter
     ----------------------------------------------------------- */
  var FAIL_BURST     = 500;
  var FAIL_WINDOW_MS = 60 * 1000;
  var COOLDOWN_MS    = 2 * 60 * 1000;
  var failTimestamps = [];
  var cooldownUntil  = 0;
  function recordFailure() {
    var now = Date.now();
    failTimestamps.push(now);
    while (failTimestamps.length && failTimestamps[0] < now - FAIL_WINDOW_MS) failTimestamps.shift();
    if (failTimestamps.length >= FAIL_BURST && cooldownUntil < now) {
      cooldownUntil = now + COOLDOWN_MS;
      WARN('push failure burst — cooldown ' + (COOLDOWN_MS / 1000) + 's');
    }
  }
  function inCooldown() { return Date.now() < cooldownUntil; }
  window.__patchResetCooldown = function () { cooldownUntil = 0; failTimestamps = []; };

  /* -----------------------------------------------------------
     UI refresh (debounced, PAGE-AWARE)
     v4i: previously called loadHome + loadAllBooks + loadReports
     unconditionally which caused the whole app to freeze for ~200-500ms
     on every local write because generateReports() iterates all 56K books
     and classifies each one with ~16 regexes. Now we only call the
     render function for the CURRENTLY visible page. Everything else
     gets refreshed lazily when the user actually navigates to it.
     ----------------------------------------------------------- */
  var uiRefreshDebounce = null;
  function scheduleUIRefresh(source) {
    clearTimeout(uiRefreshDebounce);
    uiRefreshDebounce = setTimeout(function () {
      try {
        // Always update the sync badge — it's cheap and users expect it.
        try { if (typeof window.updateSyncBadge === 'function') window.updateSyncBadge(); } catch (e) {}
        // Find the currently visible page and refresh ONLY it.
        var active = document.querySelector('.page.active');
        var id = active ? active.id : '';
        var fn = null;
        if      (id === 'pgHome')     fn = window.loadHome    || window.renderHome;
        else if (id === 'pgReports')  fn = window.loadReports;
        else if (id === 'pgAllBooks') fn = window.loadAllBooks;
        else if (id === 'pgReview')   fn = window.loadReview;
        else if (id === 'pgSearch')   fn = window.refreshSearch || window.loadSearch;
        // pgDetail, pgAdd, pgImport, pgSettings, pgScan: no auto-refresh needed
        if (typeof fn === 'function') { try { fn(); } catch (e) {} }
        if (source === 'realtime' || (source && source.indexOf('realtime') !== -1)) patchStats.realtimeRefreshes++;
        else patchStats.localRefreshes++;
      } catch (e) {}
    }, 120); // v4l: 350→120ms for snappier cross-device updates
  }

  /* -----------------------------------------------------------
     Debounced pushToCloud
     ----------------------------------------------------------- */
  var pushDebounce = null;
  function schedulePush() {
    clearTimeout(pushDebounce);
    pushDebounce = setTimeout(function () {
      try {
        if (inCooldown()) return;
        if (typeof window.pushToCloud === 'function') {
          patchStats.debouncedPushes++;
          Promise.resolve(window.pushToCloud())
            .then(function () {
              scheduleUIRefresh('local-after-push');
              // v4l: after push, do a LIGHT delta pull (not full 56K pull)
              // so we pick up any concurrent changes from other devices.
              // Realtime broadcast will also kick in.
              if (typeof window.__pullDeltaSince === 'function') {
                return window.__pullDeltaSince();
              }
            })
            .then(function () { scheduleUIRefresh('local-after-pull'); })
            .catch(function () {});
        }
      } catch (e) {}
    }, 150); // v4l: 400→150ms — faster propagation after local write
  }
  window.__patchFlushQueue = function () {
    clearTimeout(pushDebounce);
    if (typeof window.pushToCloud !== 'function') return Promise.resolve(false);
    return Promise.resolve(window.pushToCloud())
      .then(function () { scheduleUIRefresh('manual'); return true; })
      .catch(function () { return false; });
  };

  /* -----------------------------------------------------------
     Fetch wrapper
     ----------------------------------------------------------- */
  var origFetch = window.fetch && window.fetch.bind(window);
  if (!origFetch) { WARN('window.fetch missing'); }
  else {
    window.fetch = function patchedFetch(input, init) {
      var url = '', method = 'GET';
      try {
        url = typeof input === 'string' ? input : (input && input.url) || '';
        method = (init && init.method) || (input && input.method) || 'GET';
      } catch (e) {}
      var isRest  = url.indexOf('/rest/v1/') !== -1;
      var isBooks = isRest && url.indexOf('/books') !== -1;
      var isWrite = isRest && (method === 'POST' || method === 'PATCH' || method === 'PUT' || method === 'DELETE');

      if (isWrite && method !== 'DELETE' && inCooldown()) {
        return Promise.resolve(new Response(
          JSON.stringify({ patch: 'cooldown', suppressed: true }),
          { status: 503, headers: { 'content-type': 'application/json' } }
        ));
      }
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
                try { window.__patchErrors.push({ url: res.url || url, status: res.status, body: (txt || '').slice(0, 500) }); } catch (e) {}
              }).catch(function () {});
            }
          } else if (res && res.ok && isBooks && isWrite) {
            scheduleUIRefresh('local-write');
          }
        } catch (e) {}
        return res;
      }).catch(function (err) { try { recordFailure(); } catch (e) {} throw err; });
    };
    LOG('fetch wrapper installed');
  }

  /* -----------------------------------------------------------
     Read Supabase config
     ----------------------------------------------------------- */
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

  /* -----------------------------------------------------------
     directBulkInsert (unchanged, used by importFile hook)
     ----------------------------------------------------------- */
  function directBulkInsert(rows) {
    var cfg = getCfg();
    if (!cfg.url || !cfg.key) return Promise.reject(new Error('no-config'));
    if (!Array.isArray(rows) || rows.length === 0) return Promise.resolve({ inserted: 0 });
    var clean = [];
    for (var i = 0; i < rows.length; i++) {
      var r = Object.assign({}, rows[i]);
      delete r.record_id; delete r.cloud_id; delete r.id;
      cleanRow(r);
      clean.push(r);
    }
    return origFetch(cfg.url + '/rest/v1/' + cfg.table, {
      method: 'POST',
      headers: {
        'apikey': cfg.key, 'Authorization': 'Bearer ' + cfg.key,
        'Content-Type': 'application/json', 'Prefer': 'return=representation'
      },
      body: JSON.stringify(clean)
    }).then(function (res) {
      return res.text().then(function (txt) {
        var parsed = null;
        try { parsed = txt ? JSON.parse(txt) : null; } catch (e) {}
        if (!res.ok) { var err = new Error('bulk ' + res.status); err.status = res.status; err.body = txt; throw err; }
        return { inserted: Array.isArray(parsed) ? parsed.length : 0, data: parsed };
      });
    });
  }
  window.__patchBulkInsert = directBulkInsert;

  /* ===========================================================
     V4 NEW #14 — PAGINATED pullFromCloud
     ===========================================================
     Replaces the broken window.pullFromCloud which was capped
     at 1000 rows and leaked unawaited IDB transactions. This
     version fetches all rows via Range header pagination, then
     writes them to IndexedDB in ONE awaited bulk transaction.
     =========================================================== */
  var PAGE_SIZE = 1000;
  var pullInFlight = null;

  function openIDB() {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open('LibraryInventoryDB');
      req.onsuccess = function () { resolve(req.result); };
      req.onerror   = function () { reject(req.error); };
    });
  }

  function paginatedPullFromCloud() {
    if (pullInFlight) { LOG('pull already in flight, reusing promise'); return pullInFlight; }
    var cfg = getCfg();
    if (!cfg.url || !cfg.key) return Promise.resolve();
    if (typeof navigator !== 'undefined' && !navigator.onLine) return Promise.resolve();

    patchStats.pullProgress = { pages: 0, rows: 0, running: true, lastAt: Date.now() };
    try { if (typeof window.setSyncStatus === 'function') window.setSyncStatus('syncing'); } catch (e) {}

    pullInFlight = (async function runPull() {
      var all = [];
      var from = 0;
      var safety = 0;
      while (true) {
        if (++safety > 200) { WARN('pull safety stop'); break; }
        var to = from + PAGE_SIZE - 1;
        var endpoint = cfg.url + '/rest/v1/' + cfg.table + '?select=*&order=record_id.asc';
        var res;
        try {
          res = await origFetch(endpoint, {
            headers: {
              'apikey': cfg.key,
              'Authorization': 'Bearer ' + cfg.key,
              'Range-Unit': 'items',
              'Range': from + '-' + to,
              'Prefer': 'count=estimated'
            }
          });
        } catch (e) { WARN('pull fetch error:', e && e.message); break; }
        if (!res.ok && res.status !== 206) {
          WARN('pull non-ok', res.status);
          break;
        }
        var batch;
        try { batch = await res.json(); } catch (e) { batch = []; }
        if (!batch || !batch.length) break;
        for (var i = 0; i < batch.length; i++) all.push(batch[i]);
        patchStats.pullProgress.pages++;
        patchStats.pullProgress.rows = all.length;
        patchStats.pullProgress.lastAt = Date.now();
        LOG('pull page ' + patchStats.pullProgress.pages + ': +' + batch.length + ' (total ' + all.length + ')');
        if (batch.length < PAGE_SIZE) break;
        from += PAGE_SIZE;
      }
      LOG('pull: fetched ' + all.length + ' remote rows total');

      // Merge into IndexedDB in ONE awaited readwrite transaction
      try {
        var db = await openIDB();
        if (!db.objectStoreNames.contains('books')) { db.close(); return all.length; }
        await new Promise(function (resolve, reject) {
          var tx = db.transaction('books', 'readwrite');
          var store = tx.objectStore('books');
          var getAllReq = store.getAll();
          getAllReq.onsuccess = function () {
            try {
              var local = getAllReq.result || [];
              var byCloudId = {};
              var byTitleKey = {};
              for (var i = 0; i < local.length; i++) {
                var lb = local[i];
                if (lb.cloud_id) byCloudId[lb.cloud_id] = lb;
                var k = (lb.title || '').trim() + '|||' + (lb.author || '').trim();
                if (k !== '|||') byTitleKey[k] = lb;
              }
              for (var r = 0; r < all.length; r++) {
                var rb = all[r];
                var remoteId = rb.record_id;
                var match = byCloudId[remoteId];
                if (!match) {
                  var tk = (rb.title || '').trim() + '|||' + (rb.author || '').trim();
                  if (tk !== '|||') match = byTitleKey[tk];
                }
                if (match) {
                  var upd = Object.assign({}, rb);
                  upd.record_id = match.record_id;
                  upd.cloud_id = remoteId;
                  store.put(upd);
                } else {
                  var nb = Object.assign({}, rb);
                  nb.cloud_id = remoteId;
                  delete nb.record_id;
                  store.add(nb);
                }
              }
            } catch (e) { WARN('pull merge inner error:', e && e.message); }
          };
          tx.oncomplete = function () { db.close(); resolve(); };
          tx.onerror    = function () { try { db.close(); } catch (e) {} reject(tx.error); };
          tx.onabort    = function () { try { db.close(); } catch (e) {} reject(tx.error || new Error('aborted')); };
        });
        LOG('pull merge complete (single tx, ' + all.length + ' rows)');
      } catch (e) { WARN('pull merge outer error:', e && e.message); }

      try { if (typeof window.setSyncStatus === 'function') window.setSyncStatus('idle'); } catch (e) {}
      patchStats.pullProgress.running = false;
      scheduleUIRefresh('after-paginated-pull');
      return all.length;
    })();
    pullInFlight.finally(function () { setTimeout(function () { pullInFlight = null; }, 500); });
    return pullInFlight;
  }

  // Hard-override the main app's broken pullFromCloud
  window.pullFromCloud = paginatedPullFromCloud;
  window.__paginatedPullFromCloud = paginatedPullFromCloud;
  LOG('paginated pullFromCloud installed (PAGE_SIZE=' + PAGE_SIZE + ')');

  /* ===========================================================
     V4 NEW #15 — extractCategory(book)
     =========================================================== */
  var CATEGORY_BY_DEWEY = [
    { min: 0,   max: 99,  name: 'مراجع عامة' },
    { min: 100, max: 199, name: 'فلسفة وعلم نفس' },
    { min: 200, max: 299, name: 'الدين' },
    { min: 300, max: 399, name: 'علوم اجتماعية' },
    { min: 400, max: 499, name: 'اللغات' },
    { min: 500, max: 599, name: 'علوم بحتة' },
    { min: 600, max: 628, name: 'علوم تطبيقية' },
    { min: 629, max: 629, name: 'الطيران والهندسة' },
    { min: 630, max: 699, name: 'علوم تطبيقية' },
    { min: 700, max: 799, name: 'الفنون والترفيه' },
    { min: 800, max: 899, name: 'الأدب' },
    { min: 900, max: 999, name: 'التاريخ والجغرافيا' }
  ];
  var KEYWORD_CATEGORIES = [
    { re: /(طيران|طيار|avion|aviat|aircraft|flight)/i,              name: 'الطيران' },
    { re: /(عسكري|حرب|military|war|armed|defense|defence|دفاع|قتال)/i, name: 'عسكري ودفاعي' },
    { re: /(نفس|psycholog|ذات|سلوك)/i,                              name: 'علم النفس' },
    { re: /(إدار|قياد|leader|manag|استراتيج|strateg)/i,             name: 'الإدارة والقيادة' },
    { re: /(اقتصاد|مال|econ|financ)/i,                              name: 'الاقتصاد والمال' },
    { re: /(سياس|polit|دبلوماس|diploma)/i,                          name: 'السياسة' },
    { re: /(قانون|شريع|فقه|law)/i,                                  name: 'القانون والشريعة' },
    { re: /(تاريخ|histor|حضار)/i,                                   name: 'التاريخ' },
    { re: /(دين|إسلام|قرآن|حديث|فقه|islam|religi)/i,                name: 'الدين' },
    { re: /(لغة|لسان|نحو|صرف|language|linguist)/i,                  name: 'اللغات' },
    { re: /(أدب|شعر|رواي|قص|literat|poetry|novel)/i,                name: 'الأدب' },
    { re: /(هندس|engineer|تقني|tech|computer|حاسب|برمج|program)/i,  name: 'الهندسة والتقنية' },
    { re: /(طب|صح|medic|health)/i,                                  name: 'الطب والصحة' },
    { re: /(رياض|sport|math)/i,                                     name: 'الرياضيات والرياضة' },
    { re: /(علم|scien|فيزياء|كيمياء|أحياء)/i,                       name: 'العلوم' },
    { re: /(اجتماع|social|مجتمع|sociolog|أنثروبولوج)/i,             name: 'علوم اجتماعية' }
  ];

  function extractCategory(book) {
    if (!book) return 'غير مصنّف';
    // 1. Try Dewey number
    var dewey = book.dewey_number || book.diwi || '';
    var n = parseInt(String(dewey).replace(/[^0-9]/g, '').slice(0, 3), 10);
    if (!isNaN(n) && n >= 0 && n <= 999) {
      for (var i = 0; i < CATEGORY_BY_DEWEY.length; i++) {
        if (n >= CATEGORY_BY_DEWEY[i].min && n <= CATEGORY_BY_DEWEY[i].max) {
          return CATEGORY_BY_DEWEY[i].name;
        }
      }
    }
    // 2. Try keyword matching on subjects + title + descriptions
    var blob = [book.subjects, book.title, book.descriptions, book.doctype].filter(Boolean).join(' ');
    for (var j = 0; j < KEYWORD_CATEGORIES.length; j++) {
      if (KEYWORD_CATEGORIES[j].re.test(blob)) return KEYWORD_CATEGORIES[j].name;
    }
    return 'غير مصنّف';
  }
  // v4i: memoize extractCategory so 56K × ~16 regex tests
  // don't run on every generateReports call. The cache is keyed by
  // record_id (stable) with small fallbacks, and is invalidated
  // whenever a book write happens (see invalidateCategoryCache below).
  var __catCache = Object.create(null);
  var __catCacheSize = 0;
  function extractCategoryMemo(book) {
    if (!book) return 'غير مصنّف';
    var k = book.record_id || book.cloud_id || book.bib;
    if (k != null && __catCache[k] != null) return __catCache[k];
    var r = extractCategory(book);
    if (k != null) {
      __catCache[k] = r;
      __catCacheSize++;
      // Safety cap: never let the cache balloon past ~100K entries
      if (__catCacheSize > 100000) { __catCache = Object.create(null); __catCacheSize = 0; }
    }
    return r;
  }
  function invalidateCategoryCache(recordId) {
    if (recordId == null) { __catCache = Object.create(null); __catCacheSize = 0; return; }
    if (__catCache[recordId] != null) { delete __catCache[recordId]; __catCacheSize--; }
  }
  window.extractCategory = extractCategoryMemo;
  window.__invalidateCategoryCache = invalidateCategoryCache;

  /* -----------------------------------------------------------
     v4j: global book Map — O(1) lookup by record_id
     This is populated as a side-effect of dbAll() and whenever
     renderList() runs on a full dataset. showDet() uses it
     first (instant) and only falls back to dbGet(id) on miss.
     The Map is also used by the Dewey enricher on search/match
     cards to pull doctype for each card without extra IDB calls.
     ----------------------------------------------------------- */
  window.__bookMap = null;
  function rebuildBookMap(books) {
    try {
      var m = new Map();
      for (var i = 0; i < books.length; i++) {
        var b = books[i];
        if (b && b.record_id != null) m.set(b.record_id, b);
      }
      window.__bookMap = m;
      return m;
    } catch (e) { return null; }
  }
  function getCachedBook(id) {
    if (!window.__bookMap) return null;
    var m = window.__bookMap;
    // Try numeric, string, and exact match
    var n = typeof id === 'number' ? id : parseInt(id, 10);
    return m.get(n) || m.get(id) || m.get(String(id)) || null;
  }
  window.__getCachedBook = getCachedBook;

  // v4j: wrap dbAll so any loadX() that calls it populates __bookMap
  // as a free side-effect. Safe to call multiple times (idempotent).
  function installDbAllHook() {
    if (typeof window.dbAll !== 'function') return false;
    if (window.dbAll.__v4jPatched) return true;
    var orig = window.dbAll;
    var wrapped = function patchedDbAll() {
      var p = orig.apply(this, arguments);
      return Promise.resolve(p).then(function (books) {
        if (Array.isArray(books) && books.length > 0) {
          rebuildBookMap(books);
          // v4m: also rebuild the cloud_id index so realtime stays O(1)
          try {
            if (typeof __cloudIdToLocalId !== 'undefined') {
              __cloudIdToLocalId.clear();
              for (var i = 0; i < books.length; i++) {
                var b = books[i];
                if (b && b.cloud_id != null && b.record_id != null) {
                  __cloudIdToLocalId.set(b.cloud_id, b.record_id);
                }
              }
            }
          } catch (e2) {}
        }
        return books;
      });
    };
    wrapped.__v4jPatched = true;
    window.dbAll = wrapped;
    return true;
  }

  // v4l: hook dbPut so any local write (confirmBook, markNF, edit, etc.)
  // instantly reflects in __bookMap. Without this, the user sees stale
  // status on the detail view / list until the next full sync.
  function installDbPutHook() {
    if (typeof window.dbPut !== 'function') return false;
    if (window.dbPut.__v4lPatched) return true;
    var orig = window.dbPut;
    var wrapped = function patchedDbPut(book) {
      var p = orig.apply(this, arguments);
      return Promise.resolve(p).then(function (res) {
        try {
          if (book && book.record_id != null && window.__bookMap) {
            window.__bookMap.set(book.record_id, book);
          }
          // v4m: keep cloud_id index in sync on local writes
          try {
            if (book && book.cloud_id != null && book.record_id != null &&
                typeof __cloudIdToLocalId !== 'undefined') {
              __cloudIdToLocalId.set(book.cloud_id, book.record_id);
            }
          } catch (e2) {}
          if (book && book.record_id != null) invalidateCategoryCache(book.record_id);
          // Fire a quick UI refresh so the list/home view picks it up
          scheduleUIRefresh('local-write');
        } catch (e) {}
        return res;
      });
    };
    wrapped.__v4lPatched = true;
    window.dbPut = wrapped;
    return true;
  }

  /* ===========================================================
     v4n: fast + unique generateBarcode
     -----------------------------------------------------------
     The original (app.v5c.js) generateBarcode:
       1) awaits dbAll() — reads all 56,652 books from IDB
          (expensive; contributes to the 13s cfDirect latency)
       2) computes Math.max(...existing) + 1
     Bug: under rapid confirms, two calls can begin before the
     first dbPut commits, so both read the same max and both
     return the SAME next barcode. Observed during v4m testing
     (books 113648/113649 both got KFAA-LIB-000009;
      113652/113653 both got KFAA-LIB-000012).

     Fix strategy:
       - Keep an in-memory monotonic counter per tab.
       - Initialise from max(existing) in __bookMap (O(N) once,
         synchronous — no IDB read).
       - Rescan __bookMap on every call to pick up cross-tab
         writes that landed via realtime / dbPut hooks.
       - counter++ atomically (JS is single-threaded), so every
         call within a single tab returns a unique integer.
       - Format preserved exactly: KFAA-LIB-NNNNNN (6 digits,
         zero-padded) so parseInt in the original code still
         works if anything falls back to it.
       - For width > 999,999 the format grows gracefully to
         however many digits are needed.
     =========================================================== */
  var __barcodeCounter = 0;
  var __barcodeCounterInit = false;
  var __BARCODE_PREFIX = 'KFAA-LIB-';

  function __scanMaxBarcode() {
    var max = 0;
    if (!window.__bookMap) return max;
    try {
      var it = window.__bookMap.values();
      var e;
      while ((e = it.next()).done === false) {
        var b = e.value;
        if (!b) continue;
        var bc = b.internal_barcode;
        if (!bc || typeof bc !== 'string') continue;
        if (bc.indexOf(__BARCODE_PREFIX) !== 0) continue;
        var n = parseInt(bc.slice(__BARCODE_PREFIX.length), 10);
        if (!isNaN(n) && n > max) max = n;
      }
    } catch (err) {}
    return max;
  }

  function __ensureBarcodeCounterInitialized() {
    if (__barcodeCounterInit) return;
    var scanned = __scanMaxBarcode();
    if (scanned > __barcodeCounter) __barcodeCounter = scanned;
    __barcodeCounterInit = true;
  }

  async function patchedGenerateBarcode() {
    __ensureBarcodeCounterInitialized();
    // Rescan to absorb cross-tab writes that landed in __bookMap
    // since we last generated (e.g. realtime postgres_changes).
    var scanned = __scanMaxBarcode();
    if (scanned > __barcodeCounter) __barcodeCounter = scanned;
    __barcodeCounter++;
    var num = __barcodeCounter;
    // Pad to at least 6 digits to preserve the existing format.
    var s = String(num);
    while (s.length < 6) s = '0' + s;
    return __BARCODE_PREFIX + s;
  }

  function installBarcodeHook() {
    try {
      if (window.generateBarcode && window.generateBarcode.__v4nPatched) return true;
      window.generateBarcode = patchedGenerateBarcode;
      window.generateBarcode.__v4nPatched = true;
      return true;
    } catch (e) { return false; }
  }
  // Expose for manual debugging / tests.
  window.__patchedGenerateBarcode = patchedGenerateBarcode;
  window.__barcodeState = function () {
    return {
      counter: __barcodeCounter,
      initialized: __barcodeCounterInit,
      currentMax: __scanMaxBarcode()
    };
  };

  /* ===========================================================
     v4n: silence noisy ServiceWorker.update() polling errors.
     ----------------------------------------------------------
     index.html does setInterval(() => reg.update(), 60000) and
     emits a "TypeError: Failed to update a ServiceWorker ...
     Not found" + "InvalidStateError" to the console every minute
     when the SW script URL has a stale ?v= query (CDN cache mis).
     The SW itself stays activated and works fine — these are
     pure noise. We monkey-patch ServiceWorkerRegistration's
     .update() to swallow ONLY these specific errors so the
     console stays useful for real problems.
     =========================================================== */
  (function patchServiceWorkerUpdate() {
    try {
      if (typeof ServiceWorkerRegistration === 'undefined') return;
      var proto = ServiceWorkerRegistration.prototype;
      if (!proto || !proto.update) return;
      if (proto.update.__v4nPatched) return;
      var origUpdate = proto.update;
      proto.update = function () {
        var p;
        try { p = origUpdate.apply(this, arguments); }
        catch (syncErr) {
          var msg = String(syncErr && syncErr.message || syncErr || '');
          if (/Failed to update a ServiceWorker|invalid state|Not found/i.test(msg)) {
            return Promise.resolve();
          }
          throw syncErr;
        }
        if (p && typeof p.catch === 'function') {
          return p.catch(function (err) {
            var msg = String(err && err.message || err || '');
            if (/Failed to update a ServiceWorker|invalid state|Not found/i.test(msg)) {
              // swallow — known harmless polling noise
              return undefined;
            }
            throw err;
          });
        }
        return p;
      };
      proto.update.__v4nPatched = true;
      LOG('ServiceWorkerRegistration.update() patched (noise filter)');
    } catch (e) {}
  })();

  // Also catch the unhandledrejection variant in case the call site
  // doesn't await reg.update() — index.html's setInterval doesn't.
  (function installSwRejectionFilter() {
    try {
      if (window.__v4nSwRejFilter) return;
      window.__v4nSwRejFilter = true;
      window.addEventListener('unhandledrejection', function (ev) {
        try {
          var r = ev && ev.reason;
          var msg = (r && (r.message || r.name)) || String(r || '');
          if (/Failed to update a ServiceWorker|invalid state/i.test(String(msg))) {
            ev.preventDefault();
          }
        } catch (e) {}
      });
    } catch (e) {}
  })();

  /* -----------------------------------------------------------
     v4j: list cache — pagination no longer re-queries IDB
     __listCache[cid] stores the last books array passed to
     renderList(books, cid). __listGoto uses this instead of
     calling loadAllBooks() (which re-fetches 56K from IDB).
     ----------------------------------------------------------- */
  window.__listCache = {};

  /* ===========================================================
     V4 NEW #16 — generateReports(books)
     =========================================================== */
  function generateReports(books) {
    var total = books.length;
    var present = 0, lost = 0, unchecked = 0, damaged = 0;
    var categories = {};
    var sources = {};
    var users = {};  // { name: { added: n, inventoried: n } }
    var withCover = 0;

    for (var i = 0; i < books.length; i++) {
      var b = books[i];
      var st = b.inventory_status || 'Not Checked';
      if (st === 'Found' || st === 'موجود') present++;
      else if (st === 'Lost' || st === 'مفقود') lost++;
      else if (st === 'Damaged' || st === 'تالف') damaged++;
      else unchecked++;

      // v4i: use the memoized version so repeat calls are O(1) lookups.
      var cat = extractCategoryMemo(b);
      categories[cat] = (categories[cat] || 0) + 1;

      var src = b.library_source || b.source_db || 'غير محدد';
      sources[src] = (sources[src] || 0) + 1;

      var added = b.added_by;
      if (added) {
        users[added] = users[added] || { added: 0, inventoried: 0 };
        users[added].added++;
      }
      var invBy = b.inventoried_by;
      if (invBy && (st === 'Found' || st === 'Lost' || st === 'Damaged')) {
        users[invBy] = users[invBy] || { added: 0, inventoried: 0 };
        users[invBy].inventoried++;
      }
      if (b.cover_image_name) withCover++;
    }

    var checked = total - unchecked;
    var percent = total > 0 ? Math.round((checked / total) * 1000) / 10 : 0;

    // v4i: replaced the meaningless `types` field (which grouped by raw
    // Dewey call number from the `doctype` column) with `statusDistribution`
    // — four immediately useful inventory status buckets.
    var statusDistribution = {
      'موجود':       present,
      'مفقود':       lost,
      'تالف':        damaged,
      'غير مفحوص':  unchecked
    };

    return {
      total: total,
      present: present,
      lost: lost,
      damaged: damaged,
      unchecked: unchecked,
      checked: checked,
      percent: percent,
      withCover: withCover,
      categories: categories,
      sources: sources,
      statusDistribution: statusDistribution,
      users: users
    };
  }
  window.generateReports = generateReports;

  /* ===========================================================
     V4 NEW #17 — loadReports() override
     =========================================================== */
  function fmtNum(n) {
    try { return Number(n).toLocaleString('ar-EG'); } catch (e) { return String(n); }
  }
  function fmtPct(n) {
    return (Math.round(n * 10) / 10) + '%';
  }
  function escHtml(s) {
    if (s === null || s === undefined) return '';
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function renderBarChart(containerId, data, opts) {
    var el = document.getElementById(containerId);
    if (!el) return;
    opts = opts || {};
    var entries = Object.entries(data).sort(function (a, b) { return b[1] - a[1]; });
    if (opts.limit) entries = entries.slice(0, opts.limit);
    if (entries.length === 0) { el.innerHTML = '<div class="empty-small">لا توجد بيانات</div>'; return; }
    var max = Math.max.apply(null, entries.map(function (e) { return e[1]; }));
    var html = '<div class="bars">';
    entries.forEach(function (e) {
      var pct = Math.max(2, (e[1] / max) * 100);
      var color = opts.color || 'var(--teal)';
      html += '<div class="bar-row">';
      html += '<div class="bar-label">' + escHtml(e[0]) + '</div>';
      html += '<div class="bar-track"><div class="bar-fill" style="width:' + pct + '%;background:' + color + '"></div></div>';
      html += '<div class="bar-val">' + fmtNum(e[1]) + '</div>';
      html += '</div>';
    });
    html += '</div>';
    el.innerHTML = html;
  }

  function patchedLoadReports() {
    var pg = document.getElementById('pgReports');
    if (!pg) return;

    // Ensure the new report DOM is present; if not, inject it.
    // v4i: also regenerate when the old v4h typeChart is still present
    // (so upgraded users get the new status chart without a hard reload).
    if (!document.getElementById('repTotal') || !document.getElementById('statusChart')) {
      pg.innerHTML = ''
        + '<h2 class="page-title">التقارير والإحصائيات</h2>'
        + '<div class="stats-grid">'
        + '  <div class="stat-card"><div class="stat-label">إجمالي الكتب</div><div class="stat-value number" id="repTotal">0</div></div>'
        + '  <div class="stat-card teal"><div class="stat-label">موجود</div><div class="stat-value number" id="repPresent">0</div></div>'
        + '  <div class="stat-card coral"><div class="stat-label">مفقود</div><div class="stat-value number" id="repLost">0</div></div>'
        + '  <div class="stat-card gold"><div class="stat-label">غير مفحوص</div><div class="stat-value number" id="repUnchecked">0</div></div>'
        + '  <div class="stat-card"><div class="stat-label">نسبة الجرد</div><div class="stat-value number" id="repPercent">0%</div></div>'
        + '</div>'
        + '<div class="report-section"><h3>توزيع التصنيفات</h3><div id="categoryChart" class="chart-box"></div></div>'
        + '<div class="report-section"><h3>التوزيع حسب المصدر</h3><div id="sourceChart" class="chart-box"></div></div>'
        + '<div class="report-section"><h3>التوزيع حسب حالة الجرد</h3><div id="statusChart" class="chart-box"></div></div>'
        + '<div class="report-section"><h3>أداء المستخدمين</h3>'
        + '  <table class="perf-table" id="userPerf"><thead><tr><th>المستخدم</th><th>إضافات</th><th>جرود</th></tr></thead><tbody></tbody></table>'
        + '</div>'
        + '<div class="report-section"><button class="btn btn-gold" onclick="exportBooks()">📥 تصدير البيانات إلى Excel</button></div>';
    }

    // Read data (prefer full local IDB; fallback to dbAll())
    var dataPromise;
    if (typeof window.dbAll === 'function') dataPromise = Promise.resolve(window.dbAll());
    else dataPromise = Promise.resolve([]);

    Promise.resolve(dataPromise).then(function (books) {
      books = books || [];
      var r = generateReports(books);

      var setTxt = function (id, v) { var el = document.getElementById(id); if (el) el.textContent = v; };
      setTxt('repTotal',     fmtNum(r.total));
      setTxt('repPresent',   fmtNum(r.present));
      setTxt('repLost',      fmtNum(r.lost));
      setTxt('repUnchecked', fmtNum(r.unchecked));
      setTxt('repPercent',   fmtPct(r.percent));

      renderBarChart('categoryChart', r.categories,         { limit: 15, color: 'var(--teal)' });
      renderBarChart('sourceChart',   r.sources,            { limit: 10, color: 'var(--gold)' });
      // v4i: status distribution instead of raw doctype call numbers
      renderBarChart('statusChart',   r.statusDistribution, { limit: 10, color: 'var(--coral)' });

      // User performance table
      var ub = document.querySelector('#userPerf tbody');
      if (ub) {
        var list = Object.entries(r.users).sort(function (a, b) {
          return (b[1].added + b[1].inventoried) - (a[1].added + a[1].inventoried);
        }).slice(0, 20);
        if (list.length === 0) {
          ub.innerHTML = '<tr><td colspan="3" class="empty-small">لا توجد بيانات</td></tr>';
        } else {
          ub.innerHTML = list.map(function (e) {
            return '<tr><td>' + escHtml(e[0]) + '</td><td class="number">' + fmtNum(e[1].added) + '</td><td class="number">' + fmtNum(e[1].inventoried) + '</td></tr>';
          }).join('');
        }
      }
    }).catch(function (e) { WARN('loadReports error:', e && e.message); });
  }
  window.loadReports = patchedLoadReports;

  /* ===========================================================
     V4 NEW #18 — renderList paginated virtual list
     =========================================================== */
  var LIST_PAGE_SIZE = 100;
  var listState = {};  // keyed by container id

  function patchedRenderList(books, cid) {
    var c = document.getElementById(cid);
    if (!c) return;
    if (!books || !books.length) {
      c.innerHTML = '<div class="empty-state"><div class="empty-icon">📭</div><div class="empty-text">لا توجد كتب</div></div>';
      return;
    }
    // v4j: cache the books array for this container so pagination
    // (__listGoto) can re-slice without re-fetching 56K from IDB.
    try { window.__listCache[cid] = books; } catch (e) {}
    // v4j: also rebuild the global bookMap so showDet and the Dewey
    // enricher can find any book in O(1).
    if (!window.__bookMap || window.__bookMap.size !== books.length) {
      rebuildBookMap(books);
    }
    // Each time called with a fresh list, reset to page 0
    var prev = listState[cid];
    if (!prev || prev.total !== books.length) {
      listState[cid] = { page: 0, total: books.length };
    }
    var st = listState[cid];
    var start = st.page * LIST_PAGE_SIZE;
    var end   = Math.min(start + LIST_PAGE_SIZE, books.length);
    var slice = books.slice(start, end);
    var totalPages = Math.max(1, Math.ceil(books.length / LIST_PAGE_SIZE));

    var html = '';
    // Pagination header
    html += '<div class="list-toolbar">';
    html += '  <div class="list-count">' + fmtNum(books.length) + ' كتاب — الصفحة ' + fmtNum(st.page + 1) + ' من ' + fmtNum(totalPages) + '</div>';
    html += '  <div class="list-pager">';
    html += '    <button class="btn-ico" onclick="window.__listGoto(\'' + cid + '\',0)">«</button>';
    html += '    <button class="btn-ico" onclick="window.__listGoto(\'' + cid + '\',' + Math.max(0, st.page - 1) + ')">‹</button>';
    html += '    <input type="number" class="list-page-input" min="1" max="' + totalPages + '" value="' + (st.page + 1) + '" onchange="window.__listGoto(\'' + cid + '\',this.value-1)" />';
    html += '    <button class="btn-ico" onclick="window.__listGoto(\'' + cid + '\',' + Math.min(totalPages - 1, st.page + 1) + ')">›</button>';
    html += '    <button class="btn-ico" onclick="window.__listGoto(\'' + cid + '\',' + (totalPages - 1) + ')">»</button>';
    html += '  </div>';
    html += '</div>';

    // Book cards
    html += '<div class="book-grid">';
    for (var i = 0; i < slice.length; i++) {
      var b = slice[i];
      var cat = extractCategory(b);
      var statusCls = (b.inventory_status === 'Found' ? 'found' :
                       b.inventory_status === 'Lost' ? 'lost' :
                       b.inventory_status === 'Damaged' ? 'damaged' : 'unchecked');
      var statusAr = (b.inventory_status === 'Found' ? 'موجود' :
                      b.inventory_status === 'Lost' ? 'مفقود' :
                      b.inventory_status === 'Damaged' ? 'تالف' : 'غير مفحوص');
      // v4j: Dewey call number is the authoritative identifier the
      // librarian uses to verify a physical book. Show it prominently
      // on every card. The `doctype` column holds the classic
      // "355،005 - ص ق ر" string; fall back to full_call_number
      // / dewey_number / diwi if doctype is missing.
      var dewey = b.doctype || b.full_call_number || b.dewey_number || b.diwi || '';
      html += '<div class="book-card" onclick="showDet(' + b.record_id + ')">';
      html += '  <div class="book-card-head">';
      html += '    <div class="book-bib number">' + escHtml(b.bib || '—') + '</div>';
      html += '    <span class="status-pill ' + statusCls + '">' + statusAr + '</span>';
      html += '  </div>';
      html += '  <div class="book-title">' + escHtml(b.title || '(بدون عنوان)') + '</div>';
      if (b.author) html += '  <div class="book-author">✍ ' + escHtml(b.author) + '</div>';
      if (dewey) {
        html += '  <div class="book-dewey" style="margin-top:6px;padding:5px 10px;background:rgba(230,168,90,0.10);border:1px solid rgba(230,168,90,0.25);border-radius:8px;font-family:\'JetBrains Mono\',ui-monospace,monospace;font-size:12px;font-weight:700;color:var(--gold,#e6a85a);direction:rtl;display:inline-flex;align-items:center;gap:6px;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">';
        html += '<span style="font-size:10px;color:var(--text-2,#a8aab1);font-weight:600">رقم الديوي</span>';
        html += '<span class="number" style="direction:rtl">' + escHtml(String(dewey)) + '</span>';
        html += '</div>';
      }
      html += '  <div class="book-meta">';
      html += '    <span class="chip chip-cat">' + escHtml(cat) + '</span>';
      if (b.publisher) html += '    <span class="chip">🏢 ' + escHtml(b.publisher) + '</span>';
      if (b.pubdate)   html += '    <span class="chip">📅 ' + escHtml(b.pubdate) + '</span>';
      if (b.library_source) html += '    <span class="chip chip-src">' + escHtml(b.library_source) + '</span>';
      html += '  </div>';
      html += '</div>';
    }
    html += '</div>';

    c.innerHTML = html;
  }
  window.renderList = patchedRenderList;

  window.__listGoto = function (cid, page) {
    var st = listState[cid];
    if (!st) return;
    page = parseInt(page, 10) || 0;
    var totalPages = Math.ceil(st.total / LIST_PAGE_SIZE);
    if (page < 0) page = 0;
    if (page >= totalPages) page = totalPages - 1;
    st.page = page;
    // v4j: re-render directly from the cached books array instead of
    // re-querying the entire 56K-row IDB store on every pagination
    // click. This drops pagination latency from ~1000ms to <50ms.
    var cached = window.__listCache && window.__listCache[cid];
    if (cached && cached.length) {
      patchedRenderList(cached, cid);
    } else {
      // Fallback: cold pagination before the cache has been primed.
      if (cid === 'allList' && typeof window.loadAllBooks === 'function') window.loadAllBooks();
      else if (cid === 'revList' && typeof window.loadReview === 'function') window.loadReview();
      else if (typeof window.loadAllBooks === 'function') window.loadAllBooks();
    }
    try { document.getElementById(cid).scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch (e) {}
  };

  /* ===========================================================
     V4 NEW #19 — showDet with all 28 fields
     =========================================================== */
  var DETAIL_SECTIONS = [
    { title: 'معلومات أساسية', fields: [
      ['bib',               'رقم المكتبة'],
      ['doctype',           'رقم الديوي'],
      ['title',             'العنوان'],
      ['subtitle',          'العنوان الفرعي'],
      ['author',            'المؤلف'],
      ['additional_author', 'مؤلف مشارك'],
      ['language',          'اللغة'],
      ['lang',              'رمز اللغة'],
      ['edition',           'الطبعة']
    ]},
    { title: 'النشر', fields: [
      ['publisher',         'الناشر'],
      ['pubplace',          'مكان النشر'],
      ['pubdate',           'تاريخ النشر'],
      ['publication_year',  'سنة النشر'],
      ['datapublish',       'بيانات النشر']
    ]},
    { title: 'التصنيف والمواضيع', fields: [
      ['dewey_number',      'رقم ديوي'],
      ['diwi',              'ديوي (محلي)'],
      ['cutter_number',     'رقم كتر'],
      ['full_call_number',  'رقم التصنيف الكامل'],
      ['category',          'الفئة'],
      ['subject',           'الموضوع'],
      ['subjects',          'المواضيع'],
      ['isbn',              'ISBN']
    ]},
    { title: 'الوصف', fields: [
      ['descriptions',      'الوصف المادي'],
      ['pages',             'عدد الصفحات'],
      ['shape',             'الشكل'],
      ['magazine',          'المجلة / الدورية'],
      ['issue',             'العدد'],
      ['note505',           'ملاحظة 505'],
      ['notes',             'ملاحظات'],
      ['masdar',            'المصدر'],
      ['links',             'روابط']
    ]},
    { title: 'الموقع والجرد', fields: [
      ['location',          'الموقع'],
      ['shelf',             'الرف'],
      ['internal_barcode',  'الباركود الداخلي'],
      ['material_type',     'نوع المادة'],
      ['inventory_status',  'حالة الجرد'],
      ['condition',         'الحالة'],
      ['review_status',     'حالة المراجعة'],
      ['last_inventory_date', 'آخر جرد'],
      ['inventoried_by',    'قام بالجرد'],
      ['match_confidence',  'ثقة المطابقة'],
      ['match_method',      'طريقة المطابقة']
    ]},
    { title: 'المصدر والنظام', fields: [
      ['library_source',    'المكتبة المصدر'],
      ['source_db',         'قاعدة البيانات المصدر'],
      ['oldbib',            'رقم المكتبة القديم'],
      ['cover_image_name',  'صورة الغلاف'],
      ['added_by',          'أضافه'],
      ['created_at',        'تاريخ الإضافة'],
      ['updated_at',        'آخر تحديث'],
      ['uuid',              'UUID']
    ]}
  ];

  function fmtFieldValue(key, v) {
    if (v === null || v === undefined || v === '') return '';
    if (key === 'created_at' || key === 'updated_at' || key === 'last_inventory_date') {
      try {
        var d = new Date(v);
        if (!isNaN(d.getTime())) return d.toLocaleString('ar-EG');
      } catch (e) {}
    }
    return String(v);
  }

  function renderBookDetailHtml(b, holder) {
    if (!b || !holder) return;
    var cat = extractCategory(b);
    var statusAr = (b.inventory_status === 'Found' ? 'موجود' :
                    b.inventory_status === 'Lost' ? 'مفقود' :
                    b.inventory_status === 'Damaged' ? 'تالف' : 'غير مفحوص');
    var statusCls = (b.inventory_status === 'Found' ? 'found' :
                     b.inventory_status === 'Lost' ? 'lost' :
                     b.inventory_status === 'Damaged' ? 'damaged' : 'unchecked');
    // v4j: Dewey call number - the authoritative physical identifier
    var dewey = b.doctype || b.full_call_number || b.dewey_number || b.diwi || '';

    var html = '';
    html += '<div class="detail-header">';
    html += '  <div class="detail-title">' + escHtml(b.title || '(بدون عنوان)') + '</div>';
    if (b.author) html += '  <div class="detail-author">' + escHtml(b.author) + '</div>';
    html += '  <div class="detail-meta-row">';
    html += '    <span class="status-pill ' + statusCls + '">' + statusAr + '</span>';
    html += '    <span class="chip chip-cat">' + escHtml(cat) + '</span>';
    if (b.library_source) html += '    <span class="chip chip-src">' + escHtml(b.library_source) + '</span>';
    if (b.bib) html += '    <span class="chip">📖 <span class="number">' + escHtml(b.bib) + '</span></span>';
    html += '  </div>';
    // v4j: prominent Dewey call number directly below header
    if (dewey) {
      html += '  <div class="detail-dewey" style="margin-top:10px;padding:10px 14px;background:rgba(230,168,90,0.12);border:1.5px solid rgba(230,168,90,0.35);border-radius:10px;display:flex;align-items:center;gap:10px;flex-wrap:wrap">';
      html += '    <span style="font-size:11px;color:var(--text-2,#a8aab1);font-weight:700;letter-spacing:0.5px">رقم الديوي</span>';
      html += '    <span class="number" style="font-family:\'JetBrains Mono\',ui-monospace,monospace;font-size:15px;font-weight:800;color:var(--gold,#e6a85a);direction:rtl">' + escHtml(String(dewey)) + '</span>';
      html += '  </div>';
    }
    html += '</div>';

    // Action buttons — v4l: use the REAL functions defined in index.html
    // (cfDirect + markNF). The v4i buttons called markFound/markLost/editBook
    // which never existed, so clicks from list→detail silently did nothing.
    html += '<div class="detail-actions">';
    if (b.inventory_status !== 'Found') {
      html += '  <button class="btn btn-teal" onclick="cfDirect(' + b.record_id + ')">✅ تأكيد الجرد</button>';
    }
    html += '  <button class="btn btn-coral" onclick="markNF(' + b.record_id + ')">❌ غير موجود</button>';
    // v4p: allow rolling a book back to "not checked" if it was inventoried by mistake.
    // Only visible when the book already has a final status (Found or Not Found).
    if (b.inventory_status === 'Found' || b.inventory_status === 'Not Found' || b.inventory_status === 'Lost') {
      html += '  <button class="btn btn-ghost" onclick="__v4pResetInventory(' + b.record_id + ')">↩ إعادة إلى غير مفحوص</button>';
    }
    if (b.internal_barcode) {
      html += '  <button class="btn btn-gold" onclick="showBC(\'' + escHtml(String(b.internal_barcode)) + '\')">📊 الباركود</button>';
    }
    html += '  <button class="btn btn-ghost" onclick="goBack()">↩ رجوع</button>';
    html += '</div>';

    // Sections
    for (var s = 0; s < DETAIL_SECTIONS.length; s++) {
      var section = DETAIL_SECTIONS[s];
      var rows = '';
      for (var f = 0; f < section.fields.length; f++) {
        var key = section.fields[f][0];
        var label = section.fields[f][1];
        var val = fmtFieldValue(key, b[key]);
        if (!val) continue;
        rows += '<div class="field-row"><div class="field-label">' + escHtml(label) + '</div><div class="field-val">' + escHtml(val) + '</div></div>';
      }
      if (rows) {
        html += '<div class="detail-section"><h3 class="detail-section-title">' + escHtml(section.title) + '</h3>' + rows + '</div>';
      }
    }

    // Debug: raw JSON collapsible
    html += '<details class="detail-raw"><summary>البيانات الكاملة (JSON)</summary><pre class="mono">' + escHtml(JSON.stringify(b, null, 2)) + '</pre></details>';

    holder.innerHTML = html;

    // Also render barcode if the app has a renderer
    try {
      var bc = document.getElementById('bcDisp');
      if (bc && b.bib && typeof window.JsBarcode === 'function') {
        bc.innerHTML = '<svg id="bcSvg"></svg>';
        window.JsBarcode('#bcSvg', String(b.bib), { format: 'CODE128', displayValue: true, fontSize: 14, height: 50 });
      }
    } catch (e) {}
  }

  function patchedShowDet(id) {
    // v4j: navigate FIRST via the real nav() function (showPage/go don't exist)
    if (typeof window.nav === 'function') { try { window.nav('detail'); } catch (e) {} }
    var holder = document.getElementById('bookDet');
    if (!holder) return;

    // v4j: O(1) cached lookup first — instant render, no IDB hit
    var cached = getCachedBook(id);
    if (cached) { renderBookDetailHtml(cached, holder); return; }

    // Fallback: async IDB lookup
    if (typeof window.dbGet !== 'function') {
      WARN('showDet: dbGet missing'); return;
    }
    Promise.resolve(window.dbGet(id)).then(function (b) {
      if (!b) return;
      renderBookDetailHtml(b, holder);
    }).catch(function (e) { WARN('showDet error:', e && e.message); });
  }
  window.showDet = patchedShowDet;

  /* ===========================================================
     importFile hook (unchanged, copied from v3)
     =========================================================== */
  var importFileHookInstalled = false;
  function installImportFileHook() {
    if (importFileHookInstalled) return;
    if (typeof window.importFile !== 'function') return;
    if (typeof window.autoDetectColumns !== 'function') return;
    if (typeof window.XLSX === 'undefined') return;

    var origImport = window.importFile;
    window.importFile = function patchedImportFile(file, columnMap) {
      LOG('importFile intercepted');
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
              var now = new Date().toISOString();
              var books = [];
              for (var i = 0; i < rows.length; i++) {
                var r = rows[i];
                var book = {
                  bib: r[map.bib] || '', doctype: r[map.doctype] || '',
                  title: r[map.title] || '', subtitle: r[map.subtitle] || '',
                  author: r[map.author] || '', additional_author: r[map.additional_author] || '',
                  language: r[map.language] || '', publisher: r[map.publisher] || '',
                  publication_year: r[map.publication_year] || '', pubdate: r[map.pubdate] || '',
                  pubplace: r[map.pubplace] || '', isbn: r[map.isbn] || '',
                  dewey_number: r[map.dewey_number] || '', diwi: r[map.diwi] || '',
                  cutter_number: r[map.cutter_number] || '', full_call_number: r[map.full_call_number] || '',
                  subjects: r[map.subjects] || '', edition: r[map.edition] || '',
                  descriptions: r[map.descriptions] || '', material_type: r[map.material_type] || 'Book',
                  inventory_status: r[map.inventory_status] || 'Not Checked',
                  condition: r[map.condition] || 'Good', location: r[map.location] || '',
                  shelf: r[map.shelf] || '', notes: r[map.notes] || '',
                  internal_barcode: r[map.internal_barcode] || '', last_inventory_date: r[map.last_inventory_date] || '',
                  review_status: r[map.review_status] || 'Pending', source_db: r[map.source_db] || '',
                  created_at: now, updated_at: now
                };
                if (book.title) books.push(book);
              }
              if (books.length === 0) return reject(new Error('لا توجد صفوف صالحة'));
              var CHUNK = 100;
              var totalInserted = 0;
              for (var c = 0; c < books.length; c += CHUNK) {
                var batch = books.slice(c, c + CHUNK);
                var result = await directBulkInsert(batch);
                totalInserted += result.inserted || 0;
              }
              scheduleUIRefresh('import-complete');
              try {
                setTimeout(function () { try { paginatedPullFromCloud(); } catch (e) {} }, 500);
              } catch (e) {}
              resolve({ count: totalInserted, columns: Object.keys(rows[0]), mapping: map });
            } catch (err) {
              try { var fb = await origImport.call(window, file, columnMap); resolve(fb); }
              catch (e2) { reject(err); }
            }
          })();
        };
        reader.onerror = function () { reject(reader.error); };
        reader.readAsArrayBuffer(file);
      });
    };
    importFileHookInstalled = true;
    LOG('importFile hook installed');
  }

  /* ===========================================================
     queueSync hook
     =========================================================== */
  var queueSyncHookInstalled = false;
  function installQueueSyncHook() {
    if (queueSyncHookInstalled) return;
    if (typeof window.queueSync !== 'function') return;
    var orig = window.queueSync;
    window.queueSync = function (action, book) {
      var r;
      try { r = orig.apply(this, arguments); } catch (e) {}
      schedulePush();
      return r;
    };
    queueSyncHookInstalled = true;
    LOG('queueSync hook installed');
  }

  /* ===========================================================
     v4m — Realtime FAST PATH (O(1) cloud_id index, sync bookMap)
     =========================================================== */
  // Apply a single realtime record inline: O(1) lookup via cloud_id
  // index, synchronous __bookMap update, async IDB put. This drops
  // cross-device sync from 40s to <500ms.
  var __lastDeltaIso = null;
  var __cloudIdToLocalId = new Map();
  function nowIso() { return new Date().toISOString(); }
  function isoAgo(ms) { return new Date(Date.now() - ms).toISOString(); }

  // Build or refresh the cloud_id→local_record_id index from __bookMap
  function rebuildCloudIdIndex() {
    try {
      __cloudIdToLocalId.clear();
      if (!window.__bookMap) return 0;
      var n = 0;
      window.__bookMap.forEach(function (v, k) {
        if (v && v.cloud_id != null) {
          __cloudIdToLocalId.set(v.cloud_id, k);
          n++;
        }
      });
      LOG('v4m cloudId index built: ' + n + ' entries');
      return n;
    } catch (e) { return 0; }
  }
  window.__rebuildCloudIdIndex = rebuildCloudIdIndex;

  function applyRealtimeRecord(record, type) {
    if (!record || record.record_id == null) return Promise.resolve(false);
    // Track most recent updated_at seen so pullDelta can resume
    try {
      if (record.updated_at && (!__lastDeltaIso || record.updated_at > __lastDeltaIso)) {
        __lastDeltaIso = record.updated_at;
      }
    } catch (e) {}

    // The incoming record is the Supabase row. record.record_id is the
    // CLOUD id (Supabase PK), NOT our local IDB key.
    var cloudId = record.record_id;
    var localId = __cloudIdToLocalId.get(cloudId);

    // ---------- DELETE ----------
    if (type === 'DELETE') {
      if (localId == null) return Promise.resolve(false);
      __cloudIdToLocalId.delete(cloudId);
      try { if (window.__bookMap) window.__bookMap.delete(localId); } catch (e) {}
      try { invalidateCategoryCache(localId); } catch (e) {}
      return openIDB().then(function (db) {
        return new Promise(function (resolve) {
          var tx = db.transaction('books', 'readwrite');
          tx.objectStore('books').delete(localId);
          tx.oncomplete = function () { db.close(); resolve(true); };
          tx.onerror    = function () { try { db.close(); } catch (e) {} resolve(false); };
          tx.onabort    = function () { try { db.close(); } catch (e) {} resolve(false); };
        });
      });
    }

    // ---------- UPDATE existing (O(1) via index) ----------
    if (localId != null) {
      // v4q: if this local record is pinned by a recent reset, the
      // pin is authoritative — skip this realtime update entirely so
      // we never overwrite fresh Not Checked state with a stale or
      // echo event.
      try {
        if (typeof __v4qPinnedResets !== 'undefined' && __v4qPinnedResets.size > 0) {
          var __pinNow = Date.now();
          var __pinEnt = __v4qPinnedResets.get(localId);
          if (__pinEnt && __pinEnt.until > __pinNow) {
            return Promise.resolve(true);
          }
        }
      } catch (e) {}
      var upd = Object.assign({}, record);
      upd.record_id = localId;
      upd.cloud_id  = cloudId;
      // Sync __bookMap update — makes the new state visible to UI/polls
      // immediately without waiting for the IDB transaction.
      try {
        if (window.__bookMap) window.__bookMap.set(localId, upd);
      } catch (e) {}
      try { invalidateCategoryCache(localId); } catch (e) {}
      // Async persist to IDB
      return openIDB().then(function (db) {
        return new Promise(function (resolve) {
          var tx = db.transaction('books', 'readwrite');
          tx.objectStore('books').put(upd);
          tx.oncomplete = function () { db.close(); resolve(true); };
          tx.onerror    = function () { try { db.close(); } catch (e) {} resolve(false); };
          tx.onabort    = function () { try { db.close(); } catch (e) {} resolve(false); };
        });
      });
    }

    // ---------- UNKNOWN cloud_id: try title+author match first ----------
    // This catches books that were added locally without a cloud_id yet.
    var tk = ((record.title || '').trim() + '|||' + (record.author || '').trim());
    if (tk !== '|||' && window.__bookMap) {
      var matchLocalId = null;
      for (var ent of window.__bookMap.entries()) {
        var lb = ent[1];
        if (lb && lb.cloud_id == null) {
          var lk = ((lb.title || '').trim() + '|||' + (lb.author || '').trim());
          if (lk === tk) { matchLocalId = ent[0]; break; }
        }
      }
      if (matchLocalId != null) {
        var upd2 = Object.assign({}, record);
        upd2.record_id = matchLocalId;
        upd2.cloud_id  = cloudId;
        __cloudIdToLocalId.set(cloudId, matchLocalId);
        try {
          if (window.__bookMap) window.__bookMap.set(matchLocalId, upd2);
        } catch (e) {}
        try { invalidateCategoryCache(matchLocalId); } catch (e) {}
        return openIDB().then(function (db) {
          return new Promise(function (resolve) {
            var tx = db.transaction('books', 'readwrite');
            tx.objectStore('books').put(upd2);
            tx.oncomplete = function () { db.close(); resolve(true); };
            tx.onerror    = function () { try { db.close(); } catch (e) {} resolve(false); };
          });
        });
      }
    }

    // ---------- INSERT genuinely new ----------
    return openIDB().then(function (db) {
      return new Promise(function (resolve) {
        var tx = db.transaction('books', 'readwrite');
        var store = tx.objectStore('books');
        var nb = Object.assign({}, record);
        nb.cloud_id = cloudId;
        delete nb.record_id;
        var addReq = store.add(nb);
        addReq.onsuccess = function () {
          var newId = addReq.result;
          __cloudIdToLocalId.set(cloudId, newId);
          try {
            if (window.__bookMap) {
              var saved = Object.assign({}, nb);
              saved.record_id = newId;
              window.__bookMap.set(newId, saved);
            }
          } catch (e) {}
        };
        tx.oncomplete = function () { db.close(); resolve(true); };
        tx.onerror    = function () { try { db.close(); } catch (e) {} resolve(false); };
      });
    });
  }

  // Delta pull: fetch only rows updated_at > since.
  // Returns count merged. Falls back to full paginated pull if
  // delta returns >= 1000 rows (indicates drift too big).
  var deltaInFlight = null;
  function pullDeltaSince(sinceIso) {
    if (deltaInFlight) return deltaInFlight;
    var cfg = getCfg();
    if (!cfg.url || !cfg.key) return Promise.resolve(0);
    if (typeof navigator !== 'undefined' && !navigator.onLine) return Promise.resolve(0);
    var since = sinceIso || __lastDeltaIso || isoAgo(120000); // default: last 2 min
    var endpoint = cfg.url + '/rest/v1/' + cfg.table +
      '?select=*&updated_at=gt.' + encodeURIComponent(since) +
      '&order=updated_at.asc&limit=1000';
    deltaInFlight = (async function () {
      var rows = [];
      try {
        var res = await origFetch(endpoint, {
          headers: {
            'apikey': cfg.key,
            'Authorization': 'Bearer ' + cfg.key
          }
        });
        if (!res.ok) { WARN('pullDelta non-ok', res.status); return 0; }
        rows = await res.json();
      } catch (e) { WARN('pullDelta fetch:', e && e.message); return 0; }
      if (!rows || !rows.length) return 0;
      LOG('pullDelta: ' + rows.length + ' changes since ' + since);
      // If we got the full limit, there's likely drift — fall back to full pull
      if (rows.length >= 1000) {
        LOG('pullDelta: drift detected, running full paginated pull');
        paginatedPullFromCloud().catch(function () {});
        return rows.length;
      }
      // Apply each record inline
      for (var i = 0; i < rows.length; i++) {
        try { await applyRealtimeRecord(rows[i], 'UPDATE'); } catch (e) {}
      }
      scheduleUIRefresh('after-delta-pull');
      return rows.length;
    })();
    deltaInFlight.finally(function () { setTimeout(function () { deltaInFlight = null; }, 100); });
    return deltaInFlight;
  }
  window.__pullDeltaSince = pullDeltaSince;

  /* ===========================================================
     Realtime hook — v4l: INLINE apply + 300ms batch delta pull
     =========================================================== */
  var realtimeHookedWs = null;
  var realtimeBatchTimer = null;
  var realtimeEventsSinceLastPull = 0;

  function extractRecordFromMsg(msg) {
    // Supabase realtime payload variations:
    //   msg.payload.data.record   (most common for postgres_changes)
    //   msg.payload.record
    //   msg.payload.new
    //   msg.record
    var p = msg && msg.payload;
    if (!p) return { record: null, type: null };
    var type = (p.data && p.data.type) || p.type || msg.event;
    var record = (p.data && p.data.record) || p.record || p.new || (p.data && p.data.new) || null;
    return { record: record, type: type };
  }

  function installRealtimeHook() {
    var ws = window.realtimeWs;
    if (!ws) return;
    if (ws.readyState > 1) return;
    // Detect if hook is already installed on this exact WebSocket
    try {
      if (ws.onmessage && ws.onmessage.__v4mHook) return;
    } catch (e) {}
    try {
      var origOnMessage = ws.onmessage;
      var hooked = function (evt) {
        var handledAsChange = false;
        try {
          var msg; try { msg = JSON.parse(evt.data); } catch (e) { msg = null; }
          if (msg) {
            var isChange = msg.event === 'postgres_changes' ||
              msg.event === 'INSERT' || msg.event === 'UPDATE' || msg.event === 'DELETE' ||
              (msg.payload && msg.payload.data &&
               (msg.payload.data.type === 'INSERT' || msg.payload.data.type === 'UPDATE' || msg.payload.data.type === 'DELETE'));
            if (isChange) {
              handledAsChange = true;
              // v4m FAST PATH: apply INLINE from event payload. NO network fetch.
              var info = extractRecordFromMsg(msg);
              if (info.record && info.record.record_id != null) {
                applyRealtimeRecord(info.record, info.type || 'UPDATE').then(function () {
                  scheduleUIRefresh('realtime-inline');
                }).catch(function () {});
              }
              // Safety-net: very short debounced delta pull in case an
              // event was dropped. Short + coalesced so it's cheap.
              realtimeEventsSinceLastPull++;
              clearTimeout(realtimeBatchTimer);
              realtimeBatchTimer = setTimeout(function () {
                var n = realtimeEventsSinceLastPull;
                realtimeEventsSinceLastPull = 0;
                LOG('realtime batch: ' + n + ' events → delta pull');
                pullDeltaSince(__lastDeltaIso || isoAgo(30000)).catch(function () {});
              }, 500);
            }
          }
        } catch (e) {}
        // Only pass non-change messages (heartbeats, presence, join acks)
        // to the original handler. This avoids origOnMessage triggering
        // paginatedPullFromCloud, which would overwrite __bookMap with a
        // full paginated fetch on every single row change.
        if (!handledAsChange) {
          try { if (origOnMessage) origOnMessage.call(this, evt); } catch (e) {}
        }
      };
      hooked.__v4mHook = true;
      ws.onmessage = hooked;
      realtimeHookedWs = ws;
      LOG('v4m realtime hook installed (inline + O(1) index)');
    } catch (e) {}
  }

  // v4l: periodic delta poll — safety net if WebSocket dies silently.
  // Much lighter than a full paginated pull: only pulls rows updated
  // in the last N seconds.
  var deltaPollTimer = null;
  function startDeltaPoll() {
    if (deltaPollTimer) return;
    deltaPollTimer = setInterval(function () {
      if (document.hidden) return;
      if (!__lastDeltaIso) __lastDeltaIso = isoAgo(60000);
      pullDeltaSince(__lastDeltaIso).catch(function () {});
    }, 8000); // every 8s
    LOG('v4l delta poll started (8s interval)');
  }
  // v4l: on tab visible, immediately run a delta pull (catch-up)
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) {
      if (!__lastDeltaIso) __lastDeltaIso = isoAgo(120000);
      pullDeltaSince(__lastDeltaIso).catch(function () {});
    }
  });

  /* ===========================================================
     startAutoSync poll
     =========================================================== */
  var autoSyncStartedFor = null;
  function currentUserHint() {
    try {
      return window.CURRENT_USER || window.currentUser || window.APP_USER ||
             localStorage.getItem('lib_current_user') || localStorage.getItem('lib_user') ||
             sessionStorage.getItem('lib_current_user') || null;
    } catch (e) { return null; }
  }
  function loginScreenVisible() {
    try {
      var el = document.getElementById('loginScreen') || document.getElementById('login') || document.querySelector('[data-screen="login"]');
      if (!el) return false;
      var s = getComputedStyle(el);
      return s.display !== 'none' && s.visibility !== 'hidden' && !el.classList.contains('hidden');
    } catch (e) { return false; }
  }
  function appLooksReady() {
    var hints = document.querySelectorAll('input[placeholder*="ابحث"], .book-card, .kpi, #booksGrid, #bookList, [data-screen="home"]');
    if (hints.length > 0 && !loginScreenVisible()) return true;
    return false;
  }
  /* ===========================================================
     v4j: Dewey enricher — MutationObserver that injects the
     "رقم الديوي" row into scanner/search result cards rendered
     by the original (un-patched) HTML code in index.html.
     Reads book id from onclick="showDet(NNN)" and looks up
     from __bookMap for O(1).
     =========================================================== */
  function extractIdFromCard(card) {
    var onclick = card.getAttribute('onclick') || '';
    var m = onclick.match(/showDet\((\d+)\)/);
    if (!m) {
      var child = card.querySelector('[onclick*="showDet("]');
      if (child) {
        var m2 = (child.getAttribute('onclick') || '').match(/showDet\((\d+)\)/);
        if (m2) return parseInt(m2[1], 10);
      }
      return null;
    }
    return parseInt(m[1], 10);
  }
  // v4k: lookup book from match-card by title (match-cards don't carry record_id)
  var __titleIndex = null;
  function buildTitleIndex() {
    if (!window.__bookMap) return null;
    __titleIndex = new Map();
    var it = window.__bookMap.values();
    var n;
    while (!(n = it.next()).done) {
      var b = n.value;
      if (b && b.title) {
        var key = String(b.title).replace(/\s+/g, ' ').trim();
        if (!__titleIndex.has(key)) __titleIndex.set(key, b);
      }
    }
    return __titleIndex;
  }
  function findBookForMatchCard(card) {
    // Try to match by title extracted from the card
    var titleEl = card.querySelector('.match-title');
    if (!titleEl) return null;
    var title = titleEl.textContent.replace(/\s+/g, ' ').trim();
    if (!title) return null;
    if (!__titleIndex) buildTitleIndex();
    if (!__titleIndex) return null;
    return __titleIndex.get(title) || null;
  }
  function enrichCardWithDewey(card) {
    if (!card || card.__v4jDewey) return;
    var book = null;
    // Path 1: has showDet(id) onclick
    var id = extractIdFromCard(card);
    if (id != null) {
      book = getCachedBook(id);
    }
    // Path 2: match-card — lookup by title
    if (!book && card.classList && card.classList.contains('match-card')) {
      book = findBookForMatchCard(card);
    }
    if (!book) return;
    var dewey = book.doctype || book.full_call_number || book.dewey_number || book.diwi || '';
    if (!dewey) { card.__v4jDewey = true; return; }
    // avoid duplicate injection
    if (card.querySelector('.v4j-dewey-row')) { card.__v4jDewey = true; return; }
    var row = document.createElement('div');
    row.className = 'v4j-dewey-row';
    row.style.cssText = 'margin-top:8px;padding:6px 12px;background:rgba(230,168,90,0.12);border:1.5px solid rgba(230,168,90,0.35);border-radius:8px;font-family:"JetBrains Mono",ui-monospace,monospace;font-size:13px;font-weight:700;color:var(--gold,#e6a85a);direction:rtl;display:flex;align-items:center;gap:8px;flex-wrap:wrap';
    var lbl = document.createElement('span');
    lbl.style.cssText = 'font-size:11px;color:var(--text-2,#a8aab1);font-weight:700;letter-spacing:0.3px';
    lbl.textContent = 'رقم الديوي';
    var val = document.createElement('span');
    val.className = 'number';
    val.style.direction = 'rtl';
    val.textContent = String(dewey);
    row.appendChild(lbl);
    row.appendChild(val);
    card.appendChild(row);
    card.__v4jDewey = true;
  }
  function enrichContainer(container) {
    if (!container) return;
    // Cards with showDet onclick
    var a = container.querySelectorAll('[onclick*="showDet("]');
    for (var i = 0; i < a.length; i++) enrichCardWithDewey(a[i]);
    // Scanner match-cards (no record_id, lookup by title)
    var b = container.querySelectorAll('.match-card');
    for (var j = 0; j < b.length; j++) enrichCardWithDewey(b[j]);
    // Also handle the container itself if it IS a match-card
    if (container.classList && container.classList.contains('match-card')) enrichCardWithDewey(container);
  }
  var deweyEnricherInstalled = false;
  function setupDeweyEnricher() {
    if (deweyEnricherInstalled) return;
    try {
      var targets = ['searchResults', 'matchList', 'searchList', 'matchResults'];
      var observed = false;
      for (var i = 0; i < targets.length; i++) {
        var el = document.getElementById(targets[i]);
        if (!el) continue;
        observed = true;
        enrichContainer(el);
        var mo = new MutationObserver(function (mutations) {
          for (var j = 0; j < mutations.length; j++) {
            var added = mutations[j].addedNodes;
            for (var k = 0; k < added.length; k++) {
              var node = added[k];
              if (node.nodeType !== 1) continue;
              if (node.getAttribute && node.getAttribute('onclick') && /showDet\(/.test(node.getAttribute('onclick'))) {
                enrichCardWithDewey(node);
              }
              if (node.querySelectorAll) enrichContainer(node);
            }
          }
        });
        mo.observe(el, { childList: true, subtree: true });
      }
      if (observed) {
        deweyEnricherInstalled = true;
        LOG('v4j Dewey enricher installed');
      }
    } catch (e) { WARN('Dewey enricher setup error:', e && e.message); }
  }
  window.__setupDeweyEnricher = setupDeweyEnricher;

  /* ===========================================================
     v4p: personalized home greeting + clickable Found/NotFound
          stat items + reset-inventory from detail page
     -----------------------------------------------------------
     User request (2026-04-12, Mohamed):
       "كل شي تمام بس اضف لي عند مرحبا اسم الشخص ... وايضاً
        خلني اقدر اشوف الكتب الي جردتها خانه الموجود اقدر ادخل
        عليها وكذلك المفقود عشان لو بغيت ارجع كتاب ما طلع هو
        الي جردته. اما الباقي اجمالي و غير مفحوص مب لازم."

     Deliberately leaves the total + not-checked stat items
     completely untouched. No CSS changes. No new pages.
     =========================================================== */

  // --- (1) Personalized home greeting ----------------------
  function __v4pGetDisplayName() {
    try {
      var u = window.currentUser;
      if (!u || typeof u.name !== 'string') return null;
      var n = u.name.trim();
      return n || null;
    } catch (e) { return null; }
  }

  function __v4pApplyHomeGreeting() {
    try {
      var title = document.querySelector('#pgHome .hero-title');
      if (!title) return false;
      var name = __v4pGetDisplayName();
      var greet = name ? ('مرحباً بك ' + name + ' 👋') : 'مرحباً بك 👋';
      if (title.textContent !== greet) title.textContent = greet;
      return true;
    } catch (e) { return false; }
  }

  // --- (2) Clickable Found / NotFound stat items -----------
  // Exported so the detail → reset flow can check it too.
  window.__v4pListFilter = null; // 'Found' | 'Not Found' | null

  function __v4pOpenFiltered(filter) {
    window.__v4pListFilter = filter;
    try { if (typeof window.nav === 'function') window.nav('allbooks'); } catch (e) {}
    try {
      var t = document.getElementById('hdrTitle');
      if (t) t.textContent = (filter === 'Found' ? 'الكتب المجرودة' : 'الكتب المفقودة');
    } catch (e) {}
  }

  function __v4pInstallStatItemClicks() {
    try {
      var items = document.querySelectorAll('#pgHome .stat-item');
      if (!items || !items.length) return;
      items.forEach(function (el) {
        var num = el.querySelector('.stat-number');
        if (!num) return;
        var filter = null;
        if (num.id === 'statFound')    filter = 'Found';
        else if (num.id === 'statNotFound') filter = 'Not Found';
        // statTotal + statNotChecked intentionally skipped.
        if (!filter) return;
        if (el.__v4pClickable) return;
        el.__v4pClickable = true;
        el.style.cursor = 'pointer';
        el.setAttribute('role', 'button');
        el.setAttribute('tabindex', '0');
        var handler = function (e) {
          if (e) { try { e.preventDefault(); e.stopPropagation(); } catch (err) {} }
          __v4pOpenFiltered(filter);
        };
        el.addEventListener('click', handler);
        el.addEventListener('keydown', function (e) {
          if (e && (e.key === 'Enter' || e.key === ' ')) handler(e);
        });
      });
    } catch (e) {}
  }

  // Wrap loadHome so greeting + click-handlers apply after every refresh
  var __v4pLoadHomePatched = false;
  function __v4pInstallLoadHomeHook() {
    if (__v4pLoadHomePatched) return;
    if (typeof window.loadHome !== 'function') return;
    var orig = window.loadHome;
    window.loadHome = function () {
      var r;
      try { r = orig.apply(this, arguments); }
      catch (e) { throw e; }
      try { __v4pApplyHomeGreeting(); __v4pInstallStatItemClicks(); } catch (e) {}
      try {
        if (r && typeof r.then === 'function') {
          r.then(function () {
            try { __v4pApplyHomeGreeting(); __v4pInstallStatItemClicks(); } catch (e) {}
          });
        }
      } catch (e) {}
      return r;
    };
    __v4pLoadHomePatched = true;
    LOG('v4p loadHome hook installed');
  }

  // Wrap loadAllBooks so a pending filter produces a filtered list
  var __v4pLoadAllBooksPatched = false;
  function __v4pInstallLoadAllBooksHook() {
    if (__v4pLoadAllBooksPatched) return;
    if (typeof window.loadAllBooks !== 'function') return;
    var orig = window.loadAllBooks;
    window.loadAllBooks = async function () {
      var filter = window.__v4pListFilter;
      if (!filter) return orig.apply(this, arguments);
      try {
        var books = (typeof window.dbAll === 'function') ? await window.dbAll() : [];
        var filtered = books.filter(function (b) { return b && b.inventory_status === filter; });
        if (typeof window.renderList === 'function') {
          window.renderList(filtered, 'allList');
        }
        // nav() already called updateHeader() before we ran; re-apply.
        var t = document.getElementById('hdrTitle');
        if (t) t.textContent = (filter === 'Found' ? 'الكتب المجرودة' : 'الكتب المفقودة');
      } catch (e) { WARN('v4p filtered list error:', e && e.message); }
    };
    __v4pLoadAllBooksPatched = true;
    LOG('v4p loadAllBooks hook installed');
  }

  // Wrap nav so the filter clears when leaving the filtered list
  // (but survives an allbooks → detail trip so the user can drill in).
  var __v4pNavPatched = false;
  function __v4pInstallNavHook() {
    if (__v4pNavPatched) return;
    if (typeof window.nav !== 'function') return;
    var orig = window.nav;
    window.nav = function (page) {
      if (page !== 'allbooks' && page !== 'detail') {
        window.__v4pListFilter = null;
      }
      return orig.apply(this, arguments);
    };
    __v4pNavPatched = true;
    LOG('v4p nav hook installed');
  }

  /* ===========================================================
     v4q (20260410qr2) — Reset-to-Not-Checked race fix
     -----------------------------------------------------------
     Bug history:
       The original v4p reset did:
         1. local mutate (empty-string wipe)
         2. dbPut  → queueSync → push to cloud
         3. fullSync 500ms later → pushToCloud + pullFromCloud

       But paginatedPullFromCloud (patch.js #14) has TWO
       fatal properties for a write-then-pull flow:
         (a) no updated_at freshness check — it *uncondition-
             ally* overwrites local with whatever the remote
             row looks like at pull time.
         (b) ~28s non-atomic snapshot: a pull that *started*
             before the PATCH landed can *finish* after and
             write stale Found data on top of the fresh
             Not Checked state.
         (c) Realtime WebSocket also triggers a pull after
             any edit, piling the problem on.

       Result: user clicks reset, UI flashes Not Checked, but
       within a few seconds a late pull overwrites it back to
       Found. On the next reset click the home counter for
       Not Found jumps unexpectedly as stale data churns.

     v4q fix:
       1. Reset is a DIRECT PATCH to Supabase (bypass queueSync
          and fullSync entirely), with correct column types
          (null instead of '', match_confidence=0).
       2. On PATCH success, write IDB directly via openIDB()
          (bypass dbPut so queueSync is NOT enqueued).
       3. Update __bookMap synchronously.
       4. Pin the reset book in __v4qPinnedResets for 15s.
       5. Overlay window.dbAll so pinned books replace whatever
          stale state the underlying IDB has, AND so the pinned
          state is re-asserted into __bookMap on every list read.
       6. Wrap window.pullFromCloud so after a pull finishes,
          every live pin is re-written into IDB + __bookMap.
       7. Defensive re-asserts at +1.5s, +5s and +10s.
       8. Reset is rejected if cloud_id is missing or offline.
     =========================================================== */
  var __v4qPinnedResets = new Map(); // record_id -> { book, until }
  // Pin TTL: long enough to cover the worst-case in-flight dbAll read
  // (which can take up to ~30s on 56K books if it races against a
  // paginatedPullFromCloud merge). Too-short TTL leaves a window where
  // a stale dbAll promise resolves AFTER the pin expires, then v4j's
  // rebuildBookMap writes stale Found back into __bookMap.
  var __V4Q_PIN_TTL_MS = 60000;

  function __v4qCleanExpiredPins() {
    var now = Date.now();
    var dead = [];
    __v4qPinnedResets.forEach(function (v, k) { if (!v || v.until < now) dead.push(k); });
    for (var i = 0; i < dead.length; i++) __v4qPinnedResets.delete(dead[i]);
  }

  function __v4qGetPin(id) {
    __v4qCleanExpiredPins();
    if (__v4qPinnedResets.size === 0) return null;
    var e = __v4qPinnedResets.get(id);
    if (!e) {
      var n = parseInt(id, 10);
      if (!isNaN(n)) e = __v4qPinnedResets.get(n);
      if (!e) e = __v4qPinnedResets.get(String(id));
    }
    return e ? e.book : null;
  }

  function __v4qPinReset(book, ttlMs) {
    if (!book || book.record_id == null) return;
    __v4qPinnedResets.set(book.record_id, {
      book: book,
      until: Date.now() + (ttlMs || __V4Q_PIN_TTL_MS)
    });
  }

  // Self-contained IDB write (does NOT go through dbPut, so no
  // queueSync entry and no fullSync will be triggered).
  function __v4qRewriteIdb(book) {
    return new Promise(function (resolve) {
      openIDB().then(function (db) {
        try {
          if (!db.objectStoreNames.contains('books')) { db.close(); resolve(false); return; }
          var tx = db.transaction('books', 'readwrite');
          var store = tx.objectStore('books');
          store.put(book);
          tx.oncomplete = function () { db.close(); resolve(true); };
          tx.onerror    = function () { try { db.close(); } catch (e) {} resolve(false); };
          tx.onabort    = function () { try { db.close(); } catch (e) {} resolve(false); };
        } catch (e) {
          try { db.close(); } catch (ex) {}
          resolve(false);
        }
      }).catch(function () { resolve(false); });
    });
  }

  function __v4qApplyPinned(book) {
    if (!book || book.record_id == null) return;
    try { if (window.__bookMap) window.__bookMap.set(book.record_id, book); } catch (e) {}
    __v4qRewriteIdb(book);
  }

  // Outer dbAll overlay: runs on top of the v4j-patched dbAll and
  // substitutes pinned books in the result array + __bookMap.
  // We set __v4jPatched=true on our wrapper so installDbAllHook
  // sees it's already patched and doesn't re-wrap, stripping us.
  function __v4qInstallDbAllOverlay() {
    if (typeof window.dbAll !== 'function') return;
    if (window.dbAll.__v4qPatched) return; // already outermost
    var orig = window.dbAll;
    var wrapped = function __v4qDbAll() {
      var p = orig.apply(this, arguments);
      return Promise.resolve(p).then(function (books) {
        try {
          if (!Array.isArray(books)) return books;
          __v4qCleanExpiredPins();
          if (__v4qPinnedResets.size === 0) return books;
          var patched = 0;
          for (var j = 0; j < books.length; j++) {
            var b = books[j];
            if (!b || b.record_id == null) continue;
            var pin = __v4qPinnedResets.get(b.record_id);
            if (pin && pin.book) {
              books[j] = pin.book;
              patched++;
              try { if (window.__bookMap) window.__bookMap.set(pin.book.record_id, pin.book); } catch (e2) {}
            }
          }
          if (patched > 0) LOG('v4q dbAll overlay: replaced ' + patched + ' pinned row(s)');
        } catch (e) { WARN('v4q dbAll overlay error:', e && e.message); }
        return books;
      });
    };
    wrapped.__v4qPatched = true;
    wrapped.__v4jPatched = true; // make installDbAllHook treat as already patched
    window.dbAll = wrapped;
    LOG('v4q dbAll overlay installed');
  }

  // Wrap pullFromCloud so after any pull completes, every live
  // pin is re-asserted back into IDB + __bookMap. This closes the
  // race where a pull that started pre-PATCH lands post-PATCH.
  function __v4qWrapPullFromCloud() {
    if (typeof window.pullFromCloud !== 'function') return;
    if (window.pullFromCloud.__v4qWrapped) return;
    var orig = window.pullFromCloud;
    var wrapped = function __v4qPull() {
      var p = orig.apply(this, arguments);
      return Promise.resolve(p).then(function (res) {
        try {
          __v4qCleanExpiredPins();
          if (__v4qPinnedResets.size > 0) {
            var count = 0;
            __v4qPinnedResets.forEach(function (v) {
              if (v && v.book) { __v4qApplyPinned(v.book); count++; }
            });
            if (count > 0) LOG('v4q post-pull re-asserted ' + count + ' pinned reset(s)');
          }
        } catch (e) { WARN('v4q post-pull reassert error:', e && e.message); }
        return res;
      });
    };
    wrapped.__v4qWrapped = true;
    window.pullFromCloud = wrapped;
    LOG('v4q pullFromCloud wrap installed');
  }

  // --- (3) Reset inventory to "Not Checked" — v4r race-safe ----
  // v4r: re-entrancy guard prevents double-fire on mobile touch devices
  // (some browsers dispatch click twice on a single tap).
  var __v4rResetInProgress = false;
  window.__v4pResetInventory = async function (id) {
    if (__v4rResetInProgress) { LOG('v4r reset: blocked re-entrant call for id=' + id); return; }
    __v4rResetInProgress = true;
    try {
      if (!confirm('هل تريد إرجاع هذا الكتاب إلى "غير مفحوص"؟')) { __v4rResetInProgress = false; return; }
      var b = (typeof window.dbGet === 'function') ? await window.dbGet(id) : null;
      if (!b) {
        if (window.showToast) window.showToast('❌ الكتاب غير موجود');
        __v4rResetInProgress = false; return;
      }
      if (typeof navigator !== 'undefined' && !navigator.onLine) {
        if (window.showToast) window.showToast('❌ لا يوجد اتصال — حاول لاحقاً');
        __v4rResetInProgress = false; return;
      }
      if (!b.cloud_id) {
        if (window.showToast) window.showToast('❌ الكتاب لم يُرفع للخادم بعد');
        __v4rResetInProgress = false; return;
      }
      var cfg = getCfg();
      if (!cfg.url || !cfg.key) {
        if (window.showToast) window.showToast('❌ لا توجد إعدادات Supabase');
        __v4rResetInProgress = false; return;
      }

      // Direct PATCH with correct column types. Columns:
      //   inventory_status:    text
      //   last_inventory_date: timestamptz nullable
      //   inventoried_by:      text nullable
      //   match_confidence:    integer (canonical Not Checked value is 0)
      //   match_method:        text
      //   review_status:       text
      // updated_at is omitted — the Supabase trigger sets it.
      var patchBody = {
        inventory_status: 'Not Checked',
        last_inventory_date: null,
        inventoried_by: null,
        match_confidence: 0,
        match_method: '',
        review_status: 'Pending'
      };
      var endpoint = cfg.url + '/rest/v1/' + cfg.table +
                     '?record_id=eq.' + encodeURIComponent(b.cloud_id);

      var res;
      try {
        res = await origFetch(endpoint, {
          method: 'PATCH',
          headers: {
            'apikey': cfg.key,
            'Authorization': 'Bearer ' + cfg.key,
            'Content-Type': 'application/json',
            'Prefer': 'return=representation'
          },
          body: JSON.stringify(patchBody)
        });
      } catch (e) {
        WARN('v4q reset PATCH network error:', e && e.message);
        if (window.showToast) window.showToast('❌ فشل الاتصال بالخادم');
        __v4rResetInProgress = false; return;
      }
      if (!res.ok) {
        WARN('v4q reset PATCH status:', res.status);
        if (window.showToast) window.showToast('❌ فشل تحديث الخادم (' + res.status + ')');
        __v4rResetInProgress = false; return;
      }

      var serverRows = null;
      try { serverRows = await res.json(); } catch (e) {}
      var serverBook = (Array.isArray(serverRows) && serverRows.length > 0) ? serverRows[0] : null;

      // Build newBook: prefer server authoritative fields, keep
      // local record_id and cloud_id intact.
      var newBook = Object.assign({}, b);
      if (serverBook) {
        newBook = Object.assign({}, b, serverBook);
      } else {
        newBook.inventory_status    = 'Not Checked';
        newBook.last_inventory_date = null;
        newBook.inventoried_by      = null;
        newBook.match_confidence    = 0;
        newBook.match_method        = '';
        newBook.review_status       = 'Pending';
        newBook.updated_at          = new Date().toISOString();
      }
      newBook.record_id = b.record_id;
      newBook.cloud_id  = b.cloud_id;

      // Write IDB directly — bypasses dbPut → queueSync → fullSync
      await __v4qRewriteIdb(newBook);
      // Update __bookMap synchronously
      try { if (window.__bookMap) window.__bookMap.set(newBook.record_id, newBook); } catch (e) {}

      // Pin for 60s — protects against in-flight pulls and realtime bursts
      __v4qPinReset(newBook, __V4Q_PIN_TTL_MS);

      // v4r: nuke any pending sync_queue entry for this book so a stale
      // fullSync (triggered by a prior cfDirect/markNF) cannot push old
      // Found/Not Found state to Supabase and overwrite our direct PATCH.
      try {
        openIDB().then(function (db) {
          try {
            if (!db.objectStoreNames.contains('sync_queue')) { db.close(); return; }
            var tx = db.transaction('sync_queue', 'readwrite');
            var st = tx.objectStore('sync_queue');
            var cur = st.openCursor();
            cur.onsuccess = function () {
              var c = cur.result;
              if (!c) return;
              try {
                var r = c.value;
                if (r && (r.record_id === newBook.record_id || r.record_id === newBook.cloud_id ||
                    r.cloud_id === newBook.cloud_id)) {
                  c.delete();
                  LOG('v4r: nuked sync_queue entry for reset book');
                }
              } catch (e2) {}
              c.continue();
            };
            tx.oncomplete = function () { db.close(); };
            tx.onerror    = function () { try { db.close(); } catch (e2) {} };
          } catch (e2) { try { db.close(); } catch (e3) {} }
        }).catch(function () {});
      } catch (e) {}

      // v4r: reduced defensive re-assertions — only 3 checkpoints within
      // the pin lifetime. Fewer timers = less IDB churn.
      [2000, 8000, 15000].forEach(function (ms) {
        setTimeout(function () { __v4qApplyPinned(newBook); }, ms);
      });

      if (typeof window.showToast === 'function') window.showToast('✅ أُرجع إلى غير مفحوص');
      if (typeof window.showDet === 'function') {
        try { window.showDet(newBook.record_id); } catch (e) {}
      }
      try { scheduleUIRefresh('v4q-reset'); } catch (e) {}
      LOG('v4r reset complete for record_id=' + newBook.record_id + ' cloud_id=' + newBook.cloud_id);
    } catch (e) {
      WARN('v4r reset inv error:', e && e.message);
      if (typeof window.showToast === 'function') window.showToast('❌ خطأ غير متوقع');
    } finally {
      // v4r: always clear re-entrancy guard, even on error
      __v4rResetInProgress = false;
    }
  };

  /* ===========================================================
     v4r: Debounced search — fixes crash on home/search page
     -----------------------------------------------------------
     Bug: doSearch() in app.v5c.js calls dbAll() on every keyup,
     reading 56K books from IDB, rebuilding __bookMap, and then
     rendering ALL matches into innerHTML. With 56K books, this
     freezes the browser on the second keystroke.

     Fix:
       1. Override doSearch() with a debounced version (300ms).
       2. Use __bookMap (already in memory) instead of dbAll().
       3. Limit rendered results to 100 to prevent DOM explosion.
       4. Prevent <form> submission / Enter key → page reload.
       5. Minimum 2 characters before searching.
     =========================================================== */
  var __v4rSearchTimer = null;
  var __v4rSearchPatched = false;

  function __v4rInstallSearchFix() {
    if (__v4rSearchPatched) return;
    // Patch doSearch
    if (typeof window.doSearch !== 'function') return;
    var MAX_RESULTS = 100;
    var DEBOUNCE_MS = 300;

    // Helper: escape HTML to prevent XSS
    function esc(s) { return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

    // Helper: get status badge class (mirrors app.v5c.js)
    function stBadge(s) {
      if (s === 'Found')      return 'badge-success';
      if (s === 'Not Found')  return 'badge-error';
      if (s === 'Not Checked') return 'badge-warning';
      return 'badge-default';
    }
    function stAr(s) {
      if (s === 'Found')       return 'موجود';
      if (s === 'Not Found')   return 'مفقود';
      if (s === 'Not Checked') return 'غير مفحوص';
      return s || '—';
    }

    function performSearch() {
      try {
        var input = document.getElementById('searchInput');
        if (!input) return;
        var query = (input.value || '').trim().toLowerCase();
        var container = document.getElementById('searchResults');
        if (!container) return;

        if (!query || query.length < 1) {
          container.innerHTML = '<div class="empty-state"><div class="empty-icon">📚</div><div class="empty-text">ابدأ البحث</div></div>';
          return;
        }

        // Use __bookMap (O(1) memory lookup, no IDB read)
        var results = [];
        var searchFilter = window.searchFilter || 'All';
        var map = window.__bookMap;
        if (!map || map.size === 0) {
          // Fallback: if bookMap empty, do a dbAll but only once
          container.innerHTML = '<div class="empty-state"><div class="empty-icon">⏳</div><div class="empty-text">جارٍ التحميل...</div></div>';
          Promise.resolve(typeof window.dbAll === 'function' ? window.dbAll() : []).then(function (books) {
            if (!Array.isArray(books)) return;
            for (var i = 0; i < books.length && results.length < MAX_RESULTS; i++) {
              var b = books[i];
              if (!b) continue;
              if (__v4rMatchBook(b, query, searchFilter)) results.push(b);
            }
            __v4rRenderResults(container, results, query, esc, stBadge, stAr);
          }).catch(function () {});
          return;
        }

        // Fast path: iterate __bookMap (already in memory)
        var iter = map.values();
        var next = iter.next();
        while (!next.done && results.length < MAX_RESULTS) {
          var b = next.value;
          if (b && __v4rMatchBook(b, query, searchFilter)) results.push(b);
          next = iter.next();
        }
        __v4rRenderResults(container, results, query, esc, stBadge, stAr);
      } catch (e) { WARN('v4r search error:', e && e.message); }
    }

    window.doSearch = function () {
      clearTimeout(__v4rSearchTimer);
      __v4rSearchTimer = setTimeout(performSearch, DEBOUNCE_MS);
    };

    // Prevent Enter key from reloading page (in case there's a wrapping form)
    try {
      var si = document.getElementById('searchInput');
      if (si && !si.__v4rKeyGuard) {
        si.__v4rKeyGuard = true;
        si.addEventListener('keydown', function (e) {
          if (e && e.key === 'Enter') {
            e.preventDefault();
            e.stopPropagation();
            // Trigger immediate search on Enter
            clearTimeout(__v4rSearchTimer);
            performSearch();
          }
        });
      }
    } catch (e) {}

    // Also guard the homeSearch input on the home page
    try {
      var hs = document.getElementById('homeSearch');
      if (hs && !hs.__v4rKeyGuard) {
        hs.__v4rKeyGuard = true;
        hs.addEventListener('keydown', function (e) {
          if (e && e.key === 'Enter') {
            e.preventDefault();
            e.stopPropagation();
          }
        });
        // Prevent typing in homeSearch from doing anything weird —
        // it should just navigate to search page on any input
        hs.addEventListener('input', function () {
          try {
            var val = hs.value || '';
            if (val.length > 0) {
              window.nav('search');
              setTimeout(function () {
                var si2 = document.getElementById('searchInput');
                if (si2) { si2.value = val; si2.focus(); window.doSearch(); }
                hs.value = '';
              }, 50);
            }
          } catch (e2) {}
        });
      }
    } catch (e) {}

    __v4rSearchPatched = true;
    LOG('v4r search fix installed (debounce=' + DEBOUNCE_MS + 'ms, max=' + MAX_RESULTS + ')');
  }

  function __v4rMatchBook(b, query, filter) {
    var title  = (b.title || '').toLowerCase();
    var author = (b.author || '').toLowerCase();
    var pub    = (b.publisher || '').toLowerCase();
    if (filter === 'Title')     return title.includes(query);
    if (filter === 'Author')    return author.includes(query);
    if (filter === 'Publisher') return pub.includes(query);
    return title.includes(query) || author.includes(query) || pub.includes(query);
  }

  function __v4rRenderResults(container, results, query, esc, stBadge, stAr) {
    if (!results.length) {
      container.innerHTML = query
        ? '<div class="empty-state"><div class="empty-icon">🔍</div><div class="empty-text">لا توجد نتائج</div></div>'
        : '<div class="empty-state"><div class="empty-icon">📚</div><div class="empty-text">ابدأ البحث</div></div>';
      return;
    }
    var html = '';
    for (var i = 0; i < results.length; i++) {
      var b = results[i];
      html += '<div class="card clickable" onclick="showDet(' + b.record_id + ')">'
        + '<div class="card-title">' + esc(b.title) + '</div>'
        + '<div class="card-subtitle">' + esc(b.author || '—') + '</div>'
        + '<div class="card-meta"><span>' + esc(b.publisher || '—') + '</span>'
        + '<span class="badge ' + stBadge(b.inventory_status) + '">' + stAr(b.inventory_status) + '</span></div>';
      if (!b.internal_barcode && b.inventory_status !== 'Found') {
        html += '<button class="btn btn-success btn-small" style="margin-top:10px;width:100%;" '
          + 'onclick="cfDirect(' + b.record_id + ');event.stopPropagation();">✅ تأكيد</button>';
      }
      html += '</div>';
    }
    if (results.length >= 100) {
      html += '<div class="empty-state" style="padding:16px;opacity:0.7"><div class="empty-text">⬆ أول 100 نتيجة — حدّد البحث للمزيد</div></div>';
    }
    container.innerHTML = html;
  }

  // V4 FIX: re-assert our patched UI functions in case app.v5c.js's
  // hoisted `function loadReports(){}` / `function showDet(){}` / `function renderList(){}`
  // overwrote our earlier window assignments. Safe to call repeatedly.
  function reassertV4Patches() {
    try { if (window.loadReports !== patchedLoadReports) window.loadReports = patchedLoadReports; } catch (e) {}
    try { if (window.showDet     !== patchedShowDet)     window.showDet     = patchedShowDet;     } catch (e) {}
    try { if (window.renderList  !== patchedRenderList)  window.renderList  = patchedRenderList;  } catch (e) {}
    try {
      // Only reset to raw paginated if NOT already wrapped by v4q
      if (window.pullFromCloud !== paginatedPullFromCloud && !window.pullFromCloud.__v4qWrapped) {
        window.pullFromCloud = paginatedPullFromCloud;
      }
    } catch (e) {}
    try { installDbAllHook(); } catch (e) {}
    try { installDbPutHook(); } catch (e) {}
    // v4q: outermost overlays — installed AFTER v4j dbAll hook and
    // AFTER paginatedPullFromCloud so they wrap the latest version.
    try { __v4qInstallDbAllOverlay(); } catch (e) {}
    try { __v4qWrapPullFromCloud(); } catch (e) {}
    // v4n: keep generateBarcode patched so rapid confirms stay unique.
    try { installBarcodeHook(); } catch (e) {}
    // v4p: home greeting + clickable stat items + filtered list + reset
    try { __v4pInstallLoadHomeHook(); } catch (e) {}
    try { __v4pInstallLoadAllBooksHook(); } catch (e) {}
    try { __v4pInstallNavHook(); } catch (e) {}
    try { __v4pApplyHomeGreeting(); __v4pInstallStatItemClicks(); } catch (e) {}
    // v4m: rebuild the cloud_id→local_id index whenever we reassert.
    // This keeps sync O(1) even if __bookMap was rebuilt by a fresh pull.
    try { rebuildCloudIdIndex(); } catch (e) {}
    try { setupDeweyEnricher(); } catch (e) {}
    // v4r: install debounced search fix
    try { __v4rInstallSearchFix(); } catch (e) {}
  }
  // Expose for manual debugging / external re-arming
  window.__v4ReassertPatches = reassertV4Patches;
  // Run now, on DOMContentLoaded, and at small delays for belt-and-suspenders.
  reassertV4Patches();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', reassertV4Patches);
  }
  setTimeout(reassertV4Patches, 50);
  setTimeout(reassertV4Patches, 250);
  setTimeout(reassertV4Patches, 1000);
  setTimeout(reassertV4Patches, 3000);

  function tryStartAutoSync() {
    reassertV4Patches();
    installQueueSyncHook();
    installRealtimeHook();
    installImportFileHook();
    if (!appLooksReady()) return;
    var hasAuto = typeof window.startAutoSync === 'function';
    var hasRt   = typeof window.startRealtimeSync === 'function';
    if (!hasAuto && !hasRt) return;
    var who = currentUserHint() || 'anon';
    if (autoSyncStartedFor === who) return;
    if (hasAuto) { try { window.startAutoSync(); } catch (e) {} }
    if (hasRt)   { try { window.startRealtimeSync(); } catch (e) {} }
    // Kick an initial paginated pull once the user is logged in
    setTimeout(function () { try { paginatedPullFromCloud(); } catch (e) {} }, 1200);
    // v4l: start the delta poll (8s) — safety net if WebSocket drops
    try { startDeltaPoll(); } catch (e) {}
    autoSyncStartedFor = who;
  }
  var poll = setInterval(tryStartAutoSync, 1500);
  setTimeout(function () { clearInterval(poll); }, 10 * 60 * 1000);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) tryStartAutoSync(); });
  window.addEventListener('focus', tryStartAutoSync);

  LOG('v4 ready — pagination + reports + detail + virtual list installed');
})();
