// ================================================================
// LIBRARY INVENTORY v5 — Production-Ready Multi-Device PWA
// Offline-first IndexedDB + Supabase Cloud Sync + OpenAI Vision
// Enhanced with Debug Log System & Robust AI/OCR Analysis
// ================================================================

// ============ DEBUG LOG SYSTEM ============
if (typeof DEBUG_LOG === 'undefined') { window.DEBUG_LOG = []; }
function debugLog(category, message, data) {
  const entry = { time: new Date().toISOString(), cat: category, msg: message, data: data || null };
  DEBUG_LOG.unshift(entry);
  if (DEBUG_LOG.length > 50) DEBUG_LOG.pop();
  console.log(`[${category}] ${message}`, data || '');
}

function getDebugLog() {
  return DEBUG_LOG.map(e => `[${e.time.split('T')[1].split('.')[0]}] [${e.cat}] ${e.msg}`).join('\n');
}

function getSystemStatus() {
  return {
    online: navigator.onLine,
    supabaseConfigured: !!CONFIG.supabaseUrl && !!CONFIG.supabaseKey,
    openaiConfigured: !!CONFIG.openaiKey,
    aiAvailable: !!CONFIG.openaiKey && navigator.onLine,
    syncStatus: syncStatus,
    pendingSync: pendingSyncCount
  };
}

// ============ AUTH SYSTEM ============
var AUTH_SALT = 'kfaa_lib_2024';
var USERS = {
  'المسؤول': { hash: '0d44a25a1868ec32dbba888cc568cff8787073187c6635560b11bf58f3dc1238', isAdmin: true },
  'محارب': { hash: 'aa969499e61ee3b45f9c924c6f09768c16e5a4f51f1a365fabe6b12ae9899084', isAdmin: false },
  'ابو عمر': { hash: '21f624e86ee166eb989f6e883844bc94dc1378e26baa1111cc420e748e6ad14f', isAdmin: false },
  'ابو طلال': { hash: 'ec5040e7877147af585223f6491a24c2d9577e012dc06983ab0cd7af75457fc5', isAdmin: false },
  'تجربه 1': { hash: 'c8c18ce213ce8ad638c823f8b36f8439e51ccc42c6e55cb36359fef8040d8b0c', isAdmin: false },
  'تجربه 2': { hash: '69dc2e72d00db2a665bff19e9873e518d759210091a3b462d2c0789b9c0633e4', isAdmin: false }
};

var currentUser = null; // { name, isAdmin }

async function hashPassword(pass) {
  var encoder = new TextEncoder();
  var data = encoder.encode(pass + AUTH_SALT);
  var hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer)).map(function(b) { return b.toString(16).padStart(2, '0'); }).join('');
}

async function doLogin(username, password) {
  var user = USERS[username];
  if (!user) return { success: false, error: 'المستخدم غير موجود' };

  var passHash = await hashPassword(password);
  if (passHash !== user.hash) return { success: false, error: 'كلمة المرور خاطئة' };

  currentUser = { name: username, isAdmin: user.isAdmin };
  sessionStorage.setItem('lib_user', JSON.stringify(currentUser));
  debugLog('AUTH', 'Login success: ' + username + ' (admin=' + user.isAdmin + ')');
  return { success: true, user: currentUser };
}

function doLogout() {
  currentUser = null;
  sessionStorage.removeItem('lib_user');
  debugLog('AUTH', 'Logged out');
}

function restoreSession() {
  try {
    var saved = sessionStorage.getItem('lib_user');
    if (saved) {
      var parsed = JSON.parse(saved);
      if (parsed.name && USERS[parsed.name]) {
        currentUser = parsed;
        debugLog('AUTH', 'Session restored: ' + parsed.name);
        return true;
      }
    }
  } catch(e) {}
  return false;
}

function isAdmin() {
  return currentUser && currentUser.isAdmin === true;
}

// ============ TEAM CODE (encode Supabase config for sharing) ============
function generateTeamCode() {
  if (!CONFIG.supabaseUrl || !CONFIG.supabaseKey) return null;
  var data = JSON.stringify({ u: CONFIG.supabaseUrl, k: CONFIG.supabaseKey });
  return btoa(unescape(encodeURIComponent(data)));
}

function applyTeamCode(code) {
  try {
    var decoded = decodeURIComponent(escape(atob(code.trim())));
    var data = JSON.parse(decoded);
    if (data.u && data.k) {
      CONFIG.supabaseUrl = data.u;
      CONFIG.supabaseKey = data.k;
      // Save Supabase connection to ALL stores for persistence
      _saveConfigToAllStores();
      debugLog('AUTH', 'Team code applied - Supabase configured and saved to all stores');
      return { success: true };
    }
    return { success: false, error: 'رمز غير صالح' };
  } catch(e) {
    return { success: false, error: 'رمز غير صالح: ' + e.message };
  }
}

// ============ SUPABASE APP_CONFIG (shared OpenAI key) ============
async function saveConfigToSupabase() {
  if (!CONFIG.supabaseUrl || !CONFIG.supabaseKey) return;
  try {
    // Upsert the OpenAI key to app_config table
    await supaFetch('app_config', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates'
      },
      body: JSON.stringify({
        id: 'openai_key',
        value: CONFIG.openaiKey,
        updated_by: currentUser ? currentUser.name : 'admin',
        updated_at: new Date().toISOString()
      })
    });
    debugLog('CONFIG', 'OpenAI key saved to Supabase app_config');
  } catch(e) {
    debugLog('ERROR', 'Failed to save config to Supabase: ' + e.message);
  }
}

async function loadConfigFromSupabase() {
  if (!CONFIG.supabaseUrl || !CONFIG.supabaseKey) return false;
  try {
    debugLog('CONFIG', 'Loading OpenAI key from Supabase app_config...');
    var data = await supaFetch('app_config?id=eq.openai_key&select=value');
    if (data && data.length > 0 && data[0].value) {
      CONFIG.openaiKey = data[0].value;
      debugLog('CONFIG', 'OpenAI key loaded from Supabase app_config');
      return true;
    } else {
      debugLog('CONFIG', 'No OpenAI key found in Supabase app_config');
    }
  } catch(e) {
    debugLog('ERROR', 'Failed to load config from Supabase: ' + e.message);
    // Retry once after a short delay
    try {
      debugLog('CONFIG', 'Retrying loadConfigFromSupabase...');
      await new Promise(function(r) { setTimeout(r, 1000); });
      var data2 = await supaFetch('app_config?id=eq.openai_key&select=value');
      if (data2 && data2.length > 0 && data2[0].value) {
        CONFIG.openaiKey = data2[0].value;
        debugLog('CONFIG', 'OpenAI key loaded from Supabase (retry success)');
        return true;
      }
    } catch(e2) {
      debugLog('ERROR', 'Retry also failed: ' + e2.message);
    }
  }
  return false;
}

// ============ CONFIG (Multi-layer persistence) ============
// Using window.CONFIG to avoid any redeclaration conflicts with cached HTML
if (typeof CONFIG === 'undefined') {
  window.CONFIG = {
    supabaseUrl: '',
    supabaseKey: '',
    openaiKey: '',
    syncInterval: 15000,
    tableName: 'books'
  };
} else {
  // CONFIG already exists (from cached HTML) — just ensure defaults
  if (!CONFIG.syncInterval) CONFIG.syncInterval = 15000;
  if (!CONFIG.tableName) CONFIG.tableName = 'books';
}

// All possible localStorage keys where config might be stored (current + legacy)
var CONFIG_KEYS = ['lib_config', 'lib_config_backup', 'library_config', 'libraryConfig'];
var CONFIG_FIELDS = ['supabaseUrl', 'supabaseKey', 'openaiKey', 'tableName'];
var CONFIG_DIAG = { source: 'none', restored: false, attempts: [] };

