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

  var PATCH_VERSION = '20260410h';
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
     UI refresh (debounced)
     ----------------------------------------------------------- */
  var uiRefreshDebounce = null;
  function scheduleUIRefresh(source) {
    clearTimeout(uiRefreshDebounce);
    uiRefreshDebounce = setTimeout(function () {
      try {
        var fns = ['loadHome', 'renderHome', 'loadAllBooks', 'refreshUI', 'renderBooks', 'updateSyncBadge', 'loadReports'];
        var called = 0;
        for (var i = 0; i < fns.length; i++) {
          var fn = window[fns[i]];
          if (typeof fn === 'function') { try { fn(); called++; } catch (e) {} }
        }
        if (source === 'realtime') patchStats.realtimeRefreshes++;
        else patchStats.localRefreshes++;
      } catch (e) {}
    }, 200);
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
              if (typeof window.pullFromCloud === 'function') return window.pullFromCloud();
            })
            .then(function () { scheduleUIRefresh('local-after-pull'); })
            .catch(function () {});
        }
      } catch (e) {}
    }, 400);
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
  window.extractCategory = extractCategory;

  /* ===========================================================
     V4 NEW #16 — generateReports(books)
     =========================================================== */
  function generateReports(books) {
    var total = books.length;
    var present = 0, lost = 0, unchecked = 0, damaged = 0;
    var categories = {};
    var sources = {};
    var users = {};  // { name: { added: n, inventoried: n } }
    var types = {};
    var withCover = 0;

    for (var i = 0; i < books.length; i++) {
      var b = books[i];
      var st = b.inventory_status || 'Not Checked';
      if (st === 'Found' || st === 'موجود') present++;
      else if (st === 'Lost' || st === 'مفقود') lost++;
      else if (st === 'Damaged' || st === 'تالف') damaged++;
      else unchecked++;

      var cat = extractCategory(b);
      categories[cat] = (categories[cat] || 0) + 1;

      var src = b.library_source || b.source_db || 'غير محدد';
      sources[src] = (sources[src] || 0) + 1;

      var t = b.doctype || b.material_type || 'غير محدد';
      types[t] = (types[t] || 0) + 1;

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
      types: types,
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
    if (!document.getElementById('repTotal')) {
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
        + '<div class="report-section"><h3>التوزيع حسب النوع</h3><div id="typeChart" class="chart-box"></div></div>'
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

      renderBarChart('categoryChart', r.categories, { limit: 15, color: 'var(--teal)' });
      renderBarChart('sourceChart',   r.sources,    { limit: 10, color: 'var(--gold)' });
      renderBarChart('typeChart',     r.types,      { limit: 10, color: 'var(--teal-light)' });

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
      html += '<div class="book-card" onclick="showDet(' + b.record_id + ')">';
      html += '  <div class="book-card-head">';
      html += '    <div class="book-bib number">' + escHtml(b.bib || '—') + '</div>';
      html += '    <span class="status-pill ' + statusCls + '">' + statusAr + '</span>';
      html += '  </div>';
      html += '  <div class="book-title">' + escHtml(b.title || '(بدون عنوان)') + '</div>';
      if (b.author) html += '  <div class="book-author">✍ ' + escHtml(b.author) + '</div>';
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
    // Re-render using the last-known books source
    if (cid === 'allList' && typeof window.loadAllBooks === 'function') window.loadAllBooks();
    else if (cid === 'revList' && typeof window.loadReview === 'function') window.loadReview();
    else {
      // fallback: we don't have a way to re-query, so just leave.
      if (typeof window.loadAllBooks === 'function') window.loadAllBooks();
    }
    try { document.getElementById(cid).scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch (e) {}
  };

  /* ===========================================================
     V4 NEW #19 — showDet with all 28 fields
     =========================================================== */
  var DETAIL_SECTIONS = [
    { title: 'معلومات أساسية', fields: [
      ['bib',               'رقم المكتبة'],
      ['doctype',           'رقم التصنيف'],
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

  function patchedShowDet(id) {
    if (typeof window.dbGet !== 'function') {
      WARN('showDet: dbGet missing'); return;
    }
    Promise.resolve(window.dbGet(id)).then(function (b) {
      if (!b) return;
      if (typeof window.showPage === 'function') window.showPage('detail');
      else if (typeof window.go === 'function') window.go('detail');

      var holder = document.getElementById('bookDet');
      if (!holder) return;

      var cat = extractCategory(b);
      var statusAr = (b.inventory_status === 'Found' ? 'موجود' :
                      b.inventory_status === 'Lost' ? 'مفقود' :
                      b.inventory_status === 'Damaged' ? 'تالف' : 'غير مفحوص');
      var statusCls = (b.inventory_status === 'Found' ? 'found' :
                       b.inventory_status === 'Lost' ? 'lost' :
                       b.inventory_status === 'Damaged' ? 'damaged' : 'unchecked');

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
      html += '</div>';

      // Action buttons
      html += '<div class="detail-actions">';
      html += '  <button class="btn btn-teal" onclick="markFound(' + b.record_id + ')">✓ جرد موجود</button>';
      html += '  <button class="btn btn-coral" onclick="markLost(' + b.record_id + ')">✗ مفقود</button>';
      html += '  <button class="btn btn-gold" onclick="editBook(' + b.record_id + ')">✎ تعديل</button>';
      html += '  <button class="btn btn-ghost" onclick="history.back()">↩ رجوع</button>';
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
     Realtime hook — BATCHED refresh, does NOT call pull per event
     =========================================================== */
  var realtimeHookedWs = null;
  var realtimeBatchTimer = null;
  var realtimeEventsSinceLastPull = 0;

  function installRealtimeHook() {
    var ws = window.realtimeWs;
    if (!ws) return;
    if (realtimeHookedWs === ws) return;
    if (ws.readyState > 1) return;
    try {
      var origOnMessage = ws.onmessage;
      ws.onmessage = function (evt) {
        // DO NOT call origOnMessage's pullFromCloud path — our pagination
        // replacement is the authoritative pull. Still let the original
        // handle any UI status bits it might do.
        try { if (origOnMessage) origOnMessage.call(this, evt); } catch (e) {}
        try {
          var msg; try { msg = JSON.parse(evt.data); } catch (e) { return; }
          if (!msg) return;
          var isChange = msg.event === 'postgres_changes' ||
            msg.event === 'INSERT' || msg.event === 'UPDATE' || msg.event === 'DELETE' ||
            (msg.payload && msg.payload.data &&
             (msg.payload.data.type === 'INSERT' || msg.payload.data.type === 'UPDATE' || msg.payload.data.type === 'DELETE'));
          if (!isChange) return;
          realtimeEventsSinceLastPull++;
          clearTimeout(realtimeBatchTimer);
          // Batch realtime events: wait 800ms of silence, then do ONE pull+refresh
          realtimeBatchTimer = setTimeout(function () {
            var n = realtimeEventsSinceLastPull;
            realtimeEventsSinceLastPull = 0;
            LOG('realtime batch: ' + n + ' events → single paginated pull');
            paginatedPullFromCloud().catch(function () {});
          }, 800);
        } catch (e) {}
      };
      realtimeHookedWs = ws;
      LOG('realtime hook installed (batched)');
    } catch (e) {}
  }

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
  // V4 FIX: re-assert our patched UI functions in case app.v5c.js's
  // hoisted `function loadReports(){}` / `function showDet(){}` / `function renderList(){}`
  // overwrote our earlier window assignments. Safe to call repeatedly.
  function reassertV4Patches() {
    try { if (window.loadReports !== patchedLoadReports) window.loadReports = patchedLoadReports; } catch (e) {}
    try { if (window.showDet     !== patchedShowDet)     window.showDet     = patchedShowDet;     } catch (e) {}
    try { if (window.renderList  !== patchedRenderList)  window.renderList  = patchedRenderList;  } catch (e) {}
    try { if (window.pullFromCloud !== paginatedPullFromCloud) window.pullFromCloud = paginatedPullFromCloud; } catch (e) {}
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
    autoSyncStartedFor = who;
  }
  var poll = setInterval(tryStartAutoSync, 1500);
  setTimeout(function () { clearInterval(poll); }, 10 * 60 * 1000);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) tryStartAutoSync(); });
  window.addEventListener('focus', tryStartAutoSync);

  LOG('v4 ready — pagination + reports + detail + virtual list installed');
})();
