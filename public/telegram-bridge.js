/* Telegram Web Apps bootstrap + authenticated per-user cloud persistence. */
(() => {
  const tg = window.Telegram?.WebApp;
  const API = '/api';
  const PREFIX = 'brainrotdep-';
  let bearer = null;
  let revision = 0;
  let ready = false;
  let timer = null;
  let saving = false;
  let dirty = false;

  function notify(message) {
    if (typeof window.toast === 'function') window.toast(message);
    else console.info('[BrainrotLuck]', message);
  }
  function readJSON(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key) || ''); } catch { return fallback; }
  }
  function collectState() {
    const legacy = {};
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith(PREFIX) && key !== `${PREFIX}tokens` && key !== `${PREFIX}collection` && !key.startsWith(`${PREFIX}stat-`)) legacy[key] = localStorage.getItem(key);
    }
    const stats = {};
    for (const key of ['cases', 'characters', 'tokens', 'sales', 'upgrades', 'earned']) {
      stats[key] = Number(localStorage.getItem(`${PREFIX}stat-${key}`) || 0);
    }
    return {
      tokens: Number(document.getElementById('tokens')?.textContent || localStorage.getItem(`${PREFIX}tokens`) || 0),
      collection: readJSON(`${PREFIX}collection`, []),
      stats,
      timers: {
        freeLast: Number(localStorage.getItem(`${PREFIX}free-last`) || 0),
        daily: readJSON(`${PREFIX}daily-v2`, {})
      },
      profile: { legacy }
    };
  }
  async function api(path, options = {}) {
    const response = await fetch(`${API}${path}`, {
      ...options,
      headers: { 'Content-Type': 'application/json', ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}), ...(options.headers || {}) }
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
    return body;
  }
  function applyState(state) {
    if (!state) return;
    const legacy = state.profile?.legacy || {};
    for (const [key, value] of Object.entries(legacy)) {
      if (key.startsWith(PREFIX) && typeof value === 'string') localStorage.setItem(key, value);
    }
    if (Number.isFinite(Number(state.tokens))) {
      localStorage.setItem(`${PREFIX}tokens`, String(state.tokens));
      const balance = document.getElementById('tokens');
      if (balance) balance.textContent = String(state.tokens);
    }
    if (Array.isArray(state.collection)) localStorage.setItem(`${PREFIX}collection`, JSON.stringify(state.collection));
    if (state.timers?.freeLast) localStorage.setItem(`${PREFIX}free-last`, String(state.timers.freeLast));
    if (state.timers?.daily) localStorage.setItem(`${PREFIX}daily-v2`, JSON.stringify(state.timers.daily));
    if (state.stats && typeof state.stats === 'object') {
      for (const [key, value] of Object.entries(state.stats)) {
        if (['cases', 'characters', 'tokens', 'sales', 'upgrades', 'earned'].includes(key)) localStorage.setItem(`${PREFIX}stat-${key}`, String(Number(value) || 0));
      }
    }
  }
  async function saveNow() {
    if (!ready || !bearer || saving || !dirty) return;
    saving = true;
    dirty = false;
    try {
      const result = await api('/state', { method: 'PUT', body: JSON.stringify({ state: collectState(), revision }) });
      revision = result.revision;
    } catch (error) {
      dirty = true;
      if (error.message === 'revision_conflict') {
        try {
          const latest = await api('/state');
          revision = latest.revision;
          // Preserve the active tab's newest local actions and retry against the latest revision.
          const result = await api('/state', { method: 'PUT', body: JSON.stringify({ state: collectState(), revision }) });
          revision = result.revision;
          dirty = false;
        } catch (retryError) { console.warn('BrainrotLuck cloud save conflict:', retryError); }
      } else console.warn('BrainrotLuck cloud save failed:', error);
    } finally {
      saving = false;
      if (dirty) scheduleSave(1200);
    }
  }
  function scheduleSave(delay = 650) {
    dirty = true;
    if (timer) clearTimeout(timer);
    timer = setTimeout(saveNow, delay);
  }
  function installStorageObserver() {
    const original = Storage.prototype.setItem;
    const originalRemove = Storage.prototype.removeItem;
    Storage.prototype.setItem = function(key, value) {
      original.call(this, key, value);
      if (this === localStorage && typeof key === 'string' && key.startsWith(PREFIX) && ready) scheduleSave();
    };
    Storage.prototype.removeItem = function(key) {
      originalRemove.call(this, key);
      if (this === localStorage && typeof key === 'string' && key.startsWith(PREFIX) && ready) scheduleSave();
    };
    window.addEventListener('beforeunload', () => { if (dirty) saveNow(); });
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') saveNow(); });
  }
  async function boot() {
    installStorageObserver();
    if (!tg) {
      console.info('BrainrotLuck is running outside Telegram; local preview mode is active.');
      return;
    }
    tg.ready();
    tg.expand();
    tg.setHeaderColor?.('#080914');
    tg.setBackgroundColor?.('#080914');
    document.documentElement.style.setProperty('--tg-viewport-height', `${tg.viewportHeight || window.innerHeight}px`);
    window.addEventListener('resize', () => document.documentElement.style.setProperty('--tg-viewport-height', `${tg.viewportHeight || window.innerHeight}px`));
    try {
      const auth = await api('/auth/telegram', { method: 'POST', body: JSON.stringify({ initData: tg.initData }) });
      bearer = auth.token;
      revision = auth.revision;
      applyState(auth.state);
      ready = true;
      // Refresh UI after server state has been restored.
      if (typeof window.renderCollection === 'function') window.renderCollection();
      if (typeof window.updateFreeCaseCooldown === 'function') window.updateFreeCaseCooldown();
      window.brainrotTelegramPlayer = auth.player;
      console.info('BrainrotLuck Telegram account authenticated:', auth.player.id);
    } catch (error) {
      console.error('Telegram authentication failed:', error);
      const warning = document.createElement('div');
      warning.textContent = 'Не удалось подтвердить аккаунт Telegram. Перезапусти приложение через бота.';
      warning.style.cssText = 'position:fixed;z-index:20000;top:8px;left:8px;right:8px;padding:12px;background:#7f1d1d;color:white;border-radius:12px;text-align:center;font:700 13px system-ui';
      document.body.appendChild(warning);
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();