function loadConfig() {
  let found = false;

  // Step 1: Try all possible localStorage keys
  for (const key of CONFIG_KEYS) {
    try {
      const raw = localStorage.getItem(key);
      if (raw) {
        const parsed = JSON.parse(raw);
        // Check if it actually has useful config data
        if (parsed.supabaseUrl || parsed.supabaseKey || parsed.openaiKey) {
          Object.assign(CONFIG, parsed);
          CONFIG_DIAG.source = key;
          CONFIG_DIAG.attempts.push(`✅ Found config in localStorage["${key}"]`);
          found = true;
          debugLog('CONFIG', `Loaded from localStorage["${key}"]`);
          break;
        } else {
          CONFIG_DIAG.attempts.push(`⚪ Key "${key}" exists but empty config`);
        }
      } else {
        CONFIG_DIAG.attempts.push(`⚪ Key "${key}" not found`);
      }
    } catch(e) {
      CONFIG_DIAG.attempts.push(`❌ Key "${key}" parse error: ${e.message}`);
    }
  }

  // Step 1.5: Try sessionStorage as backup (Fix 1)
  if (!found) {
    try {
      const raw = sessionStorage.getItem('lib_config_session');
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed.supabaseUrl || parsed.supabaseKey || parsed.openaiKey) {
          Object.assign(CONFIG, parsed);
          CONFIG_DIAG.source = 'sessionStorage';
          CONFIG_DIAG.attempts.push(`✅ Found config in sessionStorage["lib_config_session"]`);
          found = true;
          debugLog('CONFIG', `Loaded from sessionStorage["lib_config_session"]`);
        } else {
          CONFIG_DIAG.attempts.push(`⚪ sessionStorage key exists but empty config`);
        }
      } else {
        CONFIG_DIAG.attempts.push(`⚪ sessionStorage key not found`);
      }
    } catch(e) {
      CONFIG_DIAG.attempts.push(`❌ sessionStorage parse error: ${e.message}`);
    }
  }

  // Step 2: Try IndexedDB config store (backup)
  if (!found) {
    CONFIG_DIAG.attempts.push('🔄 Trying IndexedDB config backup...');
    // This is async - we'll handle it in loadConfigFromIDB()
  }

  // Step 3: If we found config, save backup copies everywhere
  if (found) {
    _saveConfigToAllStores();
  }

  debugLog('CONFIG', `Config load complete. Source: ${CONFIG_DIAG.source}`, {
    supabaseUrl: CONFIG.supabaseUrl ? CONFIG.supabaseUrl.substring(0, 20) + '...' : '(empty)',
    openaiKey: CONFIG.openaiKey ? 'sk-...' + CONFIG.openaiKey.slice(-4) : '(empty)',
    tableName: CONFIG.tableName
  });
}

// Async: try to restore config from IndexedDB (called after DB is open)
async function loadConfigFromIDB() {
  if (CONFIG.supabaseUrl && CONFIG.openaiKey) {
    debugLog('CONFIG', 'Config already loaded, skipping IDB restore');
    return; // Already have config
  }

  try {
    const tx = db.transaction('books', 'readonly');
    const store = tx.objectStore('books');

    // Try reading a special config record we store in IDB
    const configStore = await new Promise((resolve, reject) => {
      // Check if config_store exists
      if (db.objectStoreNames.contains('config_store')) {
        const cTx = db.transaction('config_store', 'readonly');
        const cStore = cTx.objectStore('config_store');
        const req = cStore.get('app_config');
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
      } else {
        resolve(null);
      }
    });

    if (configStore && (configStore.supabaseUrl || configStore.openaiKey)) {
      Object.assign(CONFIG, {
        supabaseUrl: configStore.supabaseUrl || CONFIG.supabaseUrl,
        supabaseKey: configStore.supabaseKey || CONFIG.supabaseKey,
        openaiKey: configStore.openaiKey || CONFIG.openaiKey,
        tableName: configStore.tableName || CONFIG.tableName
      });
      CONFIG_DIAG.source = 'IndexedDB';
      CONFIG_DIAG.restored = true;
      CONFIG_DIAG.attempts.push('✅ Restored config from IndexedDB backup');
      debugLog('CONFIG', 'Restored from IndexedDB backup!');
      _saveConfigToAllStores();
    } else {
      CONFIG_DIAG.attempts.push('⚪ No config found in IndexedDB');
    }
  } catch(e) {
    CONFIG_DIAG.attempts.push(`❌ IndexedDB restore error: ${e.message}`);
    debugLog('ERROR', 'IDB config restore failed', e.message);
  }

  // Fix 3: After loading from IDB, always try loadConfigFromSupabase to get the latest OpenAI key
  if (CONFIG.supabaseUrl && CONFIG.supabaseKey) {
    debugLog('CONFIG', 'Attempting to load OpenAI key from Supabase...');
    await loadConfigFromSupabase();
  }
}

function saveConfig() {
  // Update CONFIG object first
  debugLog('CONFIG', 'Saving configuration...');
  _saveConfigToAllStores();
}

function _saveConfigToAllStores() {
  const data = {
    supabaseUrl: CONFIG.supabaseUrl,
    supabaseKey: CONFIG.supabaseKey,
    openaiKey: CONFIG.openaiKey,
    tableName: CONFIG.tableName || 'books'
  };

  // Save to primary localStorage key
  try {
    localStorage.setItem('lib_config', JSON.stringify(data));
  } catch(e) { debugLog('ERROR', 'Failed saving to lib_config', e.message); }

  // Save to backup localStorage key
  try {
    localStorage.setItem('lib_config_backup', JSON.stringify(data));
  } catch(e) {}

  // Save to sessionStorage as additional backup (Fix 1)
  try {
    sessionStorage.setItem('lib_config_session', JSON.stringify(data));
  } catch(e) { debugLog('ERROR', 'Failed saving to sessionStorage', e.message); }

  // Save to IndexedDB config store (if DB is open)
  if (db) {
    try {
      if (db.objectStoreNames.contains('config_store')) {
        const tx = db.transaction('config_store', 'readwrite');
        tx.objectStore('config_store').put({ id: 'app_config', ...data, saved_at: new Date().toISOString() });
      }
    } catch(e) { debugLog('ERROR', 'Failed saving config to IDB', e.message); }
  }

  debugLog('CONFIG', 'Config saved to all stores');
}

function getConfigDiagnostic() {
  return {
    source: CONFIG_DIAG.source,
    restored: CONFIG_DIAG.restored,
    attempts: CONFIG_DIAG.attempts,
    current: {
      supabaseUrl: CONFIG.supabaseUrl ? '✅ ' + CONFIG.supabaseUrl.substring(0, 30) + '...' : '❌ Empty',
      supabaseKey: CONFIG.supabaseKey ? '✅ Key present (' + CONFIG.supabaseKey.length + ' chars)' : '❌ Empty',
      openaiKey: CONFIG.openaiKey ? '✅ sk-...' + CONFIG.openaiKey.slice(-4) : '❌ Empty',
      tableName: CONFIG.tableName || 'books'
    },
    localStorage: {
      lib_config: !!localStorage.getItem('lib_config'),
      lib_config_backup: !!localStorage.getItem('lib_config_backup')
    }
  };
}

// ============ IndexedDB ============
var DB_NAME = 'LibraryInventoryDB';
var DB_VER = 3; // Bumped for config_store
var STORE = 'books';
var SYNC_STORE = 'sync_queue';
var CONFIG_STORE = 'config_store';
var db = null;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = e => {
      const d = e.target.result;
      if (!d.objectStoreNames.contains(STORE)) {
        const s = d.createObjectStore(STORE, { keyPath: 'record_id', autoIncrement: true });
        s.createIndex('title', 'title', { unique: false });
        s.createIndex('inventory_status', 'inventory_status', { unique: false });
        s.createIndex('review_status', 'review_status', { unique: false });
        s.createIndex('updated_at', 'updated_at', { unique: false });
      }
      if (!d.objectStoreNames.contains(SYNC_STORE)) {
        d.createObjectStore(SYNC_STORE, { keyPath: 'id', autoIncrement: true });
      }
      if (!d.objectStoreNames.contains(CONFIG_STORE)) {
        d.createObjectStore(CONFIG_STORE, { keyPath: 'id' });
        debugLog('DB', 'Created config_store for persistent config backup');
      }
    };
    req.onsuccess = e => { db = e.target.result; resolve(db); };
    req.onerror = e => reject(e.target.error);
  });
}

function dbTx(store, mode) { return db.transaction(store, mode).objectStore(store); }

function dbAll() {
  return new Promise((r, j) => { const q = dbTx(STORE, 'readonly').getAll(); q.onsuccess = () => r(q.result); q.onerror = () => j(q.error); });
}

function dbGet(id) {
  return new Promise((r, j) => { const q = dbTx(STORE, 'readonly').get(id); q.onsuccess = () => r(q.result); q.onerror = () => j(q.error); });
}

function generateUUID() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    var r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

