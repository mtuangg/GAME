// =============================================================
// Shared cloud-sync helper for the dashboard.
// Each page calls initCloudSync({...}) once with its config:
//   appKey         — string row key in the public.app_state table
//   syncedKeys     — exact localStorage keys to mirror
//   syncedPrefixes — localStorage key prefixes to mirror (e.g. 'goals:')
//   onApplied      — optional callback after remote state has been applied
//
// Requires:
//   <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
//   <script src="sync.js" defer></script>
// =============================================================
(function () {
  'use strict';

  // Prefer Vercel env vars (served via /api/config → window.DASH_*),
  // otherwise fall back to these defaults.
  const SUPABASE_URL = (typeof window !== 'undefined' && window.DASH_SUPABASE_URL) || 'https://srajryooffirbroltjmg.supabase.co';
  const SUPABASE_KEY = (typeof window !== 'undefined' && window.DASH_SUPABASE_KEY) || 'sb_publishable_5142ZwTLF_DkSVRzciNuRA_bHwRAu4c';

  window.initCloudSync = function (config) {
    const appKey = config && config.appKey;
    const syncedKeys = (config && config.syncedKeys) || [];
    const syncedPrefixes = (config && config.syncedPrefixes) || [];
    const onApplied = config && config.onApplied;
    // Fires exactly once — after the initial pull from the cloud has
    // been applied (or immediately if cloud sync isn't configured).
    // Pages that WRITE to localStorage on boot (not just read/render)
    // must wait for this before doing so — otherwise a page's own
    // not-yet-synced local state can race the pull and get pushed to
    // the cloud first, silently overwriting what another device saved.
    const onReady = config && config.onReady;
    function callReady() { if (typeof onReady === 'function') { try { onReady(); } catch (e) {} } }
    if (!appKey) { callReady(); return; }
    if (!window.supabase) { callReady(); return; }
    if (!SUPABASE_URL || !SUPABASE_KEY) { callReady(); return; }
    if (SUPABASE_URL.indexOf('PASTE-') === 0 || SUPABASE_KEY.indexOf('PASTE-') === 0) { callReady(); return; }

    let supa = null;
    let pushTimer = null;
    let suppressSync = false;
    let lastSyncedJson = null;
    // The most recent full row we know the cloud holds — including keys
    // owned by OTHER pages/configs that happen to share this appKey (e.g.
    // health.html and po-water.html both sync under appKey 'health' but
    // with different key lists). Pushes merge onto this instead of
    // replacing the whole column, so this page can never wipe out another
    // page's slice of the same row just because it doesn't have that data
    // locally.
    let lastKnownRemote = null;
    // True once the initial cloud pull has resolved. Pushes are held back
    // until then — otherwise a write that races ahead of the pull (e.g. a
    // page that writes on boot without waiting for onReady) could push a
    // partial/stale state before we even know what the cloud has.
    let pullDone = false;

    function matches(k) {
      if (!k) return false;
      if (syncedKeys.indexOf(k) !== -1) return true;
      for (let i = 0; i < syncedPrefixes.length; i++) {
        if (k.indexOf(syncedPrefixes[i]) === 0) return true;
      }
      return false;
    }
    function listAllKeys() {
      const out = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (matches(k)) out.push(k);
      }
      return out;
    }
    function collect() {
      const out = {};
      for (const k of listAllKeys()) {
        const v = localStorage.getItem(k);
        if (v == null) continue;
        try { out[k] = JSON.parse(v); } catch (e) { out[k] = v; }
      }
      return out;
    }

    const origSet = localStorage.setItem.bind(localStorage);
    const origRemove = localStorage.removeItem.bind(localStorage);
    localStorage.setItem = function (k, v) {
      origSet(k, v);
      try { if (!suppressSync && matches(k)) schedulePush(); } catch (e) {}
    };
    localStorage.removeItem = function (k) {
      origRemove(k);
      try { if (!suppressSync && matches(k)) schedulePush(); } catch (e) {}
    };

    function applyRemote(remote) {
      if (!remote || typeof remote !== 'object') return false;
      suppressSync = true;
      let changed = false;
      try {
        for (const k of Object.keys(remote)) {
          if (!matches(k)) continue;
          const incoming = JSON.stringify(remote[k]);
          const local = localStorage.getItem(k);
          if (local !== incoming) {
            try { origSet(k, incoming); changed = true; } catch (e) {}
          }
        }
        for (const k of listAllKeys()) {
          if (!(k in remote)) {
            try { origRemove(k); changed = true; } catch (e) {}
          }
        }
      } finally { suppressSync = false; }
      if (changed && typeof onApplied === 'function') {
        try { onApplied(); } catch (e) {}
      }
      return changed;
    }

    // Overlays this page's current local state onto the last-known remote
    // row, instead of replacing the row outright. Keys this page doesn't
    // manage (matches(k) === false) pass through untouched; keys it DOES
    // manage but has since removed locally are deleted from the merged
    // payload too, so local deletions still propagate.
    function mergeForPush(state) {
      const merged = Object.assign({}, lastKnownRemote || {});
      for (const k of Object.keys(state)) merged[k] = state[k];
      for (const k of Object.keys(merged)) {
        if (matches(k) && !(k in state)) delete merged[k];
      }
      return merged;
    }

    async function pushNow() {
      if (!supa || !pullDone) return;
      const state = collect();
      const json = JSON.stringify(state);
      if (json === lastSyncedJson) return;
      const merged = mergeForPush(state);
      try {
        const { error } = await supa.from('app_state').upsert(
          { key: appKey, data: merged, updated_at: new Date().toISOString() },
          { onConflict: 'key' }
        );
        if (!error) { lastSyncedJson = json; lastKnownRemote = merged; }
      } catch (e) {}
    }
    function schedulePush() {
      clearTimeout(pushTimer);
      pushTimer = setTimeout(pushNow, 250);
    }
    function flushOnUnload() {
      if (!pullDone) return; // never had a stable base to merge onto — skip rather than risk a partial overwrite
      const state = collect();
      const json = JSON.stringify(state);
      if (json === lastSyncedJson) return;
      const merged = mergeForPush(state);
      try {
        fetch(SUPABASE_URL + '/rest/v1/app_state?on_conflict=key', {
          method: 'POST',
          headers: {
            'apikey': SUPABASE_KEY,
            'Authorization': 'Bearer ' + SUPABASE_KEY,
            'Content-Type': 'application/json',
            'Prefer': 'resolution=merge-duplicates',
          },
          body: JSON.stringify({ key: appKey, data: merged, updated_at: new Date().toISOString() }),
          keepalive: true,
        }).catch(() => {});
        lastSyncedJson = json;
        lastKnownRemote = merged;
      } catch (e) {}
    }

    (async function init() {
      supa = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
      try {
        const { data, error } = await supa
          .from('app_state').select('data').eq('key', appKey).maybeSingle();
        if (!error && data && data.data && Object.keys(data.data).length > 0) {
          lastSyncedJson = JSON.stringify(data.data);
          lastKnownRemote = data.data;
          applyRemote(data.data);
        } else {
          lastKnownRemote = {};
        }
      } catch (e) { lastKnownRemote = lastKnownRemote || {}; }
      pullDone = true;
      callReady();
      // Flush anything that changed locally while the pull was in flight
      // (or the initial local state, if the cloud row was empty). No-ops
      // cheaply via the lastSyncedJson check if nothing actually changed.
      schedulePush();
      supa.channel('app_state_' + appKey)
        .on('postgres_changes', {
          event: '*',
          schema: 'public',
          table: 'app_state',
          filter: 'key=eq.' + appKey,
        }, (payload) => {
          if (!payload.new || !payload.new.data) return;
          const incoming = JSON.stringify(payload.new.data);
          if (incoming === lastSyncedJson) return;
          lastSyncedJson = incoming;
          lastKnownRemote = payload.new.data;
          applyRemote(payload.new.data);
        })
        .subscribe();
    })();

    window.addEventListener('beforeunload', flushOnUnload);
    window.addEventListener('pagehide', flushOnUnload);
    window.addEventListener('storage', (e) => {
      if (e.key && matches(e.key)) schedulePush();
    });
  };
})();