function dbPut(book) {
  book.updated_at = new Date().toISOString();
  return new Promise((r, j) => { var q = dbTx(STORE, 'readwrite').put(book); q.onsuccess = function() { queueSync('upsert', book); r(q.result); }; q.onerror = function() { j(q.error); }; });
}

function dbAdd(book) {
  if (!book.record_id) delete book.record_id;
  book.updated_at = new Date().toISOString();
  book.created_at = book.created_at || new Date().toISOString();
  return new Promise((r, j) => { var q = dbTx(STORE, 'readwrite').add(book); q.onsuccess = function() { book.record_id = q.result; queueSync('upsert', book); r(book); }; q.onerror = function() { j(q.error); }; });
}

function dbClear() {
  return new Promise((r, j) => { const q = dbTx(STORE, 'readwrite').clear(); q.onsuccess = () => r(); q.onerror = () => j(q.error); });
}

function dbCount() {
  return new Promise((r, j) => { const q = dbTx(STORE, 'readonly').count(); q.onsuccess = () => r(q.result); q.onerror = () => j(q.error); });
}

// ============ SYNC QUEUE ============
function queueSync(action, book) {
  if (!CONFIG.supabaseUrl) return;
  try {
    const s = dbTx(SYNC_STORE, 'readwrite');
    s.add({ action, book: { ...book }, timestamp: new Date().toISOString() });
    debugLog('SYNC', `Queued ${action} for book ${book.title || 'unknown'}`);
  } catch(e) {
    debugLog('ERROR', 'Failed to queue sync', e.message);
  }

  // Fix 6: Auto-flush sync queue when online
  if (navigator.onLine && CONFIG.supabaseUrl) {
    clearTimeout(window._syncFlushTimer);
    window._syncFlushTimer = setTimeout(function() { pushToCloud(); }, 500);
  }
}

function getSyncQueue() {
  return new Promise((r, j) => {
    const q = dbTx(SYNC_STORE, 'readonly').getAll();
    q.onsuccess = () => r(q.result); q.onerror = () => j(q.error);
  });
}

function clearSyncQueue() {
  return new Promise((r, j) => {
    const q = dbTx(SYNC_STORE, 'readwrite').clear();
    q.onsuccess = () => r(); q.onerror = () => j(q.error);
  });
}

// ============ SUPABASE SYNC ============
var syncStatus = 'idle'; // idle | syncing | error | offline
var pendingSyncCount = 0;

async function supaFetch(path, opts = {}) {
  if (!CONFIG.supabaseUrl || !CONFIG.supabaseKey) return null;
  const url = `${CONFIG.supabaseUrl}/rest/v1/${path}`;
  const headers = {
    'apikey': CONFIG.supabaseKey,
    'Authorization': `Bearer ${CONFIG.supabaseKey}`,
    'Content-Type': 'application/json',
    'Prefer': opts.prefer || 'return=representation',
    ...opts.headers
  };
  const res = await fetch(url, { ...opts, headers });
  if (!res.ok) {
    var errText = '';
    try { errText = await res.text(); } catch(e2) {}
    throw new Error('Supabase ' + res.status + ': ' + errText);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function pushToCloud() {
  if (!CONFIG.supabaseUrl || !navigator.onLine) return;
  var queue = await getSyncQueue();
  if (!queue.length) return;

  setSyncStatus('syncing');
  debugLog('SYNC', 'Pushing ' + queue.length + ' items to cloud');
  var failed = [];
  for (var i = 0; i < queue.length; i++) {
    try {
      var b = Object.assign({}, queue[i].book);
      var localId = b.record_id;
      var cloudId = b.cloud_id || null;
      // Remove local-only fields before sending to Supabase
      delete b.record_id; // Supabase has its own record_id (auto-increment)
      delete b.cloud_id;  // Local-only tracking field
      delete b.id;        // Just in case

      if (cloudId) {
        // UPDATE existing cloud record via PATCH (Supabase PK = record_id)
        var result = await supaFetch(CONFIG.tableName + '?record_id=eq.' + cloudId, {
          method: 'PATCH',
          body: JSON.stringify(b),
          headers: { 'Prefer': 'return=representation' }
        });
        debugLog('SYNC', 'Updated cloud record_id=' + cloudId + ': ' + (b.title || 'unknown'));
      } else {
        // INSERT new record — Supabase auto-assigns record_id
        var result = await supaFetch(CONFIG.tableName, {
          method: 'POST',
          body: JSON.stringify(b),
          headers: { 'Prefer': 'return=representation' }
        });
        // Save the cloud record_id back to local IndexedDB
        if (result && result.length > 0 && result[0].record_id && localId) {
          try {
            var localBook = await dbGet(localId);
            if (localBook) {
              localBook.cloud_id = result[0].record_id;
              var tx = db.transaction(STORE, 'readwrite');
              tx.objectStore(STORE).put(localBook);
              debugLog('SYNC', 'Saved cloud_id=' + result[0].record_id + ' for local book ' + localId);
            }
          } catch(e2) {
            debugLog('WARN', 'Could not save cloud_id back: ' + e2.message);
          }
        }
        debugLog('SYNC', 'Inserted to cloud: ' + (b.title || 'unknown'));
      }
    } catch(e) {
      debugLog('ERROR', 'Push failed for: ' + ((b && b.title) || 'unknown') + ' — ' + e.message);
      failed.push(queue[i]);
    }
  }
  await clearSyncQueue();
  // Re-queue failed items
  if (failed.length > 0) {
    for (var f = 0; f < failed.length; f++) {
      queueSync(failed[f].action, failed[f].book);
    }
    debugLog('SYNC', failed.length + ' items re-queued for retry');
  }
  pendingSyncCount = failed.length;
  setSyncStatus(failed.length > 0 ? 'error' : 'idle');
  debugLog('SYNC', 'Push completed: ' + (queue.length - failed.length) + ' success, ' + failed.length + ' failed');
}

async function pullFromCloud() {
  if (!CONFIG.supabaseUrl || !navigator.onLine) return;
  setSyncStatus('syncing');
  debugLog('SYNC', 'Pulling from cloud');
  try {
    var remote = await supaFetch(CONFIG.tableName + '?select=*&order=updated_at.desc');
    if (!remote || !remote.length) {
      setSyncStatus('idle');
      debugLog('SYNC', 'No remote data to pull');
      return;
    }

    var local = await dbAll();
    // Build lookup maps: by cloud_id and by title+author
    var localByCloudId = {};
    var localByTitle = {};
    for (var i = 0; i < local.length; i++) {
      if (local[i].cloud_id) localByCloudId[local[i].cloud_id] = local[i];
      var titleKey = (local[i].title || '').trim() + '|||' + (local[i].author || '').trim();
      if (titleKey !== '|||') localByTitle[titleKey] = local[i];
    }
    var updateCount = 0;
    var addCount = 0;

    for (var r = 0; r < remote.length; r++) {
      var rb = remote[r];
      var remoteCloudId = rb.record_id; // Supabase auto-generated record_id

      // Try to find local match: by cloud_id first, then by title+author
      var lb = localByCloudId[remoteCloudId] || null;
      if (!lb) {
        var rTitleKey = (rb.title || '').trim() + '|||' + (rb.author || '').trim();
        if (rTitleKey !== '|||') lb = localByTitle[rTitleKey] || null;
      }

      if (lb) {
        // Existing book — update if remote is newer, always ensure cloud_id is set
        var needsUpdate = !lb.cloud_id || new Date(rb.updated_at || 0) > new Date(lb.updated_at || 0);
        if (needsUpdate) {
          var updatedBook = Object.assign({}, rb);
          updatedBook.record_id = lb.record_id; // Keep LOCAL record_id (IndexedDB key)
          updatedBook.cloud_id = remoteCloudId;  // Track which Supabase row this is
          var tx = db.transaction(STORE, 'readwrite');
          tx.objectStore(STORE).put(updatedBook);
          updateCount++;
        }
      } else {
        // New book from cloud — add locally
        var newBook = Object.assign({}, rb);
        newBook.cloud_id = remoteCloudId; // Track which Supabase row this is
        delete newBook.record_id; // Let IndexedDB assign its own local id
        var tx2 = db.transaction(STORE, 'readwrite');
        tx2.objectStore(STORE).add(newBook);
        addCount++;
      }
    }
    setSyncStatus('idle');
    debugLog('SYNC', 'Pull completed: ' + updateCount + ' updated, ' + addCount + ' added from cloud');
    // Refresh the UI after pull
    if (addCount > 0 || updateCount > 0) {
      if (typeof loadHome === 'function') loadHome();
    }
  } catch(e) {
    debugLog('ERROR', 'Sync pull error: ' + e.message);
    setSyncStatus('error');
  }
}

async function repairUnsynced() {
  // Find local books that have no cloud_id and push them
  if (!CONFIG.supabaseUrl || !navigator.onLine) return;
  try {
    var local = await dbAll();
    var unsynced = [];
    for (var i = 0; i < local.length; i++) {
      if (!local[i].cloud_id) unsynced.push(local[i]);
    }
    if (unsynced.length === 0) return;
    debugLog('SYNC', 'Repair: found ' + unsynced.length + ' unsynced local books, queuing for push');
    for (var j = 0; j < unsynced.length; j++) {
      queueSync('upsert', unsynced[j]);
    }
    // Now push them
    await pushToCloud();
  } catch(e) {
    debugLog('ERROR', 'Repair error: ' + e.message);
  }
}

async function fullSync() {
  if (!CONFIG.supabaseUrl || !navigator.onLine) {
    setSyncStatus('offline');
    debugLog('SYNC', 'Offline - sync skipped');
    return;
  }
  try {
    await pushToCloud();
    await pullFromCloud();
    await repairUnsynced();
  } catch(e) {
    debugLog('ERROR', 'fullSync error: ' + e.message);
    setSyncStatus('error');
  }
}

function setSyncStatus(s) {
  syncStatus = s;
  const el = document.getElementById('syncBadge');
  if (!el) return;
  const map = {
    idle: { text: '✅ متزامن', cls: 'badge-synced' },
    syncing: { text: '⏳ جاري...', cls: 'badge-syncing' },
    error: { text: '❌ خطأ', cls: 'badge-sync-error' },
    offline: { text: '📴 بلا إنترنت', cls: 'badge-offline' }
  };
  const info = map[s] || map['offline'];
  el.textContent = info.text;
  el.className = 'badge ' + info.cls;
}

// Auto-sync interval
var syncTimer = null;
function startAutoSync() {
  if (syncTimer) clearInterval(syncTimer);
  if (CONFIG.supabaseUrl) {
    syncTimer = setInterval(fullSync, CONFIG.syncInterval);
    fullSync();
    // --- SYNC FIX: Start Supabase Realtime for instant cross-user sync ---
    startRealtimeSync();
    debugLog('SYNC', 'Auto-sync started: interval=' + CONFIG.syncInterval + 'ms, realtime=enabled');
  }
}

// Sync when user returns to the app (tab becomes visible again)
document.addEventListener('visibilitychange', function() {
  if (!document.hidden && CONFIG.supabaseUrl && navigator.onLine) {
    debugLog('SYNC', 'App became visible — syncing...');
    fullSync().then(function() {
      if (typeof loadHome === 'function') loadHome();
    });
  }
});

// ============ SUPABASE REALTIME (instant cross-user sync) ============
var realtimeWs = null;
var realtimeHeartbeat = null;

function startRealtimeSync() {
  if (!CONFIG.supabaseUrl || !CONFIG.supabaseKey) return;
  if (realtimeWs && realtimeWs.readyState <= 1) return; // already connected or connecting

  try {
    var wsUrl = CONFIG.supabaseUrl.replace('https://', 'wss://').replace('http://', 'ws://');
    wsUrl += '/realtime/v1/websocket?apikey=' + CONFIG.supabaseKey + '&vsn=1.0.0';
    realtimeWs = new WebSocket(wsUrl);

    realtimeWs.onopen = function() {
      debugLog('REALTIME', 'WebSocket connected');
      // Join the books channel to listen for changes
      var joinMsg = JSON.stringify({
        topic: 'realtime:public:' + (CONFIG.tableName || 'books'),
        event: 'phx_join',
        payload: { config: { broadcast: { self: false }, presence: { key: '' }, postgres_changes: [{ event: '*', schema: 'public', table: CONFIG.tableName || 'books' }] } },
        ref: '1'
      });
      realtimeWs.send(joinMsg);

      // Heartbeat to keep connection alive
      if (realtimeHeartbeat) clearInterval(realtimeHeartbeat);
      realtimeHeartbeat = setInterval(function() {
        if (realtimeWs && realtimeWs.readyState === 1) {
          realtimeWs.send(JSON.stringify({ topic: 'phoenix', event: 'heartbeat', payload: {}, ref: 'hb' }));
        }
      }, 30000);
    };

    realtimeWs.onmessage = function(evt) {
      try {
        var msg = JSON.parse(evt.data);
        // Fix 2: Supabase sends postgres_changes events with payload.data containing the change
        var isChange = false;
        if (msg.event === 'postgres_changes') isChange = true;
        if (msg.event === 'INSERT' || msg.event === 'UPDATE' || msg.event === 'DELETE') isChange = true;
        if (msg.payload && msg.payload.type === 'INSERT') isChange = true;
        if (msg.payload && msg.payload.type === 'UPDATE') isChange = true;
        if (msg.payload && msg.payload.type === 'DELETE') isChange = true;
        // Also check for the data wrapper format
        if (msg.payload && msg.payload.data && msg.payload.data.type) isChange = true;

        if (isChange) {
          debugLog('REALTIME', 'Change detected: ' + (msg.event || msg.payload?.type || 'unknown'));
          // Pull latest data and refresh UI
          setTimeout(function() {
            pullFromCloud().then(function() {
              if (typeof loadHome === 'function') loadHome();
            });
          }, 500);
        }
      } catch(e) {}
    };

    realtimeWs.onclose = function() {
      debugLog('REALTIME', 'WebSocket closed, will reconnect in 5s');
      if (realtimeHeartbeat) clearInterval(realtimeHeartbeat);
      // Auto-reconnect
      setTimeout(startRealtimeSync, 5000);
    };

    realtimeWs.onerror = function(err) {
      debugLog('WARN', 'Realtime WebSocket error');
    };
  } catch(e) {
    debugLog('ERROR', 'Failed to start Realtime: ' + e.message);
  }
}

// ============ ARABIC NORMALIZATION ============
function normAr(text) {
  if (!text) return '';
  let t = String(text);
  t = t.replace(/[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06DC\u06DF-\u06E4\u06E7\u06E8\u06EA-\u06ED]/g, '');
  t = t.replace(/[\u0622\u0623\u0625\u0671]/g, '\u0627');
  t = t.replace(/\u0629/g, '\u0647');
  t = t.replace(/\u0649/g, '\u064A');
  t = t.replace(/\u0624/g, '\u0648');
  t = t.replace(/\u0626/g, '\u064A');
  t = t.replace(/\u0640/g, '');
  t = t.replace(/[.,،؛:!؟?'"()\[\]{}\-–—\/\\|_@#$%^&*+=<>~`]/g, ' ');
  return t.toLowerCase().replace(/\s+/g, ' ').trim();
}

// ============ MATCHING ENGINE ============
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  const d = [];
  for (let i = 0; i <= m; i++) { d[i] = [i]; }
  for (let j = 1; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      d[i][j] = Math.min(d[i-1][j]+1, d[i][j-1]+1, d[i-1][j-1]+(a[i-1]===b[j-1]?0:1));
  return d[m][n];
}

function trigramSim(a, b) {
  if (!a || !b) return 0;
  const tg = s => { const t = new Set(); const p = `  ${s} `; for (let i=0;i<p.length-2;i++) t.add(p.substring(i,i+3)); return t; };
  const t1 = tg(a), t2 = tg(b);
  let inter = 0; t1.forEach(x => { if(t2.has(x)) inter++; });
  const union = t1.size + t2.size - inter;
  return union ? inter/union : 0;
}

function sim(a, b) {
  if (!a || !b) return 0;
  const na = normAr(a), nb = normAr(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1.0;
  if (na.includes(nb) || nb.includes(na)) return 0.7 + 0.3 * Math.min(na.length,nb.length)/Math.max(na.length,nb.length);
  const wA = na.split(' ').filter(w=>w.length>1), wB = nb.split(' ').filter(w=>w.length>1);
  let wordOvl = 0;
  if (wA.length && wB.length) {
    const matched = wA.filter(wa => wB.some(wb => wa===wb || (wa.length>3 && wb.length>3 && (wa.includes(wb)||wb.includes(wa)))));
    wordOvl = matched.length / Math.max(wA.length, wB.length);
  }
  const maxL = Math.max(na.length, nb.length);
  const levSim = 1 - levenshtein(na, nb) / maxL;
  const triSim = trigramSim(na, nb);
  return Math.max(wordOvl * 0.95, levSim * 0.5 + triSim * 0.5);
}

async function matchBooks(ocrData) {
  const books = await dbAll();
  const results = books.map(book => {
    const titleScore = Math.max(sim(ocrData.title, book.title), sim(ocrData.title, book.subtitle)*0.8);
    const authorScore = Math.max(sim(ocrData.author, book.author), sim(ocrData.author, book.additional_author));
    const publisherScore = sim(ocrData.publisher, book.publisher);
    let callScore = 0;
    if (ocrData.call_number && book.full_call_number) callScore = sim(ocrData.call_number, book.full_call_number);
    let isbnScore = 0;
    if (ocrData.isbn && book.isbn) {
      const a = String(ocrData.isbn).replace(/[\s\-]/g,''), b = String(book.isbn).replace(/[\s\-]/g,'');
      if (a === b && a.length >= 10) isbnScore = 1;
    }
    let langBonus = 0;
    if (ocrData.language && book.language && normAr(ocrData.language) === normAr(book.language)) langBonus = 0.05;
    let total;
    if (isbnScore === 1) total = 0.98;
    else if (callScore > 0.8) total = callScore*0.4 + titleScore*0.35 + authorScore*0.15 + publisherScore*0.1;
    else total = titleScore*0.50 + authorScore*0.20 + publisherScore*0.15 + callScore*0.10 + langBonus;
    return { book, confidence: Math.round(Math.min(1,total)*100),
      breakdown: { title: Math.round(titleScore*100), author: Math.round(authorScore*100), publisher: Math.round(publisherScore*100), call_number: Math.round(callScore*100), isbn: Math.round(isbnScore*100) }
    };
  });
  results.sort((a,b) => b.confidence - a.confidence);
  return results.slice(0, 5);
}

// ============ SEARCH ============
async function searchBooks(query, field) {
  if (!query || !query.trim()) return [];
  const books = await dbAll();
  const q = normAr(query);
  return books.map(b => {
    let score = 0;
    if (!field || field==='all' || field==='title') score = Math.max(score, sim(query, b.title), sim(query, b.subtitle)*0.8);
    if (!field || field==='all' || field==='author') score = Math.max(score, sim(query, b.author));
    if (!field || field==='all' || field==='publisher') score = Math.max(score, sim(query, b.publisher));
    if (!field || field==='all') {
      if (b.isbn && normAr(String(b.isbn)).includes(q)) score = 1;
      if (b.full_call_number && normAr(String(b.full_call_number)).includes(q)) score = Math.max(score, 0.9);
      if (b.internal_barcode && normAr(String(b.internal_barcode)).includes(q)) score = Math.max(score, 0.95);
    }
    return { ...b, _score: score };
  }).filter(b => b._score > 0.12).sort((a,b) => b._score - a._score);
}

// ============ BARCODE ============
async function generateBarcode() {
  const books = await dbAll();
  const existing = books.filter(b => b.internal_barcode && b.internal_barcode.startsWith('KFAA-LIB-'))
    .map(b => parseInt(b.internal_barcode.replace('KFAA-LIB-',''), 10)).filter(n => !isNaN(n));
  const next = existing.length > 0 ? Math.max(...existing) + 1 : 1;
  return `KFAA-LIB-${String(next).padStart(6,'0')}`;
}

function generateBarcodeSVG(code) {
  let bars = '', x = 10;
  bars += `<rect x="${x}" y="5" width="2" height="55" fill="black"/>`; x += 3;
  bars += `<rect x="${x}" y="5" width="1" height="55" fill="black"/>`; x += 2;
  bars += `<rect x="${x}" y="5" width="2" height="55" fill="black"/>`; x += 4;
  for (const ch of code.split('')) {
    const c = ch.charCodeAt(0);
    const w = [(c>>4)&3,(c>>2)&3,c&3];
    for (let i=0;i<3;i++) { const bw = Math.max(1,w[i]); if(i%2===0) bars += `<rect x="${x}" y="5" width="${bw}" height="55" fill="black"/>`; x += bw+1; }
    x += 1;
  }
  bars += `<rect x="${x}" y="5" width="2" height="55" fill="black"/>`; x += 3;
  bars += `<rect x="${x}" y="5" width="1" height="55" fill="black"/>`; x += 2;
  bars += `<rect x="${x}" y="5" width="2" height="55" fill="black"/>`;
  return `<div style="background:#fff;padding:20px;border-radius:12px;text-align:center"><svg viewBox="0 0 220 80" style="max-width:100%">${bars}<text x="110" y="75" text-anchor="middle" font-family="monospace" font-size="10" font-weight="bold">${code}</text></svg></div>`;
}

// ============ CONFIRM ============
async function confirmBook(id, confidence, method) {
  const book = await dbGet(id);
  if (!book) return null;

  // --- SYNC FIX: Check cloud first if already inventoried by someone else ---
  if (CONFIG.supabaseUrl && navigator.onLine && book.cloud_id) {
    try {
      var cloudData = await supaFetch(CONFIG.tableName + '?record_id=eq.' + book.cloud_id + '&select=inventory_status,inventoried_by,last_inventory_date');
      if (cloudData && cloudData.length > 0 && cloudData[0].inventory_status === 'Found') {
        var byWhom = cloudData[0].inventoried_by || 'مستخدم آخر';
        if (byWhom !== (currentUser ? currentUser.name : '')) {
          // Already inventoried by someone else
          return { alreadyInventoried: true, inventoried_by: byWhom, book: book };
        }
      }
    } catch(e) {
      debugLog('WARN', 'Could not check cloud inventory status: ' + e.message);
    }
  }

  book.inventory_status = 'Found';
  book.last_inventory_date = new Date().toISOString().split('T')[0];
  book.inventoried_by = currentUser ? currentUser.name : 'غير معروف';
  book.match_method = method || 'Manual';
  book.match_confidence = confidence || 100;
  book.review_status = 'Confirmed';
  book.updated_at = new Date().toISOString();
  if (!book.internal_barcode) book.internal_barcode = await generateBarcode();
  await dbPut(book);
  debugLog('MATCH', `Confirmed book ${book.title} with ${method} method by ${book.inventoried_by}`);

  // Fix 5: Push immediately to propagate change to other users
  if (CONFIG.supabaseUrl && navigator.onLine) {
    setTimeout(function() { pushToCloud(); }, 100);
  }

  return book;
}

// ============ IMPORT (Smart Auto-detect) ============
async function importFile(file, columnMap) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        const data = new Uint8Array(e.target.result);
        const wb = XLSX.read(data, { type: 'array' });
        const sheet = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(sheet);
        if (!rows.length) {
          debugLog('IMPORT', 'File is empty');
          reject(new Error('الملف فارغ'));
          return;
        }

        // Auto-detect or use provided mapping
        const map = columnMap || autoDetectColumns(Object.keys(rows[0]));
        debugLog('IMPORT', `Detected ${rows.length} rows with mapping`, map);

        let count = 0;
        for (const r of rows) {
          const book = {
            title: r[map.title] || '', subtitle: r[map.subtitle] || '',
            author: r[map.author] || '', additional_author: r[map.additional_author] || '',
            language: r[map.language] || '', publisher: r[map.publisher] || '',
            publication_year: r[map.publication_year] || '', isbn: r[map.isbn] || '',
            dewey_number: r[map.dewey_number] || '', cutter_number: r[map.cutter_number] || '',
            full_call_number: r[map.full_call_number] || '',
            material_type: r[map.material_type] || 'Book',
            inventory_status: r[map.inventory_status] || 'Not Checked',
            condition: r[map.condition] || 'Good',
            location: r[map.location] || '', shelf: r[map.shelf] || '',
            notes: r[map.notes] || '', internal_barcode: r[map.internal_barcode] || '',
            last_inventory_date: r[map.last_inventory_date] || '',
            match_confidence: '', match_method: '',
            review_status: r[map.review_status] || 'Pending',
            cover_image_name: '', created_at: new Date().toISOString()
          };
          if (book.title) { await dbAdd(book); count++; }
        }
        debugLog('IMPORT', `Successfully imported ${count} books`);
        resolve({ count, columns: Object.keys(rows[0]), mapping: map });
      } catch (err) {
        debugLog('ERROR', 'Import file error', err.message);
        reject(err);
      }
    };
    reader.onerror = () => {
      debugLog('ERROR', 'File read error', reader.error);
      reject(reader.error);
    };
    reader.readAsArrayBuffer(file);
  });
}

function autoDetectColumns(headers) {
  const map = {};
  const patterns = {
    title: [/^title$/i, /عنوان/i, /^name$/i, /book.?title/i, /العنوان/],
    subtitle: [/subtitle/i, /عنوان.?فرعي/i, /sub.?title/i],
    author: [/^author$/i, /مؤلف/i, /writer/i, /المؤلف/],
    additional_author: [/additional.?author/i, /co.?author/i],
    language: [/^lang/i, /language/i, /اللغة/i, /لغة/i],
    publisher: [/publish/i, /ناشر/i, /الناشر/i, /press/i, /دار/i],
    publication_year: [/year/i, /سنة/i, /date/i, /pub.*year/i],
    isbn: [/isbn/i],
    dewey_number: [/dewey/i, /ديوي/i],
    cutter_number: [/cutter/i],
    full_call_number: [/call.?num/i, /رقم.?التصنيف/i, /classification/i],
    material_type: [/material/i, /type/i, /نوع/i],
    inventory_status: [/inventory.?status/i, /status/i, /حالة/i],
    condition: [/condition/i, /حالة.?المادة/i],
    location: [/location/i, /موقع/i, /المكان/i],
    shelf: [/shelf/i, /رف/i],
    notes: [/note/i, /ملاحظ/i],
    internal_barcode: [/barcode/i, /باركود/i],
    last_inventory_date: [/inventory.?date/i, /تاريخ.?الجرد/i],
    review_status: [/review/i, /مراجعة/i]
  };

  for (const [field, pats] of Object.entries(patterns)) {
    for (const h of headers) {
      if (pats.some(p => p.test(h))) { map[field] = h; break; }
    }
    if (!map[field]) map[field] = field; // fallback to exact match
  }
  return map;
}

function analyzeColumns(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = new Uint8Array(e.target.result);
        const wb = XLSX.read(data, { type: 'array' });
        const sheet = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(sheet);
        if (!rows.length) {
          debugLog('IMPORT', 'Column analysis: file is empty');
          reject(new Error('الملف فارغ'));
          return;
        }
        const headers = Object.keys(rows[0]);
        const sample = rows.slice(0, 3);
        const autoMap = autoDetectColumns(headers);
        debugLog('IMPORT', `Column analysis complete: ${headers.length} columns, ${rows.length} rows`);
        resolve({ headers, sample, autoMap, totalRows: rows.length });
      } catch(err) {
        debugLog('ERROR', 'Column analysis error', err.message);
        reject(err);
      }
    };
    reader.onerror = () => {
      debugLog('ERROR', 'Column analysis file read error', reader.error);
      reject(reader.error);
    };
    reader.readAsArrayBuffer(file);
  });
}

// ============ EXPORT ============
async function exportData(format) {
  const books = await dbAll();
  if (!books.length) {
    showToast('لا توجد بيانات');
    debugLog('IMPORT', 'Export cancelled: no data');
    return;
  }
  const clean = books.map(b => { const c = {...b}; delete c._score; return c; });
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(clean);
  XLSX.utils.book_append_sheet(wb, ws, 'Inventory');
  const dt = new Date().toISOString().split('T')[0];
  if (format === 'csv') {
    downloadBlob(new Blob([XLSX.utils.sheet_to_csv(ws)], {type:'text/csv'}), `inventory_${dt}.csv`);
  } else {
    downloadBlob(new Blob([XLSX.write(wb, {type:'array',bookType:'xlsx'})], {type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}), `inventory_${dt}.xlsx`);
  }
  debugLog('IMPORT', `Exported ${books.length} books as ${format}`);
}

function downloadBlob(blob, fn) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = fn;
  document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(a.href);
  showToast(`تم تصدير ${fn}`);
}

// ============ OCR ============
var ocrWorker = null;

// Detect SIMD support for WASM core selection
function detectSIMD() {
  try {
    return WebAssembly.validate(new Uint8Array([0,97,115,109,1,0,0,0,1,5,1,96,0,1,123,3,2,1,0,10,10,1,8,0,65,0,253,15,253,98,11]));
  } catch(e) { return false; }
}

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timeout after ${ms/1000}s`)), ms);
    promise.then(v => { clearTimeout(timer); resolve(v); })
           .catch(e => { clearTimeout(timer); reject(e); });
  });
}

async function initOCR(lang) {
  if (ocrWorker) { try { await ocrWorker.terminate(); } catch(e){} ocrWorker = null; }

  var hasSIMD = detectSIMD();
  var coreName = hasSIMD ? 'tesseract-core-simd-lstm.wasm.js' : 'tesseract-core-lstm.wasm.js';
  debugLog('OCR', `Initializing OCR worker lang=${lang}, SIMD=${hasSIMD}, core=${coreName}`);

  ocrWorker = await withTimeout(
    Tesseract.createWorker(lang || 'ara+eng', 1, {
      workerPath: '/tesseract/worker.min.js',
      corePath: '/tesseract/' + coreName,
      langPath: '/tesseract',
      logger: m => {
        var el = document.getElementById('ocrProgress');
        if (!el) return;
        if (m.status === 'recognizing text') el.textContent = 'تحليل النص... ' + Math.round(m.progress*100) + '%';
        else if (m.status === 'loading language traineddata') el.textContent = 'تحميل بيانات اللغة...';
        else if (m.status === 'initializing api') el.textContent = 'تهيئة محرك OCR...';
        else if (m.status === 'loading tesseract core') el.textContent = 'تحميل المحرك...';
        else if (m.status) el.textContent = m.status;
        debugLog('OCR', 'Progress: ' + m.status, { progress: m.progress });
      }
    }),
    60000, 'OCR init'
  );
  return ocrWorker;
}

// ============ IMAGE COMPRESSION ============
function compressImage(dataUrl, maxWidth, quality) {
  maxWidth = maxWidth || 1200;
  quality = quality || 0.75;
  return new Promise(function(resolve) {
    var img = new Image();
    img.onload = function() {
      var w = img.width;
      var h = img.height;
      if (w > maxWidth) {
        h = Math.round(h * maxWidth / w);
        w = maxWidth;
      }
      var canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      var ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, w, h);
      var compressed = canvas.toDataURL('image/jpeg', quality);
      debugLog('AI', 'Image compressed: ' + Math.round(dataUrl.length/1024) + 'KB -> ' + Math.round(compressed.length/1024) + 'KB (' + w + 'x' + h + ')');
      resolve(compressed);
    };
    img.onerror = function() { resolve(dataUrl); };
    img.src = dataUrl;
  });
}

// ============ OPENAI VISION AI ============
async function runAIVision(imgData) {
  if (!CONFIG.openaiKey) {
    debugLog('AI', 'No OpenAI key configured');
    return { success: false, error: 'no_key', fields: null };
  }
  if (!navigator.onLine) {
    debugLog('AI', 'Offline - cannot use AI Vision');
    return { success: false, error: 'offline', fields: null };
  }

  debugLog('AI', 'Starting OpenAI Vision analysis...');

  try {
    // Compress image for faster upload (1200px max, 75% quality)
    var base64 = await compressImage(imgData, 1200, 0.75);
    if (!base64.startsWith('data:')) {
      base64 = 'data:image/jpeg;base64,' + base64;
    }

    debugLog('AI', 'Compressed image size: ' + Math.round(base64.length/1024) + 'KB');

    var requestBody = {
      model: 'gpt-4o-mini',
      messages: [{
        role: 'system',
        content: 'أنت مساعد فهرسة مكتبات متخصص. تقرأ صور أغلفة الكتب وصفحات العنوان والحقوق بالعربية والإنجليزية. استخرج البيانات بدقة عالية. أجب فقط بـ JSON بدون أي نص إضافي.'
      }, {
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'حلل هذه الصورة لكتاب واستخرج البيانات التالية. أجب فقط بـ JSON:\n{"title":"عنوان الكتاب","author":"المؤلف","publisher":"الناشر/دار النشر","isbn":"رقم ISBN إن وُجد","language":"Arabic أو English","call_number":"رقم التصنيف إن وُجد","year":"سنة النشر إن وُجدت"}\nإذا لم تجد معلومة اتركها فارغة "".'
          },
          {
            type: 'image_url',
            image_url: { url: base64, detail: 'auto' }
          }
        ]
      }],
      max_tokens: 400,
      temperature: 0
    };

    debugLog('AI', 'Sending request to OpenAI (gpt-4o-mini)...');

    var res = await withTimeout(
      fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + CONFIG.openaiKey,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(requestBody)
      }),
      30000, 'AI Vision'
    );

    debugLog('AI', 'Response status: ' + res.status);

    if (!res.ok) {
      var errText = await res.text();
      debugLog('AI', 'API error: ' + res.status + ' - ' + errText);

      // If gpt-4o-mini fails, retry with gpt-4o
      if (res.status === 404 || res.status === 400) {
        debugLog('AI', 'Retrying with gpt-4o...');
        requestBody.model = 'gpt-4o';
        var res2 = await withTimeout(
          fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
              'Authorization': 'Bearer ' + CONFIG.openaiKey,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify(requestBody)
          }),
          30000, 'AI Vision retry'
        );
        if (!res2.ok) {
          var errText2 = await res2.text();
          return { success: false, error: 'api_' + res2.status, message: errText2, fields: null };
        }
        res = res2;
      } else {
        return { success: false, error: 'api_' + res.status, message: errText, fields: null };
      }
    }

    var data = await res.json();
    debugLog('AI', 'Response received', { choices: data.choices ? data.choices.length : 0, model: data.model });

    var text = (data.choices && data.choices[0] && data.choices[0].message) ? data.choices[0].message.content : '';
    debugLog('AI', 'Raw AI response: ' + text);

    // Clean response — remove markdown code blocks if present
    text = text.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();

    // Try to extract JSON from the response
    var jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      var parsed = JSON.parse(jsonMatch[0]);
      debugLog('AI', 'Parsed fields successfully', parsed);

      // Check if we actually got useful data
      var hasData = parsed.title || parsed.author || parsed.isbn;
      if (hasData) {
        return {
          success: true,
          method: 'ai_vision',
          fields: {
            title: parsed.title || '',
            author: parsed.author || '',
            publisher: parsed.publisher || '',
            callNum: parsed.call_number || parsed.dewey_number || '',
            isbn: parsed.isbn || '',
            language: parsed.language || '',
            year: parsed.year || ''
          }
        };
      } else {
        debugLog('AI', 'AI returned empty fields');
        return { success: false, error: 'empty_result', fields: null };
      }
    } else {
      debugLog('AI', 'Could not parse JSON from response');
      return { success: false, error: 'parse_error', rawText: text, fields: null };
    }
  } catch(e) {
    debugLog('AI', 'Exception: ' + e.message, e);
    return { success: false, error: 'exception', message: e.message, fields: null };
  }
}

// ============ LOCAL OCR ============
async function runLocalOCR(imgData, lang, mode) {
  debugLog('OCR', `Starting local OCR with lang=${lang}, mode=${mode}`);
  try {
    var w = await initOCR(lang);
    var r = await withTimeout(w.recognize(imgData), 45000, 'OCR recognize');
    var rawText = r.data.text;
    debugLog('OCR', `OCR raw text (${rawText.length} chars): ${rawText.substring(0, 200)}`);

    if (!rawText || rawText.trim().length < 3) {
      debugLog('OCR', 'OCR returned empty/minimal text');
      return { success: false, error: 'empty_result', rawText: rawText, fields: null };
    }

    const fields = extractFields(rawText, mode);
    debugLog('OCR', 'Extracted fields', fields);

    const hasData = fields.title || fields.isbn || fields.callNum;
    return {
      success: hasData,
      method: 'local_ocr',
      rawText: rawText,
      fields: fields,
      error: hasData ? null : 'weak_extraction'
    };
  } catch(e) {
    debugLog('OCR', `Exception: ${e.message}`, e);
    return { success: false, error: 'exception', message: e.message, rawText: '', fields: null };
  }
}

// ============ UNIFIED IMAGE ANALYSIS ============
async function analyzeImage(imgData, mode, onProgress) {
  const result = {
    method: null,        // 'ai_vision' | 'local_ocr' | null
    fields: null,        // { title, author, publisher, callNum, isbn, language }
    rawText: '',
    success: false,
    error: null,
    attempts: []         // log of what was tried
  };

  // Step 1: Try AI Vision if available
  if (CONFIG.openaiKey && navigator.onLine) {
    onProgress?.('ai_start', 'جاري تحليل الصورة بالذكاء الاصطناعي...');
    const aiResult = await runAIVision(imgData);
    result.attempts.push({ method: 'ai_vision', ...aiResult });

    if (aiResult.success) {
      result.method = 'ai_vision';
      result.fields = aiResult.fields;
      result.success = true;
      onProgress?.('ai_success', 'تم استخراج البيانات بالذكاء الاصطناعي');
      return result;
    } else {
      onProgress?.('ai_failed', `فشل AI: ${aiResult.error} — جاري المحاولة بـ OCR...`);
    }
  }

  // Step 2: Fallback to local OCR
  onProgress?.('ocr_start', 'جاري التعرف على النص محلياً...');
  const lang = mode === 'copyright' ? 'eng+ara' : 'ara+eng';
  const ocrResult = await runLocalOCR(imgData, lang, mode);
  result.attempts.push({ method: 'local_ocr', ...ocrResult });
  result.rawText = ocrResult.rawText || '';

  if (ocrResult.success) {
    result.method = 'local_ocr';
    result.fields = ocrResult.fields;
    result.success = true;
    onProgress?.('ocr_success', 'تم استخراج البيانات');
    return result;
  }

  // Step 3: Both failed
  result.error = 'all_failed';
  // Still provide whatever OCR got (partial fields)
  if (ocrResult.fields) {
    result.fields = ocrResult.fields;
  }
  onProgress?.('failed', 'فشل التحليل — يمكنك البحث يدوياً');
  debugLog('ERROR', 'All analysis methods failed', result.attempts);
  return result;
}

// ============ FIELD EXTRACTION ============
function extractFields(rawText, mode) {
  const lines = rawText.split('\n').map(l => l.trim()).filter(l => l.length > 2);
  const hasArabic = /[\u0600-\u06FF]/.test(rawText);
  let title='', author='', publisher='', callNum='', isbn='';
  const isbnMatch = rawText.match(/(?:ISBN[\s:\-]*)?(\d[\d\s\-]{9,16}[\dXx])/);
  if (isbnMatch) isbn = isbnMatch[1].replace(/[\s\-]/g, '');
  const callMatch = rawText.match(/(\d{3}(?:\.\d+)?[\s\/]*[A-Za-z]+)/);
  if (callMatch) callNum = callMatch[1].trim();
  const meaningful = lines.filter(l => { const a = l.replace(/[^a-zA-Z\u0600-\u06FF]/g,''); return a.length > l.length*0.25 && a.length > 2; });
  if (mode==='spine') { if(lines.length>0) callNum=callNum||lines[0]; if(meaningful.length>0) title=meaningful[0]; }
  else if (mode==='copyright') {
    for (const line of lines) {
      if (/(?:publisher|ناشر|دار|مكتبة|press|publishing|نشر)/i.test(line)) publisher=publisher||line;
      if (/(?:by|تأليف|المؤلف|author|مؤلف)/i.test(line)) author=author||line.replace(/(?:by|تأليف|المؤلف|author|مؤلف)\s*[:\-]?\s*/i,'').trim();
    }
    if(meaningful.length>0&&!title) title=meaningful[0];
  } else {
    if(meaningful.length>=1) title=meaningful[0];
    if(meaningful.length>=2) { const s=meaningful[1]; if(/(?:by|تأليف|المؤلف|مؤلف)/i.test(s)) author=s.replace(/(?:by|تأليف|المؤلف|مؤلف)\s*[:\-]?\s*/i,'').trim(); else author=s; }
    for(const l of meaningful) if(/(?:publisher|ناشر|دار|مكتبة|press|publishing|نشر)/i.test(l)) publisher=publisher||l;
  }
  return { title, author, publisher, callNum, isbn, language: hasArabic?'Arabic':'English' };
}

// ============ UI HELPERS ============
function showToast(msg, duration) {
  // Dynamic toast element (v5 style - no static #toast needed)
  const toast = document.createElement('div');
  toast.style.cssText = 'position:fixed;bottom:calc(56px + env(safe-area-inset-bottom,20px) + 12px);left:16px;right:16px;background:#0f172a;color:#fff;padding:12px 16px;border-radius:12px;font-size:14px;font-weight:600;z-index:1000;text-align:center;direction:rtl;max-width:calc(100% - 32px);animation:slideUp .3s ease;';
  toast.textContent = msg;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), duration || 3000);
}

function badgeClass(s) {
  const map = { 'Found': 'badge-online', 'Not Found': 'badge-sync-error', 'Not Checked': 'badge-syncing' };
  return map[s] || 'badge-offline';
}

function statusAr(s) {
  const map = { 'Found': 'موجود', 'Not Found': 'مفقود', 'Not Checked': 'غير مفحوص', 'Pending': 'قيد الانتظار', 'Confirmed': 'مؤكد' };
  return map[s] || s;
}

function esc(s) {
  if(!s) return '';
  const d=document.createElement('div');
  d.textContent=s;
  return d.innerHTML;
}

// ============ CATEGORY CLASSIFICATION ============
var BOOK_CATEGORIES = [
  'أدب', 'علوم', 'فقه إسلامي', 'تاريخ', 'جغرافيا', 'لغة عربية',
  'تربية', 'فلسفة وعلم نفس', 'علوم عسكرية', 'طيران', 'هندسة',
  'علوم سياسية', 'اقتصاد', 'دين إسلامي', 'اجتماع', 'قانون',
  'فنون', 'تراجم وسير', 'مراجع عامة', 'أخرى'
];

function classifyByDewey(dewey, subject) {
  if (!dewey && !subject) return 'أخرى';
  var d = parseFloat(dewey) || 0;
  var subj = (subject || '').toLowerCase();

  // Dewey-based classification
  if (d >= 0 && d < 100) return 'مراجع عامة';
  if (d >= 100 && d < 200) return 'فلسفة وعلم نفس';
  if (d >= 200 && d < 300) {
    if (subj.includes('فقه') || subj.includes('احكام')) return 'فقه إسلامي';
    return 'دين إسلامي';
  }
  if (d >= 300 && d < 320) return 'اجتماع';
  if (d >= 320 && d < 330) return 'علوم سياسية';
  if (d >= 330 && d < 340) return 'اقتصاد';
  if (d >= 340 && d < 350) return 'قانون';
  if (d >= 350 && d < 360) {
    if (subj.includes('عسكري') || subj.includes('حرب') || subj.includes('جيش')) return 'علوم عسكرية';
    return 'علوم عسكرية';
  }
  if (d >= 370 && d < 380) return 'تربية';
  if (d >= 380 && d < 400) return 'اجتماع';
  if (d >= 400 && d < 500) return 'لغة عربية';
  if (d >= 500 && d < 600) return 'علوم';
  if (d >= 600 && d < 620) return 'هندسة';
  if (d >= 620 && d < 630) {
    if (subj.includes('طيران') || subj.includes('طائر')) return 'طيران';
    return 'هندسة';
  }
  if (d >= 630 && d < 700) return 'هندسة';
  if (d >= 700 && d < 800) return 'فنون';
  if (d >= 800 && d < 900) return 'أدب';
  if (d >= 910 && d < 920) return 'جغرافيا';
  if (d >= 920 && d < 930) return 'تراجم وسير';
  if (d >= 900 && d < 1000) return 'تاريخ';

  // Subject-based fallback
  if (subj.includes('عسكري') || subj.includes('حرب')) return 'علوم عسكرية';
  if (subj.includes('طيران')) return 'طيران';
  if (subj.includes('تراجم') || subj.includes('سير')) return 'تراجم وسير';
  if (subj.includes('أدب') || subj.includes('شعر') || subj.includes('رواي')) return 'أدب';
  if (subj.includes('فقه')) return 'فقه إسلامي';
  if (subj.includes('إسلام') || subj.includes('قرآن') || subj.includes('حديث')) return 'دين إسلامي';

  return 'أخرى';
}

function categoryAr(cat) {
  return cat || 'أخرى';
}

// ============ ACTIVITY LOG ============
var ACTIVITY_LOG_KEY = 'lib_activity_log';
var LOGIN_LOG_KEY = 'lib_login_log';

function logActivity(action, details) {
  try {
    var log = JSON.parse(localStorage.getItem(ACTIVITY_LOG_KEY) || '[]');
    log.unshift({
      user: currentUser ? currentUser.name : 'غير معروف',
      action: action,
      details: details || '',
      timestamp: new Date().toISOString()
    });
    if (log.length > 500) log = log.slice(0, 500);
    localStorage.setItem(ACTIVITY_LOG_KEY, JSON.stringify(log));
  } catch(e) {}
}

function logLogin(username) {
  try {
    var log = JSON.parse(localStorage.getItem(LOGIN_LOG_KEY) || '[]');
    log.unshift({
      user: username,
      timestamp: new Date().toISOString()
    });
    if (log.length > 500) log = log.slice(0, 500);
    localStorage.setItem(LOGIN_LOG_KEY, JSON.stringify(log));
  } catch(e) {}
}

function getActivityLog() {
  try { return JSON.parse(localStorage.getItem(ACTIVITY_LOG_KEY) || '[]'); } catch(e) { return []; }
}

function getLoginLog() {
  try { return JSON.parse(localStorage.getItem(LOGIN_LOG_KEY) || '[]'); } catch(e) { return []; }
}

// ============ TEXT FILE IMPORT (cp1256 format) ============
function parseLibraryTextFile(text) {
  var blocks = text.split(/\-{10,}/);
  var books = [];
  for (var i = 0; i < blocks.length; i++) {
    var block = blocks[i].trim();
    if (!block || block.length < 20) continue;

    var lines = block.split('\n');
    var book = { title: '', author: '', publisher: '', publication_year: '', dewey_number: '', full_call_number: '', subject: '', category: '' };

    // First meaningful line often has call number
    var firstLine = '';
    for (var j = 0; j < lines.length; j++) {
      var l = lines[j].trim();
      if (l && !l.startsWith('مراجع')) { firstLine = l; break; }
      if (l.startsWith('مراجع')) {
        // Extract dewey from first non-empty line after 'مراجع'
        var parts = l.split(/\s+/);
        // Look for next line with dewey
      }
    }

    // Extract Dewey number (pattern like "230.92 ز ع ا")
    var deweyMatch = block.match(/(\d{3}(?:\.\d+)?)\s+[^\n]*\n/);
    if (deweyMatch) {
      book.dewey_number = deweyMatch[1];
      book.full_call_number = deweyMatch[0].trim();
    }

    // Extract fields
    var currentField = '';
    for (var j = 0; j < lines.length; j++) {
      var line = lines[j];
      if (/العنوان/.test(line)) {
        book.title = line.replace(/.*العنوان\s*/, '').trim();
        currentField = 'title';
      } else if (/المؤلف/.test(line)) {
        book.author = line.replace(/.*المؤلف\s*/, '').trim();
        currentField = 'author';
      } else if (/بيانات النشر/.test(line)) {
        var pubData = line.replace(/.*بيانات النشر\s*/, '').trim();
        book.publisher = pubData;
        var yearMatch = pubData.match(/(\d{4})/);
        if (yearMatch) book.publication_year = yearMatch[1];
        currentField = 'publisher';
      } else if (/الموضوع/.test(line)) {
        book.subject = line.replace(/.*الموضوع\s*/, '').trim();
        currentField = 'subject';
      } else if (currentField === 'subject' && line.trim() && !line.match(/^\s{0,5}\S/)) {
        // Continuation of subject
        book.subject += ' -- ' + line.trim();
      }
    }

    if (book.title) {
      book.category = classifyByDewey(book.dewey_number, book.subject);
      books.push(book);
    }
  }
  return books;
}

// Override doLogin to log logins
var _originalDoLogin = doLogin;
doLogin = async function(username, password) {
  var result = await _originalDoLogin(username, password);
  if (result.success) {
    logLogin(username);
    logActivity('تسجيل دخول', username);
  }
  return result;
};

// Override confirmBook to log activity
var _originalConfirmBook = confirmBook;
confirmBook = async function(id, confidence, method) {
  var result = await _originalConfirmBook(id, confidence, method);
  if (result && !result.alreadyInventoried) {
    logActivity('جرد كتاب', result.title || '');
  }
  return result;
};

// Override dbAdd to log activity
var _originalDbAdd = dbAdd;
dbAdd = async function(book) {
  var result = await _originalDbAdd(book);
  logActivity('إضافة كتاب', book.title || '');
  return result;
};
