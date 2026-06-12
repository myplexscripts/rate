const PLEX_PRODUCT = 'Rate It';
const STORE_TOKEN = 'rateit_token';
const STORE_URL   = 'rateit_url';
const STORE_CLIENT= 'rateit_clientId';

function lsGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch {} }
function lsDel(k) { try { localStorage.removeItem(k); } catch {} }

function getClientId() {
  let id = lsGet(STORE_CLIENT);
  if (!id) {
    id = (crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    }));
    lsSet(STORE_CLIENT, id);
  }
  return id;
}
const clientId = getClientId();

const cfg = { url: lsGet(STORE_URL) || '', token: lsGet(STORE_TOKEN) || '' };

let queue = [];
let hist  = [];
let allItems = [];
let chronological = [];
let shuffled = false;
let typeFilter = 'all';
let rating = 0;
let ratingTimer = null;
let busy = false;
let ratedCount = 0;
let lastCelebrated = 0;
let starsGiven = 0;
let displayedStars = 0;
let sessionRatings = [];

const SNOOZE_KEY = 'rateit_snooze';
const SNOOZE_MS = 7 * 24 * 60 * 60 * 1000;
let snoozeMap = {};
(function loadSnooze() {
  try { snoozeMap = JSON.parse(lsGet(SNOOZE_KEY)) || {}; } catch { snoozeMap = {}; }
  const now = Date.now();
  let dirty = false;
  for (const k in snoozeMap) {
    if (!snoozeMap[k] || now - snoozeMap[k] > SNOOZE_MS) { delete snoozeMap[k]; dirty = true; }
  }
  if (dirty) saveSnooze();
})();
function saveSnooze() { lsSet(SNOOZE_KEY, JSON.stringify(snoozeMap)); }
function unsnoozeAll() {
  snoozeMap = {};
  saveSnooze();
  loadItems(true);
}

const SORT_KEY = 'rateit_sortMode';
const SORT_MODES = ['recent', 'oldest', 'added'];
const SORT_LABELS = {
  recent: 'Newest watches first',
  oldest: 'Oldest watches first',
  added:  'Recently added first'
};
let sortMode = SORT_MODES.includes(lsGet(SORT_KEY)) ? lsGet(SORT_KEY) : 'recent';
function sortItems(arr) {
  const a = arr.slice();
  if (sortMode === 'oldest')     a.sort((x, y) => (x.lastViewedAt || 0) - (y.lastViewedAt || 0));
  else if (sortMode === 'added') a.sort((x, y) => (y.addedAt || 0) - (x.addedAt || 0));
  else                           a.sort((x, y) => (y.lastViewedAt || 0) - (x.lastViewedAt || 0));
  return a;
}
function updateSortButton() {
  const btn = document.getElementById('sortBtn');
  btn.title = 'Queue order: ' + SORT_LABELS[sortMode];
  btn.setAttribute('aria-label', 'Queue order: ' + SORT_LABELS[sortMode] + '. Activate to change');
}
function cycleSortMode() {
  if (busy || !queue.length) return;
  sortMode = SORT_MODES[(SORT_MODES.indexOf(sortMode) + 1) % SORT_MODES.length];
  lsSet(SORT_KEY, sortMode);
  updateSortButton();
  clearTimeout(ratingTimer);
  hist = [];
  rebuildQueueFromFilter();
  rebuild();
  toast(SORT_LABELS[sortMode]);
}

function popNum(el) {
  el.classList.remove('pop');
  void el.offsetWidth;
  el.classList.add('pop');
}

function updateRatedCounter(animate) {
  const el = document.getElementById('ratedCounterNum');
  el.textContent = ratedCount;
  if (animate) popNum(el);
}

const fmtStars = n => (n % 1 ? n.toFixed(1) : String(n));

function updateStarCounter(animate) {
  const el = document.getElementById('starCounterNum');
  el.textContent = fmtStars(displayedStars);
  if (animate) popNum(el);
}

const FLY_MS = 650;
function flyStars(r) {
  const counterIcon = document.querySelector('#starCounter .icon');
  const target = counterIcon.getBoundingClientRect();
  const lit = [...document.querySelectorAll('#starRow .star.lit')];
  const steps = [];
  for (let i = 0; i < Math.floor(r); i++) steps.push(1);
  if (r % 1) steps.push(0.5);

  if (!lit.length || !target.width || !document.getElementById('counters').classList.contains('on')
      || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    displayedStars = starsGiven;
    updateStarCounter(true);
    return;
  }

  const tx = target.left + target.width / 2;
  const ty = target.top + target.height / 2;
  steps.forEach((inc, i) => {
    const src = lit[Math.max(0, lit.length - steps.length + i)].getBoundingClientRect();
    const sx = src.left + src.width / 2;
    const sy = src.top + src.height / 2;
    const outer = document.createElement('div');
    outer.className = 'flyStar';
    outer.style.left = sx + 'px';
    outer.style.top = sy + 'px';
    const delay = i * 90;
    outer.style.transitionDelay = delay + 'ms';
    outer.innerHTML = `<svg class="icon" aria-hidden="true" style="transition-delay:${delay}ms"><use href="#icon-star-${inc === 1 ? 'fill' : 'half'}"/></svg>`;
    document.body.appendChild(outer);
    const inner = outer.firstChild;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      outer.style.transform = `translate3d(${tx - sx}px,0,0)`;
      inner.style.transform = `translateY(${ty - sy}px) scale(0.45)`;
      inner.style.opacity = '0.85';
    }));
    setTimeout(() => {
      outer.remove();
      displayedStars = Math.min(starsGiven, displayedStars + inc);
      if (i === steps.length - 1) displayedStars = starsGiven;
      updateStarCounter(true);
      buzz(6);
    }, delay + FLY_MS);
  });
}

function flyStarsBack(delta) {
  const counterIcon = document.querySelector('#starCounter .icon');
  const from = counterIcon.getBoundingClientRect();
  const rowRect = document.getElementById('starRow').getBoundingClientRect();
  displayedStars = starsGiven;
  updateStarCounter(true);

  if (!from.width || !rowRect.width || !document.getElementById('counters').classList.contains('on')
      || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    return;
  }
  const steps = [];
  for (let i = 0; i < Math.floor(delta); i++) steps.push(1);
  if (delta % 1) steps.push(0.5);

  const sx = from.left + from.width / 2;
  const sy = from.top + from.height / 2;
  const tx = rowRect.left + rowRect.width / 2;
  const ty = rowRect.top + rowRect.height / 2;
  steps.forEach((inc, i) => {
    const outer = document.createElement('div');
    outer.className = 'flyStar';
    outer.style.left = sx + 'px';
    outer.style.top = sy + 'px';
    const delay = i * 90;
    outer.style.transitionDelay = delay + 'ms';
    outer.innerHTML = `<svg class="icon" aria-hidden="true" style="transform:scale(0.45);transition-delay:${delay}ms"><use href="#icon-star-${inc === 1 ? 'fill' : 'half'}"/></svg>`;
    document.body.appendChild(outer);
    const inner = outer.firstChild;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      outer.style.transform = `translate3d(${tx - sx}px,0,0)`;
      inner.style.transform = `translateY(${ty - sy}px) scale(1)`;
      inner.style.opacity = '0';
    }));
    setTimeout(() => outer.remove(), delay + FLY_MS + 50);
  });
  buzz(6);
}

let counterTipTimer = null;
function showCounterTip(anchor, text) {
  let tip = document.getElementById('counterTip');
  if (!tip) {
    tip = document.createElement('div');
    tip.id = 'counterTip';
    tip.className = 'counterTip';
    tip.setAttribute('role', 'tooltip');
    document.body.appendChild(tip);
  }
  clearTimeout(counterTipTimer);
  tip.textContent = text;
  tip.classList.remove('on');

  const r = anchor.getBoundingClientRect();
  const onLeft = r.left < window.innerWidth / 2;
  tip.style.top = (r.bottom + 8) + 'px';
  if (onLeft) {
    tip.style.left = r.left + 'px';
    tip.style.right = 'auto';
  } else {
    tip.style.right = (window.innerWidth - r.right) + 'px';
    tip.style.left = 'auto';
  }

  requestAnimationFrame(() => tip.classList.add('on'));
  counterTipTimer = setTimeout(() => tip.classList.remove('on'), 1800);
}

function ratingTip(el, ev) {
  if (ev) ev.stopPropagation();
  showCounterTip(el, el.dataset.tip);
}

function buzz(pattern) { try { if (navigator.vibrate) navigator.vibrate(pattern); } catch {} }

const escHtml = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');

const H = () => ({ 'X-Plex-Token': cfg.token, 'Accept': 'application/json' });
const plexHeaders = () => ({
  'Accept': 'application/json',
  'X-Plex-Product': PLEX_PRODUCT,
  'X-Plex-Client-Identifier': clientId
});
const IMG_DPR = Math.min(window.devicePixelRatio || 1, 2);
function imgUrl(path, cssW) {
  if (!path) return '';
  if (/^https?:\/\//.test(path)) return path;
  const sep = path.includes('?') ? '&' : '?';
  const w = Math.min(1600, Math.round(cssW * IMG_DPR));
  return `${cfg.url}${path}${sep}X-Plex-Token=${cfg.token}&width=${w}`;
}
const posterUrl = it => {
  const k = it && (it.thumb || it.art);
  if (!k) return '';
  return imgUrl(k, isMeteredConnection() ? 220 : 320);
};

async function plexGet(path) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const r = await fetch(cfg.url + path, { headers: H(), signal: ctrl.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('Request timed out');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

function signOut() {
  lsDel(STORE_TOKEN);
  lsDel(STORE_URL);
  cfg.token = '';
  cfg.url = '';
  hideStage();
  setState('auth');
}

async function signIn() {
  const btn = document.getElementById('btnSignIn');
  btn.disabled = true;
  btn.textContent = 'Waiting for Plex…';
  let authWin = null;
  try { authWin = window.open('about:blank', '_blank'); } catch {}
  try {
    const pinResp = await fetch('https://plex.tv/api/v2/pins?strong=true', {
      method: 'POST',
      headers: plexHeaders()
    });
    if (!pinResp.ok) throw new Error('Could not start sign-in');
    const pin = await pinResp.json();

    const authParams = new URLSearchParams({
      clientID: clientId,
      code: pin.code,
      'context[device][product]': PLEX_PRODUCT
    });
    const authUrl = `https://app.plex.tv/auth#?${authParams.toString()}`;
    if (authWin && !authWin.closed) {
      authWin.location.href = authUrl;
    } else {
      window.open(authUrl, '_blank', 'noopener,noreferrer');
      if (!authWin) toast('If nothing opened, allow pop-ups and try again');
    }

    const token = await pollForToken(pin.id);
    if (!token) throw new Error('Sign-in timed out');

    cfg.token = token;
    lsSet(STORE_TOKEN, token);

    setState('load');
    document.getElementById('loadTitle').textContent = 'Connecting';
    document.getElementById('loadSub').textContent = 'Locating your Plex server…';

    const url = await discoverServer(token);
    if (!url) throw new Error('No Plex server found on your account');

    cfg.url = url;
    lsSet(STORE_URL, url);

    document.getElementById('loadTitle').textContent = 'Loading';
    document.getElementById('loadSub').textContent = 'Fetching your watched, unrated library from Plex.';
    loadItems();
  } catch (e) {
    if (authWin && !authWin.closed) { try { authWin.close(); } catch {} }
    btn.disabled = false;
    btn.textContent = 'Sign in with Plex';
    setState('auth');
    toast(e.message || 'Sign-in failed');
  }
}

function pollForToken(pinId) {
  return new Promise((resolve) => {
    const start = Date.now();
    const timeoutMs = 3 * 60 * 1000;
    let errors = 0;
    const tick = async () => {
      if (Date.now() - start > timeoutMs) return resolve(null);
      try {
        const r = await fetch(`https://plex.tv/api/v2/pins/${pinId}`, { headers: plexHeaders() });
        if (r.ok) {
          const data = await r.json();
          if (data.authToken) return resolve(data.authToken);
          errors = 0;
        } else {
          if (++errors >= 5) return resolve(null);
        }
      } catch {
        if (++errors >= 5) return resolve(null);
      }
      setTimeout(tick, 2000);
    };
    tick();
  });
}

function fetchWithTimeout(url, opts, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { ...opts, signal: ctrl.signal })
    .catch(e => { throw (e.name === 'AbortError' ? new Error('Request timed out') : e); })
    .finally(() => clearTimeout(timer));
}

async function discoverServer(token) {
  const r = await fetchWithTimeout('https://plex.tv/api/v2/resources?includeHttps=1&includeRelay=1', {
    headers: { ...plexHeaders(), 'X-Plex-Token': token }
  }, 15000);
  if (!r.ok) return null;
  const resources = await r.json();
  const servers = (resources || []).filter(d => (d.provides || '').split(',').includes('server'));

  for (const server of servers) {
    const conns = [...(server.connections || [])].sort((a, b) => {
      const score = c => (c.local ? 2 : 0) + (c.relay ? -1 : 0);
      return score(b) - score(a);
    });
    for (const conn of conns) {
      const base = conn.uri;
      try {
        const test = await fetchWithTimeout(`${base}/identity`, {
          headers: { 'X-Plex-Token': token, 'Accept': 'application/json' }
        }, 6000);
        if (test.ok) return base;
      } catch {}
    }
  }
  return null;
}

let loadingItems = false;
async function loadItems(preserveSession) {
  if (loadingItems) return;
  loadingItems = true;
  setState('load');
  hideStage();
  hist = [];
  if (!preserveSession) {
    ratedCount = 0;
    lastCelebrated = 0;
    starsGiven = 0;
    displayedStars = 0;
    sessionRatings = [];
    updateRatedCounter();
    updateStarCounter();
  }
  allItems = [];
  let anyShown = false;
  try {
    const sd = await plexGet('/library/sections');
    const libs = (sd.MediaContainer.Directory || []).filter(d => d.type === 'movie' || d.type === 'show');
    updateFilterButtons();
    const seen = new Set();
    let firstError = null;

    const addBatch = fresh => {
      if (!fresh.length) return;
      allItems.push(...fresh);
      if (!anyShown) {
        rebuildQueueFromFilter();
        if (queue.length) {
          anyShown = true;
          rebuild();
          showStage();
        }
      } else {
        applyMerge();
      }
    };

    await Promise.all(libs.map(async lib => {
      const t = lib.type === 'movie' ? 1 : 2;
      try {
        const d = await plexGet(`/library/sections/${lib.key}/all?type=${t}&sort=lastViewedAt%3Adesc&X-Plex-Container-Size=10000&X-Plex-Container-Start=0`);
        const fresh = [];
        for (const m of (d.MediaContainer.Metadata || [])) {
          if (m.userRating || seen.has(m.ratingKey) || snoozeMap[m.ratingKey]) continue;
          if (t === 1) {
            if (!(m.viewCount > 0)) continue;
          } else {
            const total = m.leafCount || 0;
            const watched = m.viewedLeafCount || 0;
            if (!total || watched / total <= 0.5) continue;
          }
          seen.add(m.ratingKey);
          fresh.push({ ...m, libType: lib.type });
        }
        addBatch(fresh);
      } catch (e) {
        console.warn('[load] library failed', lib.title, e);
        firstError = e;
      }
    }));

    if (!anyShown) {
      if (firstError && !allItems.length) throw firstError;
      rebuildQueueFromFilter();
      if (queue.length) {
        rebuild();
        showStage();
      } else {
        document.getElementById('doneSub').textContent = typeFilter === 'movie'
          ? 'No unrated watched movies.'
          : typeFilter === 'show'
            ? 'No unrated watched TV shows.'
            : 'No more unrated watched items.';
        setState('done');
      }
    }
  } catch(e) {
    setState('err');
    document.getElementById('errMsg').textContent = e.message || 'Connection failed.';
  } finally {
    loadingItems = false;
  }
}

function mergeQueue() {
  const current = queue[0] || null;
  const filtered = (typeFilter === 'all')
    ? allItems
    : allItems.filter(it => it.libType === typeFilter);
  chronological = sortItems(filtered);
  let rest = chronological.filter(it => it !== current);
  if (shuffled) rest = shuffleArray(rest);
  queue = current ? [current, ...rest] : rest.slice();
  updateProgress();
}

function rebuildUnderStack() {
  const stack = document.getElementById('posterStack');
  stack.querySelectorAll('.poster.p1, .poster.p2').forEach(el => el.remove());
  for (const i of [1, 2]) {
    const it = queue[i];
    if (!it) continue;
    const img = document.createElement('img');
    img.className = 'poster p' + i + ' skeleton';
    img.alt = it.title || '';
    stack.insertBefore(img, stack.firstChild);
    loadPoster(it, img, false);
  }
}

function applyMerge() {
  if (busy) { setTimeout(applyMerge, 460); return; }
  if (!queue.length && !allItems.length) return;
  mergeQueue();
  if (!queue.length) return;
  if (!document.getElementById('stage').classList.contains('on')) {
    rebuild();
    showStage();
    return;
  }
  rebuildUnderStack();
  preloadAhead();
  preloadInfo();
}

let resyncing = false;
async function resyncLibrary(silent) {
  if (resyncing || loadingItems || !cfg.token || !cfg.url) return;
  resyncing = true;
  try {
    const sd = await plexGet('/library/sections');
    const libs = (sd.MediaContainer.Directory || []).filter(d => d.type === 'movie' || d.type === 'show');
    const known = new Set();
    allItems.forEach(it => known.add(it.ratingKey));
    queue.forEach(it => known.add(it.ratingKey));
    hist.forEach(h => known.add(h.item.ratingKey));
    let added = 0;
    await Promise.all(libs.map(async lib => {
      const t = lib.type === 'movie' ? 1 : 2;
      const d = await plexGet(`/library/sections/${lib.key}/all?type=${t}&sort=lastViewedAt%3Adesc&X-Plex-Container-Size=10000&X-Plex-Container-Start=0`);
      const fresh = [];
      for (const m of (d.MediaContainer.Metadata || [])) {
        if (m.userRating || known.has(m.ratingKey) || snoozeMap[m.ratingKey]) continue;
        if (t === 1) {
          if (!(m.viewCount > 0)) continue;
        } else {
          const total = m.leafCount || 0;
          const watched = m.viewedLeafCount || 0;
          if (!total || watched / total <= 0.5) continue;
        }
        known.add(m.ratingKey);
        fresh.push({ ...m, libType: lib.type });
      }
      if (fresh.length) {
        added += fresh.length;
        allItems.push(...fresh);
      }
    }));
    if (added) {
      applyMerge();
      toast(added + ' new title' + (added !== 1 ? 's' : '') + ' found');
    } else if (!silent) {
      toast('Library is up to date');
    }
  } catch (e) {
    if (!silent) toast('Couldn’t reach Plex');
  } finally {
    resyncing = false;
  }
}

function rebuildQueueFromFilter() {
  chronological = sortItems((typeFilter === 'all')
    ? allItems
    : allItems.filter(it => it.libType === typeFilter));
  queue = chronological.slice();
  shuffled = false;
  const shuffleBtn = document.getElementById('btnShuffle');
  shuffleBtn.classList.remove('active');
  shuffleBtn.setAttribute('aria-pressed', 'false');
}

function updateFilterButtons() {
  const movieBtn = document.getElementById('filterMovie');
  const showBtn  = document.getElementById('filterShow');
  movieBtn.classList.toggle('active', typeFilter === 'movie');
  movieBtn.setAttribute('aria-pressed', String(typeFilter === 'movie'));
  showBtn.classList.toggle('active', typeFilter === 'show');
  showBtn.setAttribute('aria-pressed', String(typeFilter === 'show'));
}

function setTypeFilter(type) {
  if (busy) return;
  typeFilter = (typeFilter === type) ? 'all' : type;
  updateFilterButtons();
  clearTimeout(ratingTimer);
  hist = [];
  rebuildQueueFromFilter();
  if (!queue.length) {
    hideStage();
    document.getElementById('doneSub').textContent = typeFilter === 'movie'
      ? 'No unrated watched movies.'
      : typeFilter === 'show'
        ? 'No unrated watched TV shows.'
        : 'No more unrated watched items.';
    setState('done');
    updateProgress();
    return;
  }
  hideStage();
  rebuild();
  showStage();
  updateProgress();
  toast(typeFilter === 'all' ? 'Showing movies & TV' : (typeFilter === 'movie' ? 'Movies only' : 'TV shows only'));
}

function rebuild() {
  const item = queue[0];
  if (!item) return;
  const stack = document.getElementById('posterStack');
  stack.innerHTML = '';
  const top3 = queue.slice(0, 3);
  for (let i = top3.length - 1; i >= 0; i--) {
    const img = document.createElement('img');
    img.className = 'poster p' + i + ' skeleton';
    img.alt = top3[i].title || '';
    stack.appendChild(img);
    loadPoster(top3[i], img, i === 0);
  }
  setInfo(item);
  if (item.userRating) showRating(item.userRating / 2);
  else resetRating();
  document.getElementById('btnBack').disabled = hist.length === 0;
  updateProgress();
  preloadAhead();
}

function isDesktop() { return window.matchMedia('(min-width:960px)').matches; }

function setInfo(item) {
  document.getElementById('iTitleText').textContent = item.title || '';
  const dateEl = document.getElementById('iDate');
  if (item.lastViewedAt) {
    dateEl.textContent = 'Watched ' + fmtDate(item.lastViewedAt * 1000);
    dateEl.title = new Date(item.lastViewedAt * 1000).toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  } else {
    dateEl.textContent = '';
    dateEl.removeAttribute('title');
  }
  const sumEl = document.getElementById('iSummary');
  sumEl.textContent = item.summary || '';
  sumEl.setAttribute('tabindex', item.summary ? '0' : '-1');
  preloadInfo();
  if (isDesktop() && summaryItem !== item) {
    if (item._extra) {
      lsxTransition(() => openSummary(item));
    } else {
      if (summaryItem === null) {
        document.getElementById('summaryOverlay').classList.add('on');
        document.getElementById('lsxSkeleton').classList.add('on');
      } else {
        lsxTransition(() => {});
      }
      loadExtraInfo(item).then(() => {
        if (summaryItem !== item) openSummary(item);
      });
    }
  }
}

async function loadTrailer(item) {
  if (item._trailer !== undefined) return item._trailer;
  try {
    const d = await plexGet(`/library/metadata/${item.ratingKey}/extras`);
    const extras = (d.MediaContainer.Metadata || []);
    const clip = extras.find(e => e.subtype === 'trailer');
    const part = clip && clip.Media && clip.Media[0] && clip.Media[0].Part && clip.Media[0].Part[0];
    item._trailer = part ? { url: `${cfg.url}${part.key}${part.key.includes('?') ? '&' : '?'}X-Plex-Token=${cfg.token}` } : null;
  } catch (e) {
    console.warn('[trailer] lookup failed', e);
    item._trailer = null;
  }
  return item._trailer;
}

function playInlineTrailer() {
  const item = summaryItem || queue[0];
  if (!item || !item._trailer) return;
  const box = document.getElementById('summaryBox');
  const desktop = isDesktop();
  if (desktop && box.classList.contains('playing-trailer')) { stopInlineTrailer(); return; }
  const btn = document.getElementById('btnTrailer');
  const wrap = document.getElementById('trailerInline');
  const video = document.getElementById('trailerVideo');
  const errEl = document.getElementById('trailerError');
  const skel = document.getElementById('trailerSkeleton');
  if (desktop) {
    box.classList.add('playing-trailer');
  } else {
    btn.classList.add('hidden');
  }
  wrap.classList.remove('hidden');
  errEl.classList.add('hidden');
  video.classList.add('hidden');
  skel.classList.remove('hidden');
  video.onerror = () => { skel.classList.add('hidden'); video.classList.add('hidden'); errEl.classList.remove('hidden'); };
  video.onloadeddata = () => { skel.classList.add('hidden'); errEl.classList.add('hidden'); video.classList.remove('hidden'); };
  video.src = item._trailer.url;
  video.play().catch(err => console.warn('[trailer] play() rejected', err));
}
function stopInlineTrailer() {
  const box = document.getElementById('summaryBox');
  box.classList.remove('playing-trailer');
  const wrap = document.getElementById('trailerInline');
  const video = document.getElementById('trailerVideo');
  const skel = document.getElementById('trailerSkeleton');
  wrap.classList.add('hidden');
  skel.classList.add('hidden');
  video.pause();
  video.removeAttribute('src');
  video.onerror = null;
  video.onloadeddata = null;
  video.load();
}

const PLACEHOLDER_POSTER = 'data:image/svg+xml;utf8,' + encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 450">
    <rect width="300" height="450" fill="#262626"/>
    <rect x="95" y="155" width="110" height="80" rx="8" fill="none" stroke="#555" stroke-width="6"/>
    <circle cx="125" cy="180" r="9" fill="#555"/>
    <path d="M100 225 L140 190 L165 210 L200 175 L200 225 Z" fill="#555"/>
  </svg>`);
const PLACEHOLDER_CAST = 'data:image/svg+xml;utf8,' + encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
    <rect width="100" height="100" fill="#262626"/>
    <circle cx="50" cy="38" r="18" fill="#555"/>
    <path d="M20 92 Q50 62 80 92 Z" fill="#555"/>
  </svg>`);

const posterCache = new Map();
const posterPending = new Map();
const POSTER_CACHE_MAX = 30;
function posterCacheSet(key, val) {
  if (posterCache.size >= POSTER_CACHE_MAX) {
    const oldest = posterCache.keys().next().value;
    URL.revokeObjectURL(posterCache.get(oldest).url);
    posterCache.delete(oldest);
  }
  posterCache.set(key, val);
}

function loadPosterEntry(item) {
  const key = item.ratingKey;
  const cached = posterCache.get(key);
  if (cached) {
    posterCache.delete(key);
    posterCache.set(key, cached);
    return Promise.resolve(cached);
  }
  let pending = posterPending.get(key);
  if (!pending) {
    pending = (async () => {
      const resp = await fetch(posterUrl(item), { headers: H() });
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const url = URL.createObjectURL(await resp.blob());
      const entry = { url, glow: getUltraBlurColors(item), glowReady: null };
      if (!entry.glow) {
        entry.glowReady = (async () => {
          const probe = new Image();
          await new Promise((res, rej) => { probe.onload = res; probe.onerror = rej; probe.src = url; });
          entry.glow = await getEdgeColors(probe);
          return entry.glow;
        })().catch(() => null);
      }
      posterCacheSet(key, entry);
      return entry;
    })().catch(() => null).finally(() => posterPending.delete(key));
    posterPending.set(key, pending);
  }
  return pending;
}

async function loadPoster(item, img, isTop) {
  img.decoding = 'async';
  img.onerror = () => { img.onerror = null; img.classList.remove('skeleton'); img.src = PLACEHOLDER_POSTER; };
  const entry = await loadPosterEntry(item);
  if (!img.isConnected) return;
  if (!entry) {
    img.classList.remove('skeleton');
    img.src = PLACEHOLDER_POSTER;
    return;
  }
  img.onload = () => {
    img.classList.remove('skeleton');
    if (img.classList.contains('p0') && !img.style.transform) {
      img.classList.add('fade-in');
      setTimeout(() => img.classList.remove('fade-in'), 400);
    }
  };
  img.src = entry.url;
  const applyGlow = g => {
    if (!g || !img.isConnected) return;
    img._glow = g;
    if (isTop || img.classList.contains('p0')) setGlow(g);
  };
  if (entry.glow) applyGlow(entry.glow);
  else if (entry.glowReady) entry.glowReady.then(applyGlow);
}

function isMeteredConnection() {
  const c = navigator.connection || navigator.webkitConnection || navigator.mozConnection;
  if (!c) return false;
  if (c.saveData) return true;
  return /^(slow-2g|2g|3g)$/.test(c.effectiveType || '');
}

const warmedPosters = new Set();
function preloadAhead() {
  if (isMeteredConnection()) return;
  for (let i = 3; i <= 4; i++) {
    const item = queue[i];
    if (!item || posterCache.has(item.ratingKey)) continue;
    const href = posterUrl(item);
    if (!href || warmedPosters.has(href)) continue;
    warmedPosters.add(href);
    const im = new Image();
    im.src = href;
  }
}

function releaseItemBlobs(item) {
  if (!item) return;
  for (const k of ['_backdropBlobUrl', '_logoBlobUrl']) {
    if (item[k]) {
      try { URL.revokeObjectURL(item[k]); } catch {}
      delete item[k];
    }
  }
}

async function prefetchBlob(item, key, url) {
  if (item[key] || item[key + '_pending']) return;
  item[key + '_pending'] = true;
  try {
    const r = await fetch(url, { headers: H() });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    item[key] = URL.createObjectURL(await r.blob());
  } catch {  }
  delete item[key + '_pending'];
}

function preloadInfo() {
  const metered = isMeteredConnection();
  const upper = metered ? 0 : 5;
  for (let i = 0; i <= upper; i++) {
    const item = queue[i];
    if (!item) continue;
    loadExtraInfo(item).then(extra => {
      if (metered) return;
      if (extra.backdrop) prefetchBlob(item, '_backdropBlobUrl', extra.backdrop);
      if (extra.logo)     prefetchBlob(item, '_logoBlobUrl',     extra.logo);
      extra.cast.forEach(c => { if (c.photo) prefetchCastPhoto(c.photo); });
    }).catch(e => console.warn('[preload]', e));
    loadTrailer(item).catch(e => console.warn('[preload trailer]', e));
  }
}

function getEdgeColors(imgEl) {
  return new Promise(resolve => {
    const run = () => { try {
      const W = 100, H = 80;
      const canvas = document.createElement('canvas');
      canvas.width = W; canvas.height = H;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(imgEl, 0, 0, W, H);
      const data = ctx.getImageData(0, 0, W, H).data;
      const edge = Math.round(W * 0.3);

      const dominant = (xMin, xMax) => {
        let best = null, bestScore = -1;
        for (let y = 0; y < H; y++) {
          for (let x = xMin; x < xMax; x++) {
            const i = (y * W + x) * 4;
            const r = data[i], g = data[i+1], b = data[i+2];
            const max = Math.max(r,g,b), min = Math.min(r,g,b);
            const brightness = max / 255;
            const sat = max === 0 ? 0 : (max - min) / max;
            if (brightness < 0.12 || brightness > 0.95 || sat < 0.2) continue;
            const score = sat * (1 - Math.abs(brightness - 0.55));
            if (score > bestScore) { bestScore = score; best = [r, g, b]; }
          }
        }
        return best || [40, 40, 60];
      };

      const left = dominant(0, edge), right = dominant(W - edge, W);
      resolve({ tl: left, bl: left, tr: right, br: right });
    } catch {
      const c = [40, 40, 60];
      resolve({ tl: c, bl: c, tr: c, br: c });
    } };
    (typeof requestIdleCallback === 'function') ? requestIdleCallback(run) : setTimeout(run, 0);
  });
}

function sampleCornerBrightness(imgEl) {
  return new Promise(resolve => {
    try {
      const W = 60, H = 34;
      const canvas = document.createElement('canvas');
      canvas.width = W; canvas.height = H;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(imgEl, 0, 0, W, H);
      const cw = Math.round(W * 0.30), ch = Math.round(H * 0.32);
      const data = ctx.getImageData(W - cw, 0, cw, ch).data;
      let total = 0, n = 0;
      for (let i = 0; i < data.length; i += 4) {
        total += (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000;
        n++;
      }
      resolve(n ? (total / n) > 150 : false);
    } catch { resolve(false); }
  });
}

function logoNeedsInvert(imgEl) {
  try {
    const W = 80;
    const ratio = (imgEl.naturalWidth && imgEl.naturalHeight) ? imgEl.naturalHeight / imgEl.naturalWidth : 0.4;
    const H = Math.max(8, Math.min(80, Math.round(W * ratio)));
    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(imgEl, 0, 0, W, H);
    const data = ctx.getImageData(0, 0, W, H).data;
    let visible = 0, dark = 0, light = 0, colored = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] < 40) continue;
      visible++;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const lum = (r * 299 + g * 587 + b * 114) / 1000;
      const sat = Math.max(r, g, b) - Math.min(r, g, b);
      if (sat > 48 && lum > 40) colored++;
      if (lum < 60) dark++;
      else if (lum > 160) light++;
    }
    return visible > 20
      && colored / visible < 0.02
      && light / visible <= 0.12
      && dark / visible >= 0.75;
  } catch { return false; }
}

function updateCloseAdaptation() {
  const box = document.getElementById('summaryBox');
  const closeBtn = document.getElementById('summaryClose');
  const backdropEl = document.getElementById('summaryBackdrop');
  if (!box.classList.contains('has-backdrop') || !backdropEl.offsetParent) {
    closeBtn.classList.remove('on-light');
    return;
  }
  const backdropBottom = backdropEl.getBoundingClientRect().bottom;
  const btnRect = closeBtn.getBoundingClientRect();
  const btnCentre = (btnRect.top + btnRect.bottom) / 2;
  if (backdropBottom <= btnCentre) {
    closeBtn.classList.remove('on-light');
  } else {
    closeBtn.classList.toggle('on-light', closeBtn._backdropIsLight === true);
  }
}

const PARALLAX_FACTOR = 0.5;
const STRETCH_GAIN = 1.22;
const STRETCH_MAX = 3;
let _bdHeight = 0;
function updateBackdropParallax() {
  const backdrop = document.getElementById('summaryBackdrop');
  if (isDesktop() || !document.getElementById('summaryBox').classList.contains('has-backdrop')) {
    backdrop.style.transform = '';
    backdrop.style.opacity = '';
    backdrop.style.transition = '';
    return;
  }
  const st = document.getElementById('summaryScroll').scrollTop;
  if (st < 0) {
    const h = _bdHeight || (_bdHeight = backdrop.offsetHeight || 1);
    const grow = Math.min((-st / h) * STRETCH_GAIN, STRETCH_MAX);
    backdrop.style.transform = 'scale(' + (1 + grow) + ')';
    backdrop.style.opacity = '';
    backdrop.style.transition = '';
  } else {
    backdrop.style.transform = 'translate3d(0,' + (st * PARALLAX_FACTOR) + 'px,0)';
    if (st > 0) {
      const h = _bdHeight || (_bdHeight = backdrop.offsetHeight || 1);
      backdrop.style.transition = 'none';
      backdrop.style.opacity = Math.max(0, 1 - st / (h * 0.75)).toFixed(3);
    } else {
      backdrop.style.opacity = '';
      backdrop.style.transition = '';
    }
  }
}

function onSummaryScroll() {
  if (document.getElementById('summaryScroll').scrollTop >= 0) updateCloseAdaptation();
  updateBackdropParallax();
}

(function initBackdropStretch() {
  const scrollEl = document.getElementById('summaryScroll');
  let rafId = 0, touching = false;
  const tick = () => {
    updateBackdropParallax();
    if (touching || scrollEl.scrollTop < 0) {
      rafId = requestAnimationFrame(tick);
    } else {
      rafId = 0;
    }
  };
  const start = () => { if (!rafId) rafId = requestAnimationFrame(tick); };
  const end = () => { touching = false; start(); };
  scrollEl.addEventListener('touchstart',  () => { touching = true; _bdHeight = 0; start(); }, { passive: true });
  scrollEl.addEventListener('touchend',    end, { passive: true });
  scrollEl.addEventListener('touchcancel', end, { passive: true });
})();

function ubDarken(rgb) {
  if (!rgb) return null;
  let [r, g, b] = rgb.map(v => Math.round(v * 0.55));
  const lum = (r * 299 + g * 587 + b * 114) / 1000;
  if (lum > 88) { const k = 88 / lum; r = Math.round(r*k); g = Math.round(g*k); b = Math.round(b*k); }
  return `rgb(${r},${g},${b})`;
}
function ubBlend(hexCorners) {
  const parsed = hexCorners.map(hexToRgb).filter(Boolean);
  if (!parsed.length) return null;
  let r = 0, g = 0, b = 0;
  for (const c of parsed) { r += c[0]; g += c[1]; b += c[2]; }
  return ubDarken([r / parsed.length, g / parsed.length, b / parsed.length]);
}

function fitTitle(el) {
  if (!el || el.querySelector('img')) return;
  const text = el.textContent;
  el.innerHTML = '<span class="ttxt"></span>';
  const span = el.firstChild;
  span.textContent = text;
  const MAX = 1.9, MIN = 1.1, STEP = 0.05;
  let fs = MAX, guard = 0;
  el.style.setProperty('--title-fs', fs + 'rem');
  const lh = parseFloat(getComputedStyle(span).lineHeight) || (fs * 16 * 1.12);
  while (fs > MIN && guard++ < 24) {
    if (span.scrollHeight <= lh * 2 + 1) break;
    fs = Math.max(MIN, +(fs - STEP).toFixed(2));
    el.style.setProperty('--title-fs', fs + 'rem');
  }
}

function hexToRgb(hex) {
  if (!hex) return null;
  const h = hex.replace('#', '');
  if (h.length !== 6) return null;
  const n = parseInt(h, 16);
  if (Number.isNaN(n)) return null;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function getUltraBlurColors(item) {
  const ub = item.ultraBlurColors || item.UltraBlurColors;
  if (!ub) return null;
  const tl = hexToRgb(ub.topLeft), tr = hexToRgb(ub.topRight);
  const bl = hexToRgb(ub.bottomLeft), br = hexToRgb(ub.bottomRight);
  if (!tl || !tr || !bl || !br) return null;
  return { tl, tr, bl, br };
}

function setGlow({ tl, tr, bl, br }) {
  const bg = document.getElementById('glowBg');
  bg.style.setProperty('--glow-tl', `rgb(${tl[0]},${tl[1]},${tl[2]})`);
  bg.style.setProperty('--glow-tr', `rgb(${tr[0]},${tr[1]},${tr[2]})`);
  bg.style.setProperty('--glow-bl', `rgb(${bl[0]},${bl[1]},${bl[2]})`);
  bg.style.setProperty('--glow-br', `rgb(${br[0]},${br[1]},${br[2]})`);
}

(function buildStars() {
  const row = document.getElementById('starRow');
  for (let n = 1; n <= 5; n++) {
    const el = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    el.setAttribute('class', 'icon star');
    el.dataset.n = n;
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', '#icon-star-empty');
    el.appendChild(use);
    row.appendChild(el);
  }

  function ratingFromX(x) {
    const stars = [...row.querySelectorAll('.star')];
    let picked = 0;
    for (const s of stars) {
      const rect = s.getBoundingClientRect();
      const mid  = rect.left + rect.width / 2;
      const n    = parseInt(s.dataset.n);
      if (x >= rect.left) picked = x < mid ? n - 0.5 : n;
    }
    return picked;
  }

  function applyFromX(x) {
    const v = ratingFromX(x);
    if (v === 0) {
      if (rating !== 0) buzz(8);
      resetRating();
    } else setRating(v);
  }

  function paintStars(n) {
    document.querySelectorAll('.star').forEach(s => {
      const sn = parseInt(s.dataset.n);
      const use = s.querySelector('use');
      if (n >= sn) { s.setAttribute('class','icon star lit'); use.setAttribute('href','#icon-star-fill'); }
      else if (n >= sn - 0.5) { s.setAttribute('class','icon star lit'); use.setAttribute('href','#icon-star-half'); }
      else { s.setAttribute('class','icon star'); use.setAttribute('href','#icon-star-empty'); }
    });
  }

  let sliding = false;
  row.addEventListener('pointerdown', e => {
    if (busy || isDesktop()) return;
    sliding = true;
    row.setPointerCapture(e.pointerId);
    applyFromX(e.clientX);
  });
  row.addEventListener('pointermove', e => { if (sliding) applyFromX(e.clientX); });
  row.addEventListener('pointerup',     () => { sliding = false; });
  row.addEventListener('pointercancel', () => { sliding = false; });

  row.addEventListener('mousemove', e => {
    if (!isDesktop() || busy) return;
    paintStars(ratingFromX(e.clientX));
  });
  row.addEventListener('mouseleave', () => {
    if (!isDesktop()) return;
    if (rating > 0) paintStars(rating);
    else paintStars(0);
  });
  row.addEventListener('click', e => {
    if (!isDesktop() || busy) return;
    applyFromX(e.clientX);
  });
})();

function paintRating(n) {
  document.querySelectorAll('.star').forEach(s => {
    const sn = parseInt(s.dataset.n);
    const use = s.querySelector('use');
    if (n >= sn) {
      s.setAttribute('class', 'icon star lit');
      use.setAttribute('href', '#icon-star-fill');
    } else if (n >= sn - 0.5) {
      s.setAttribute('class', 'icon star lit');
      use.setAttribute('href', '#icon-star-half');
    } else {
      s.setAttribute('class', 'icon star');
      use.setAttribute('href', '#icon-star-empty');
    }
  });
  const rowEl = document.getElementById('starRow');
  rowEl.setAttribute('aria-valuenow', n);
  rowEl.setAttribute('aria-valuetext', n ? n + (n === 1 ? ' star' : ' stars') : 'Not rated');
}

function setRating(n) {
  if (rating !== n) buzz(8);
  rating = n;
  document.getElementById('starRow').classList.remove('resetting');
  paintRating(n);
  clearTimeout(ratingTimer);
  ratingTimer = setTimeout(submitRating, 1500);
}

function showRating(n) {
  rating = n;
  clearTimeout(ratingTimer);
  ratingTimer = null;
  document.getElementById('starRow').classList.remove('resetting');
  paintRating(n);
  document.getElementById('clearRating').classList.add('on');
}

function resetRating() {
  clearTimeout(ratingTimer);
  ratingTimer = null;
  rating = 0;
  paintRating(0);
  document.getElementById('clearRating').classList.remove('on');
  if (isDesktop()) {
    const row = document.getElementById('starRow');
    row.classList.remove('resetting');
    void row.offsetWidth;
    row.classList.add('resetting');
    clearTimeout(row._resetTimer);
    row._resetTimer = setTimeout(() => row.classList.remove('resetting'), 700);
  }
}

let submitting = false;
async function submitRating() {
  if (!rating || busy || submitting) return;
  const item = queue[0];
  if (!item) return;
  const r = rating;
  submitting = true;
  let ok = true;
  try {
    const res = await fetch(
      `${cfg.url}/:/rate?key=${encodeURIComponent(item.ratingKey)}&identifier=com.plexapp.plugins.library&rating=${r * 2}`,
      { method: 'PUT', headers: H() }
    );
    if (!res.ok) throw new Error('HTTP ' + res.status);
  } catch { ok = false; }
  submitting = false;

  if (!ok) {
    if (queue[0] === item) toast('Couldn’t save. Tap a star to retry');
    return;
  }

  const prev = item.userRating ? item.userRating / 2 : 0;
  item.userRating = r * 2;
  const ai = allItems.indexOf(item);
  if (ai !== -1) allItems.splice(ai, 1);

  const rec = sessionRatings.find(s => s.key === item.ratingKey);
  if (rec) rec.r = r;
  else sessionRatings.push({
    key: item.ratingKey,
    title: item.title || '',
    r,
    libType: item.libType,
    genres: (item._extra && item._extra.genres) || []
  });

  if (!prev) {
    ratedCount++;
    updateRatedCounter(true);
    starsGiven += r;
    flyStars(r);
    if (isMilestone(ratedCount) && ratedCount > lastCelebrated) {
      lastCelebrated = ratedCount;
      celebrate(ratedCount);
    }
  } else if (r > prev) {
    starsGiven += r - prev;
    flyStars(r - prev);
  } else if (r < prev) {
    starsGiven = Math.max(0, starsGiven - (prev - r));
    flyStarsBack(prev - r);
  }
  if (queue[0] === item) advance('right');
}

async function clearRating() {
  if (busy || submitting) return;
  const item = queue[0];
  if (!item || !item.userRating) return;
  const prev = item.userRating / 2;
  submitting = true;
  let ok = true;
  try {
    const res = await fetch(
      `${cfg.url}/:/rate?key=${encodeURIComponent(item.ratingKey)}&identifier=com.plexapp.plugins.library&rating=-1`,
      { method: 'PUT', headers: H() }
    );
    if (!res.ok) throw new Error('HTTP ' + res.status);
  } catch { ok = false; }
  submitting = false;
  if (!ok) { toast('Couldn’t remove rating'); return; }

  delete item.userRating;
  if (allItems.indexOf(item) === -1) allItems.push(item);
  sessionRatings = sessionRatings.filter(s => s.key !== item.ratingKey);
  if (ratedCount > 0) ratedCount--;
  updateRatedCounter(true);
  starsGiven = Math.max(0, starsGiven - prev);
  flyStarsBack(prev);
  if (queue[0] === item) resetRating();
  toast('Rating removed');
}

function doSkip() {
  if (busy) return;
  clearTimeout(ratingTimer);
  const item = queue[0];
  if (item && !item.userRating) {
    snoozeMap[item.ratingKey] = Date.now();
    saveSnooze();
    const ai = allItems.indexOf(item);
    if (ai !== -1) allItems.splice(ai, 1);
    toast('Skipped. Back in 7 days');
  } else {
    toast('Skipped');
  }
  advance('left');
}

function isMilestone(n) {
  if (n === 5 || n === 10 || n === 25 || n === 50) return true;
  return n >= 100 && n % 50 === 0;
}
const MILESTONE_LINES = {
  5: 'Warming up!',
  10: 'On a roll!',
  25: 'Quite the critic!',
  50: 'Certified fresh!',
  100: 'Triple digits!'
};
function milestoneLine(n) {
  return MILESTONE_LINES[n] || (n % 100 === 0 ? 'Legendary!' : 'Unstoppable!');
}
function celebrate(n) {
  buzz([30, 40, 30]);
  toast(`${n} rated! ${milestoneLine(n)}`, true);
  if (typeof confetti !== 'function') return;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const CONFETTI_Z = 1200;
  const boost = n >= 100 ? 1.4 : n >= 50 ? 1.2 : n >= 25 ? 1.1 : 1;
  const leftColors  = ['#F7C600', '#15A9FC'];
  const rightColors = ['#F74366', '#69DD58'];
  const gold = ['#EBAF00', '#FFD75E', '#FFF3C4'];

  confetti({ particleCount: Math.round(26 * boost), spread: 360, startVelocity: 24, gravity: 0.8, decay: 0.93, scalar: 1.2, shapes: ['star'], colors: gold, ticks: 140, origin: { x: 0.5, y: 0.4 }, zIndex: CONFETTI_Z });

  setTimeout(() => {
    confetti({ particleCount: Math.round(110 * boost), spread: 70, startVelocity: 50, angle: 60,  origin: { x: 0, y: 0.75 }, colors: leftColors,  zIndex: CONFETTI_Z });
    confetti({ particleCount: Math.round(110 * boost), spread: 70, startVelocity: 50, angle: 120, origin: { x: 1, y: 0.75 }, colors: rightColors, zIndex: CONFETTI_Z });
  }, 120);

  setTimeout(() => {
    confetti({ particleCount: Math.round(70 * boost), spread: 100, startVelocity: 38, angle: 60,  origin: { x: 0, y: 0.7 }, colors: leftColors,  zIndex: CONFETTI_Z });
    confetti({ particleCount: Math.round(70 * boost), spread: 100, startVelocity: 38, angle: 120, origin: { x: 1, y: 0.7 }, colors: rightColors, zIndex: CONFETTI_Z });
  }, 320);

  setTimeout(() => {
    confetti({ particleCount: Math.round(14 * boost), spread: 120, startVelocity: 16, gravity: 0.35, decay: 0.96, scalar: 1.7, drift: 0.6, shapes: ['star', 'circle'], colors: gold, ticks: 240, origin: { x: 0.5, y: 0.35 }, zIndex: CONFETTI_Z });
  }, 480);
}

function advance(dir) {
  if (busy) return;
  busy = true;

  const stack = document.getElementById('posterStack');
  const p0 = stack.querySelector('.poster.p0');
  const p1 = stack.querySelector('.poster.p1');
  const p2 = stack.querySelector('.poster.p2');

  if (p0) {
    p0.style.zIndex = 5;
    p0.style.transition = 'transform 0.4s cubic-bezier(0.4,0,0.6,1), opacity 0.4s ease';
    const x = dir === 'left' ? '-130%' : '130%';
    const rot = dir === 'left' ? '-18deg' : '18deg';
    p0.style.transform = `translate(-50%,-50%) translateX(${x}) rotate(${rot})`;
    p0.style.opacity = '0';
  }

  if (p1) {
    p1.className = 'poster p0';
    if (p1._glow) requestAnimationFrame(() => requestAnimationFrame(() => setGlow(p1._glow)));
  }
  if (p2) { p2.className = 'poster p1'; }

  const next = queue[3];
  if (next) {
    const img = document.createElement('img');
    img.className = 'poster p2 skeleton';
    img.alt = next.title || '';
    stack.insertBefore(img, stack.firstChild);
    loadPoster(next, img, false);
  }
  preloadAhead();

  const upcoming = queue[1];
  if (upcoming && upcoming.userRating) showRating(upcoming.userRating / 2);
  else resetRating();
  if (upcoming) setInfo(upcoming);

  setTimeout(() => {
    if (p0) p0.remove();
    hist.push({ item: queue.shift(), dir });
    if (hist.length > 30) releaseItemBlobs(hist.shift().item);
    document.getElementById('btnBack').disabled = hist.length === 0;
    updateProgress();
    busy = false;
    if (!queue.length) { hideStage(); setState('done'); }
  }, 400);
}

const castPhotoCache = new Map();
const CAST_CACHE_MAX = 120;
function castCacheSet(url, obj) {
  if (castPhotoCache.size >= CAST_CACHE_MAX) {
    const oldest = castPhotoCache.keys().next().value;
    try { URL.revokeObjectURL(castPhotoCache.get(oldest)); } catch {}
    castPhotoCache.delete(oldest);
  }
  castPhotoCache.set(url, obj);
}
async function loadCastPhoto(url, img) {
  img.decoding = 'async';
  const cached = castPhotoCache.get(url);
  if (cached) { img.src = cached; img.classList.remove('skeleton'); return; }
  img.onerror = () => { img.onerror = null; img.classList.remove('skeleton'); img.src = PLACEHOLDER_CAST; };
  img.onload = () => img.classList.remove('skeleton');
  if (!url.startsWith(cfg.url)) { img.src = url; return; }
  try {
    const resp = await fetch(url, { headers: H() });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const blob = await resp.blob();
    const obj = URL.createObjectURL(blob);
    castCacheSet(url, obj);
    img.src = obj;
  } catch (e) {
    console.warn('[cast] photo fetch failed', url, e);
    img.classList.remove('skeleton');
    img.src = PLACEHOLDER_CAST;
  }
}

async function prefetchCastPhoto(url) {
  if (!url || castPhotoCache.has(url)) return;
  if (!url.startsWith(cfg.url)) {
    const im = new Image();
    im.src = url;
    return;
  }
  try {
    const resp = await fetch(url, { headers: H() });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const blob = await resp.blob();
    castCacheSet(url, URL.createObjectURL(blob));
  } catch {}
}

function formatDuration(ms) {
  const m = Math.max(1, Math.round(ms / 60000));
  const h = Math.floor(m / 60);
  return h ? `${h}h ${m % 60}m` : `${m}m`;
}

function ratingBadge(imageStr, score) {
  if (!imageStr || score == null) return null;
  const s = String(imageStr).toLowerCase();
  const pct = Math.min(100, Math.round(score * 10));
  if (s.includes('rottentomatoes')) {
    const isAudience = s.includes('audience') || s.includes('upright') || s.includes('popcorn') || s.includes('want');
    if (isAudience) {
      const fresh = s.includes('upright') || s.includes('want') || s.includes('fresh');
      return { imgSrc: `images/icons/ui/${fresh ? 'Rotten_Tomatoes_Popcorn' : 'Rotten_Tomatoes_Popcorn_tipped'}.svg`, label: 'Audience', tip: 'Rotten Tomatoes Popcorn: share of the audience who liked it', score: Math.round(score * 10) + '%', pct, fillColor: fresh ? 'rgba(255,120,30,0.22)' : 'rgba(130,130,130,0.18)' };
    }
    const fresh = s.includes('ripe') || s.includes('certified') || s.includes('fresh');
    return { imgSrc: `images/icons/ui/${fresh ? 'Certified_Fresh' : 'Rotten_Tomatoes_rotten'}.svg`, label: 'RT', tip: 'Rotten Tomatoes Tomatometer: share of critics who liked it', score: Math.round(score * 10) + '%', pct, fillColor: fresh ? 'rgba(250,60,20,0.22)' : 'rgba(130,130,130,0.18)' };
  }
  if (s.includes('themoviedb')) return { imgSrc: 'images/icons/ui/TMDB.svg', label: 'TMDb', tip: 'TMDB: average user score out of 10', score: score.toFixed(1), pct, fillColor: 'rgba(1,180,228,0.2)' };
  if (s.includes('imdb')) return { imgSrc: 'images/icons/ui/IMDB.svg', label: 'IMDb', tip: 'IMDb: average user rating out of 10', score: score.toFixed(1), pct, fillColor: 'rgba(245,197,24,0.22)' };
  return { imgSrc: null, label: '★', tip: 'Average user rating', score: score.toFixed(1), pct, fillColor: 'rgba(255,251,248,0.13)' };
}

const EXTRA_TTL = 24 * 60 * 60 * 1000;
const EXTRA_PREFIX = 'px_ex2_';
(function sweepExtraCache() {
  try {
    const now = Date.now();
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith('px_ex_') && !k.startsWith(EXTRA_PREFIX)) continue;
      if (!k.startsWith(EXTRA_PREFIX)) { localStorage.removeItem(k); continue; }
      try {
        const { t } = JSON.parse(localStorage.getItem(k));
        if (!t || now - t > EXTRA_TTL) localStorage.removeItem(k);
      } catch { localStorage.removeItem(k); }
    }
  } catch {}
})();
function lsExtraGet(ratingKey) {
  try {
    const raw = localStorage.getItem(EXTRA_PREFIX + ratingKey);
    if (!raw) return null;
    const { t, d } = JSON.parse(raw);
    if (Date.now() - t > EXTRA_TTL) { localStorage.removeItem(EXTRA_PREFIX + ratingKey); return null; }
    return d;
  } catch { return null; }
}
function lsExtraSet(ratingKey, data) {
  try { localStorage.setItem(EXTRA_PREFIX + ratingKey, JSON.stringify({ t: Date.now(), d: data })); } catch {}
}

async function loadExtraInfo(item) {
  if (item._extra !== undefined) return item._extra;
  const cached = lsExtraGet(item.ratingKey);
  if (cached) { item._extra = cached; return item._extra; }
  try {
    const d = await plexGet(`/library/metadata/${item.ratingKey}`);
    const meta = (d.MediaContainer.Metadata || [])[0];
    const images = (meta && meta.Image) || item.Image || [];
    const logoImg = images.find(i => /clearlogo/i.test(i.type || ''));
    const artPath = meta && meta.art;
    const ub = (meta && (meta.UltraBlurColors || meta.ultraBlurColors))
      || item.ultraBlurColors || item.UltraBlurColors || null;
    const ubTints = ub ? {
      tl: ub.topLeft    ? ubDarken(hexToRgb(ub.topLeft))    : null,
      tr: ub.topRight   ? ubDarken(hexToRgb(ub.topRight))   : null,
      bl: ub.bottomLeft ? ubDarken(hexToRgb(ub.bottomLeft)) : null,
      br: ub.bottomRight? ubDarken(hexToRgb(ub.bottomRight)): null,
    } : null;
    const ratingArr = (meta && meta.Rating) || [];
    item._extra = {
      year: (meta && meta.year) || null,
      ubTints,
      backdrop: artPath ? imgUrl(artPath, isDesktop() ? 900 : 480) : '',
      logo: logoImg && logoImg.url
        ? (/^https?:\/\//.test(logoImg.url) ? logoImg.url : `${cfg.url}${logoImg.url}?X-Plex-Token=${cfg.token}`)
        : '',
      genres: (meta && meta.Genre || []).map(g => g.tag).slice(0, 2),
      cast: (meta && meta.Role || []).slice(0, 6).map(r => ({
        name: r.tag,
        photo: r.thumb ? imgUrl(r.thumb, 70) : ''
      })),
      runtime: (meta && meta.duration) ? formatDuration(meta.duration) : null,
      contentRating: (meta && meta.contentRating) || null,
      ratings: ratingArr.length
        ? ratingArr
        : [
            (meta && meta.rating != null)         ? { image: meta.ratingImage,         value: meta.rating }         : null,
            (meta && meta.audienceRating != null)  ? { image: meta.audienceRatingImage, value: meta.audienceRating } : null,
          ].filter(Boolean),
      country: (meta && meta.Country || []).map(c => c.tag)[0] || null,
      seasonCount: (meta && meta.childCount != null) ? meta.childCount : null,
      episodeCount: (meta && meta.leafCount != null) ? meta.leafCount : null,
      addedAt: item.addedAt || (meta && meta.addedAt) || null,
      lastViewedAt: item.lastViewedAt || (meta && meta.lastViewedAt) || null,
      viewCount: item.viewCount || (meta && meta.viewCount) || null,
      firstViewedAt: null
    };
    if (item._extra.viewCount > 0) {
      try {
        const hist = await plexGet(`/status/sessions/history/all?metadataItemID=${item.ratingKey}&sort=viewedAt%3Aasc&X-Plex-Container-Size=1&X-Plex-Container-Start=0`);
        const first = (hist.MediaContainer.Metadata || hist.MediaContainer.Video || [])[0];
        if (first && first.viewedAt) item._extra.firstViewedAt = first.viewedAt;
      } catch (_) {}
    }
    lsExtraSet(item.ratingKey, item._extra);
  } catch (e) {
    item._extra = { year: null, ubTints: null, backdrop: '', logo: '', genres: [], cast: [], ratings: [], runtime: null, contentRating: null, country: null, seasonCount: null, episodeCount: null, addedAt: item.addedAt || null, lastViewedAt: item.lastViewedAt || null, viewCount: item.viewCount || null, firstViewedAt: null };
  }
  return item._extra;
}

let summaryOpener = null;
let descPopupOpener = null;
let summaryItem = null;
let _lsxFadeTimer = null;

function lsxTransition(populate) {
  if (!isDesktop()) { populate(); return; }
  const scroll = document.getElementById('summaryScroll');
  scroll.classList.remove('lsx-fade-in');
  scroll.classList.add('lsx-fade-out');
  clearTimeout(_lsxFadeTimer);
  _lsxFadeTimer = setTimeout(() => {
    populate();
    scroll.classList.remove('lsx-fade-out');
    scroll.classList.add('lsx-fade-in');
    setTimeout(() => {
      scroll.classList.remove('lsx-fade-in');
    }, 500);
  }, 180);
}

let _meshTimer = null;
function applySummaryMesh(box, meshCss) {
  if (!isDesktop()) { box.style.background = meshCss; return; }
  const bg = document.getElementById('sbBg');
  bg.style.background = meshCss;
  bg.style.opacity = '0';
  void bg.offsetWidth;
  bg.style.opacity = '1';
  clearTimeout(_meshTimer);
  _meshTimer = setTimeout(() => {
    box.style.background = meshCss;
    bg.style.opacity = '0';
  }, 600);
}

let _bdShownId = 'summaryBackdropImg';

function openSummary(forItem) {
  const item = forItem || queue[0];
  if (!item || (!item.summary && !isDesktop())) return;
  summaryItem = item;
  summaryOpener = document.activeElement;
  const titleEl = document.getElementById('summaryTitle');
  const box = document.getElementById('summaryBox');
  const backdrop = document.getElementById('summaryBackdrop');
  const backdropImg = document.getElementById('summaryBackdropImg');

  document.getElementById('lsxSkeleton').classList.remove('on');

  if (!isDesktop()) {
    box.classList.remove('has-backdrop');
    backdrop.classList.remove('on');
    backdropImg.removeAttribute('src');
    backdrop.style.removeProperty('--bd-img');
    box.style.removeProperty('--sb-base');
    box.style.removeProperty('background');
  }
  const closeBtn = document.getElementById('summaryClose');
  closeBtn.classList.remove('on-light');
  closeBtn._backdropIsLight = false;

  ['summaryRowYearRating','summaryRowDuration','summaryGenres',
   'summaryPersonal'].forEach(id => {
    const el = document.getElementById(id);
    el.innerHTML = '';
    el.classList.add('hidden');
  });
  const ratingsReset = document.getElementById('summaryRatings');
  ratingsReset.querySelectorAll('.ratingBadge').forEach(b => b.remove());
  ratingsReset.classList.add('hidden');

  const known = item._extra;
  if ((!known || known.backdrop) && !isDesktop()) {
    box.classList.add('loading-backdrop');
    backdrop.classList.add('skeleton');
  }
  if (known && known.backdrop && known.logo) {
    titleEl.innerHTML = '';
  } else {
    titleEl.textContent = item.title || '';
    fitTitle(titleEl);
  }
  const summaryTextEl = document.getElementById('summaryText');
  summaryTextEl.textContent = item.summary || '';
  summaryTextEl.classList.remove('clamped');
  summaryTextEl.removeAttribute('role');
  summaryTextEl.removeAttribute('tabindex');
  summaryTextEl.removeAttribute('aria-label');
  summaryTextEl.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDescPopup(); } };
  if (isDesktop()) {
    requestAnimationFrame(() => {
      if (summaryItem !== item) return;
      if (summaryTextEl.scrollHeight - summaryTextEl.clientHeight > 4) {
        summaryTextEl.classList.add('clamped');
        summaryTextEl.setAttribute('role', 'button');
        summaryTextEl.setAttribute('tabindex', '0');
        summaryTextEl.setAttribute('aria-label', 'Read full description');
      }
    });
  }
  const castWrap = document.getElementById('summaryCastWrap');
  const castEl = document.getElementById('summaryCast');
  const trailerBtn = document.getElementById('btnTrailer');

  castEl.scrollLeft = 0;
  const scrollEl = document.getElementById('summaryScroll');
  scrollEl.scrollTop = 0;
  const bdEl = document.getElementById('summaryBackdrop');
  bdEl.style.transform = '';
  bdEl.style.opacity = '';
  bdEl.style.transition = '';
  _bdHeight = 0;
  scrollEl.removeEventListener('scroll', onSummaryScroll);
  scrollEl.addEventListener('scroll', onSummaryScroll, { passive: true });
  if (!known) {
    castEl.innerHTML = Array.from({ length: 6 }).map(() => `
      <div class="castMember">
        <div class="castPhoto skeleton"></div>
        <div class="castName skel-text skeleton" style="width:100%;height:11px;margin-top:6px;"></div>
      </div>`).join('');
    castWrap.classList.remove('hidden');
  }

  stopInlineTrailer();
  const trailerKnown = item._trailer;
  trailerBtn.innerHTML = '';
  if (trailerKnown === undefined) {
    trailerBtn.classList.remove('hidden');
    trailerBtn.classList.add('skeleton');
  } else {
    trailerBtn.classList.remove('skeleton');
    trailerBtn.classList.toggle('hidden', !(trailerKnown && trailerKnown.url));
    if (trailerKnown && trailerKnown.url) {
      trailerBtn.innerHTML = '<svg class="icon" aria-hidden="true" focusable="false"><use href="#icon-trailer"/></svg><span class="label">Trailer</span>';
    }
  }
  loadTrailer(item).then(trailer => {
    if (summaryItem !== item) return;
    trailerBtn.classList.remove('skeleton');
    if (trailer && trailer.url) {
      trailerBtn.innerHTML = '<svg class="icon" aria-hidden="true" focusable="false"><use href="#icon-trailer"/></svg><span class="label">Trailer</span>';
      trailerBtn.classList.remove('hidden');
    } else {
      trailerBtn.classList.add('hidden');
    }
    const ratingsEl = document.getElementById('summaryRatings');
    const hasBadges = ratingsEl.querySelector('.ratingBadge');
    const keepForTrailer = isDesktop() && !trailerBtn.classList.contains('hidden');
    ratingsEl.classList.toggle('hidden', !hasBadges && !keepForTrailer);
  });

  const toastEl = document.getElementById('toast');
  if (!toastEl.classList.contains('celebrate')) toastEl.classList.remove('on');
  const overlayEl = document.getElementById('summaryOverlay');
  overlayEl.classList.add('on');
  overlayEl.setAttribute('aria-hidden', 'false');
  if (!isDesktop()) document.getElementById('summaryClose').focus();

  const applyExtra = extra => {
    if (summaryItem !== item) return;

    const yearRatingEl = document.getElementById('summaryRowYearRating');
    const lead = [];
    if (extra.year) lead.push(`<span class="metaText">${escHtml(String(extra.year))}</span>`);
    if (extra.contentRating) lead.push(`<span class="metaPill">${escHtml(extra.contentRating)}</span>`);
    const segs = [];
    if (lead.length) segs.push(lead.join(' '));
    if (extra.runtime) segs.push(`<span class="metaText">${escHtml(extra.runtime)}</span>`);
    if (extra.seasonCount) segs.push(`<span class="metaText">${extra.seasonCount} Season${extra.seasonCount !== 1 ? 's' : ''}</span>`);
    if (extra.episodeCount) segs.push(`<span class="metaText">${extra.episodeCount} Episode${extra.episodeCount !== 1 ? 's' : ''}</span>`);
    if (segs.length) {
      yearRatingEl.innerHTML = segs.join('<span class="metaDot">·</span>');
      yearRatingEl.classList.remove('hidden');
    } else yearRatingEl.classList.add('hidden');

    document.getElementById('summaryRowDuration').classList.add('hidden');

    const ratingsEl = document.getElementById('summaryRatings');
    const mkBadge = b => {
      const img = b.imgSrc ? `<img src="${escHtml(b.imgSrc)}" class="rIcon" alt="${escHtml(b.label)}" onerror="this.style.display='none'">` : '';
      const tip = escHtml(b.tip || b.label);
      return `<span class="ratingBadge" data-pct="${b.pct}" data-tip="${tip}" title="${tip}" role="button" tabindex="0" onclick="ratingTip(this, event)" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();ratingTip(this, event);}" style="--badge-fill:${b.fillColor}">${img}${escHtml(b.score)}</span>`;
    };
    const badges = (extra.ratings || []).map(r => ratingBadge(r.image, r.value)).filter(Boolean);
    ratingsEl.innerHTML = badges.map(mkBadge).join('');
    if (badges.length) {
      requestAnimationFrame(() => requestAnimationFrame(() => {
        ratingsEl.querySelectorAll('.ratingBadge').forEach(el => {
          el.style.backgroundSize = el.dataset.pct + '% 100%';
        });
      }));
    }
    if (isDesktop()) {
      ratingsEl.appendChild(trailerBtn);
      ratingsEl.classList.toggle('hidden', !badges.length && trailerBtn.classList.contains('hidden'));
    } else {
      ratingsEl.insertAdjacentElement('afterend', trailerBtn);
      ratingsEl.classList.toggle('hidden', !badges.length);
    }

    const genresEl = document.getElementById('summaryGenres');
    if (extra.genres && extra.genres.length) { genresEl.textContent = extra.genres.join(' · '); genresEl.classList.remove('hidden'); }
    else genresEl.classList.add('hidden');

    const personalEl = document.getElementById('summaryPersonal');
    const personalRows = [];
    const fmtTs = ts => {
      const d = new Date(ts * 1000);
      return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    };
    if (extra.addedAt) personalRows.push(`<div class="personalRow">Added to library <span>${fmtTs(extra.addedAt)}</span></div>`);
    if (extra.firstViewedAt) personalRows.push(`<div class="personalRow">First watched <span>${fmtTs(extra.firstViewedAt)}</span></div>`);
    if (extra.lastViewedAt && extra.lastViewedAt !== extra.firstViewedAt) personalRows.push(`<div class="personalRow">Last watched <span>${fmtTs(extra.lastViewedAt)}</span></div>`);
    if (item.libType === 'show' && item.viewedLeafCount > 0) {
      const epWatched = item.viewedLeafCount;
      const epTotal = item.leafCount || 0;
      const plays = extra.viewCount || 0;
      const playsNote = plays > epWatched ? `, ${plays} plays` : '';
      personalRows.push(`<div class="personalRow">Watched <span>${epWatched}${epTotal ? ' of ' + epTotal : ''} episode${epWatched !== 1 ? 's' : ''}${playsNote}</span></div>`);
    } else if (extra.viewCount > 1) {
      personalRows.push(`<div class="personalRow">Watched <span>${extra.viewCount} times</span></div>`);
    }
    if (personalRows.length) { personalEl.innerHTML = personalRows.join(''); personalEl.classList.remove('hidden'); }
    else personalEl.classList.add('hidden');

    if (extra.ubTints) {
      const { tl, tr, bl, br } = extra.ubTints;
      const validCorners = [tl, tr, bl, br].filter(Boolean);
      const avg = validCorners.length ? validCorners[Math.floor(validCorners.length / 2)] : '#222';
      box.style.setProperty('--sb-base', avg || '#222');
      const corners = [
        tl ? `radial-gradient(ellipse at 0% 0%, ${tl} 0%, transparent 70%)` : '',
        tr ? `radial-gradient(ellipse at 100% 0%, ${tr} 0%, transparent 70%)` : '',
        bl ? `radial-gradient(ellipse at 0% 100%, ${bl} 0%, transparent 70%)` : '',
        br ? `radial-gradient(ellipse at 100% 100%, ${br} 0%, transparent 70%)` : '',
      ].filter(Boolean);
      const meshCss = corners.length ? `${corners.join(',')}, ${avg}` : avg;
      applySummaryMesh(box, meshCss);
    } else {
      box.style.setProperty('--sb-base', '#222');
      applySummaryMesh(box, '#161616');
    }

    if (extra.backdrop) {
      const applyBackdropBlob = blobUrl => {
        if (summaryItem !== item) return;
        backdrop.style.setProperty('--bd-img', `url("${blobUrl}")`);

        if (isDesktop()) {
          const curId  = _bdShownId;
          const nextId = curId === 'summaryBackdropImg' ? 'summaryBackdropImg2' : 'summaryBackdropImg';
          const curEl  = document.getElementById(curId);
          const nextEl = document.getElementById(nextId);
          nextEl.onload = () => {
            if (summaryItem !== item) return;
            backdrop.classList.remove('skeleton');
            box.classList.remove('loading-backdrop');
            box.classList.add('has-backdrop');
            requestAnimationFrame(() => {
              nextEl.classList.add('bd-show');
              curEl.classList.remove('bd-show');
            });
            _bdShownId = nextId;
            sampleCornerBrightness(nextEl).then(light => {
              if (summaryItem !== item) return;
              const closeBtn = document.getElementById('summaryClose');
              closeBtn._backdropIsLight = light;
              updateCloseAdaptation();
            });
          };
          nextEl.src = blobUrl;
          return;
        }

        backdropImg.onload = () => {
          if (summaryItem !== item) return;
          backdrop.classList.remove('skeleton');
          box.classList.remove('loading-backdrop');
          box.classList.add('has-backdrop');
          requestAnimationFrame(() => backdrop.classList.add('on'));
          sampleCornerBrightness(backdropImg).then(light => {
            if (summaryItem !== item) return;
            const closeBtn = document.getElementById('summaryClose');
            closeBtn._backdropIsLight = light;
            updateCloseAdaptation();
          });
        };
        backdropImg.src = blobUrl;
      };
      const onBackdropError = () => {
        if (summaryItem !== item) return;
        backdrop.classList.remove('skeleton');
        box.classList.remove('loading-backdrop', 'has-backdrop');
        backdrop.classList.remove('on');
      };
      if (item._backdropBlobUrl) {
        applyBackdropBlob(item._backdropBlobUrl);
      } else {
        fetch(extra.backdrop, { headers: H() })
          .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.blob(); })
          .then(blob => { item._backdropBlobUrl = URL.createObjectURL(blob); applyBackdropBlob(item._backdropBlobUrl); })
          .catch(onBackdropError);
      }

      if (extra.logo) {
        const applyLogo = src => {
          if (summaryItem !== item) return;
          const logoImg = new Image();
          logoImg.alt = item.title || '';
          logoImg.onload = () => {
            if (summaryItem !== item) return;
            if (item._logoInvert === undefined) item._logoInvert = logoNeedsInvert(logoImg);
            logoImg.classList.toggle('logo-inverted', !!item._logoInvert);
            titleEl.innerHTML = '';
            titleEl.appendChild(logoImg);
          };
          logoImg.onerror = () => { titleEl.textContent = item.title || ''; fitTitle(titleEl); };
          logoImg.src = src;
        };
        if (item._logoBlobUrl) {
          applyLogo(item._logoBlobUrl);
        } else {
          fetch(extra.logo, { headers: H() })
            .then(r => r.ok ? r.blob() : Promise.reject())
            .then(blob => { item._logoBlobUrl = URL.createObjectURL(blob); applyLogo(item._logoBlobUrl); })
            .catch(() => { if (summaryItem === item) { titleEl.textContent = item.title || ''; fitTitle(titleEl); } });
        }
      }
    } else {
      backdrop.classList.remove('skeleton');
      box.classList.remove('loading-backdrop');
      if (isDesktop()) {
        document.getElementById('summaryBackdropImg').classList.remove('bd-show');
        document.getElementById('summaryBackdropImg2').classList.remove('bd-show');
        box.classList.remove('has-backdrop');
      }
    }

    if (extra.cast.length) {
      castWrap.classList.remove('hidden');
      castEl.innerHTML = extra.cast.map(c => `
        <div class="castMember">
          <img class="castPhoto skeleton" alt="${escHtml(c.name)}">
          <span class="castName">${escHtml(c.name)}</span>
        </div>`).join('');
      const imgs = castEl.querySelectorAll('.castPhoto');
      extra.cast.forEach((c, i) => {
        if (c.photo) {
          loadCastPhoto(c.photo, imgs[i]);
        } else {
          imgs[i].classList.remove('skeleton');
          imgs[i].src = PLACEHOLDER_CAST;
        }
      });
    } else {
      castWrap.classList.add('hidden');
    }
  };

  if (known) applyExtra(known);
  else loadExtraInfo(item).then(applyExtra);
}
function closeSummary() {
  if (isDesktop()) return;
  const overlayEl = document.getElementById('summaryOverlay');
  overlayEl.classList.remove('on');
  overlayEl.setAttribute('aria-hidden', 'true');
  stopInlineTrailer();
  if (summaryOpener && summaryOpener.focus) summaryOpener.focus();
  summaryOpener = null;
}
function closeSummaryFromOverlay(e) {
  if (isDesktop()) return;
  if (e.target === document.getElementById('summaryOverlay')) closeSummary();
}

function openDescPopup() {
  const el = document.getElementById('summaryText');
  if (!el.classList.contains('clamped')) return;
  const item = summaryItem;
  if (!item) return;
  document.getElementById('descPopupTitle').textContent = item.title || '';
  document.getElementById('descPopupText').textContent = item.summary || '';
  descPopupOpener = document.activeElement;
  const popup = document.getElementById('descPopup');
  popup.classList.add('on');
  popup.setAttribute('aria-hidden', 'false');
  document.getElementById('descPopupClose').focus();
}
function closeDescPopup() {
  const popup = document.getElementById('descPopup');
  popup.classList.remove('on');
  popup.setAttribute('aria-hidden', 'true');
  if (descPopupOpener && descPopupOpener.focus) descPopupOpener.focus();
  descPopupOpener = null;
}
function closeDescPopupFromOverlay(e) {
  if (e.target === document.getElementById('descPopup')) closeDescPopup();
}

let recapOpener = null;
function openRecap() {
  const body = document.getElementById('recapBody');
  if (!sessionRatings.length) {
    body.innerHTML = '<div class="recapEmpty">Nothing rated yet. Rate a few titles and your session stats will show up here.</div>';
  } else {
    const n = sessionRatings.length;
    const movies = sessionRatings.filter(s => s.libType === 'movie').length;
    const shows = n - movies;
    const sum = sessionRatings.reduce((a, s) => a + s.r, 0);
    let hi = sessionRatings[0], lo = sessionRatings[0];
    for (const s of sessionRatings) {
      if (s.r > hi.r) hi = s;
      if (s.r < lo.r) lo = s;
    }
    const gCount = {};
    sessionRatings.forEach(s => (s.genres || []).forEach(g => { gCount[g] = (gCount[g] || 0) + 1; }));
    const topGenre = Object.entries(gCount).sort((a, b) => b[1] - a[1])[0];

    const star = '<svg class="icon" aria-hidden="true"><use href="#icon-star-fill"/></svg>';
    const split = [
      movies ? `${movies} movie${movies !== 1 ? 's' : ''}` : '',
      shows ? `${shows} show${shows !== 1 ? 's' : ''}` : ''
    ].filter(Boolean).join(' · ');
    const row = (label, val) => `<div class="recapRow"><span>${label}</span><b>${val}</b></div>`;
    const rows = [
      row('Titles rated', `${n} <span class="recapSub">${escHtml(split)}</span>`),
      row('Stars given', `${star}${fmtStars(sum)}`),
      row('Average rating', `${star}${(sum / n).toFixed(1)}`)
    ];
    if (n > 1 && hi !== lo) {
      rows.push(row('Highest', `${star}${fmtStars(hi.r)} <span class="recapSub">${escHtml(hi.title)}</span>`));
      rows.push(row('Lowest', `${star}${fmtStars(lo.r)} <span class="recapSub">${escHtml(lo.title)}</span>`));
    }
    if (topGenre && topGenre[1] > 1) rows.push(row('Top genre', escHtml(topGenre[0])));

    const buckets = Array(10).fill(0);
    sessionRatings.forEach(s => { buckets[Math.min(9, Math.max(0, Math.round(s.r * 2) - 1))]++; });
    const max = Math.max(...buckets);
    const bars = buckets.map((c, i) =>
      `<div class="recapBar" style="height:${max ? Math.max(5, (c / max) * 100) : 5}%;opacity:${c ? 0.9 : 0.16};animation-delay:${i * 30}ms" title="${(i + 1) / 2} stars: ${c}"></div>`
    ).join('');
    const labels = Array.from({ length: 10 }, (_, i) => `<span>${i % 2 ? (i + 1) / 2 : ''}</span>`).join('');
    body.innerHTML = `<div class="recapRows">${rows.join('')}</div>
      <div class="recapHist" role="img" aria-label="Rating distribution">${bars}</div>
      <div class="recapHistLabels" aria-hidden="true">${labels}</div>`;
  }
  const snoozed = Object.keys(snoozeMap).length;
  if (snoozed) {
    body.insertAdjacentHTML('beforeend',
      `<button class="state-btn recapUnsnooze" onclick="closeRecap();unsnoozeAll()">Bring back ${snoozed} skipped title${snoozed !== 1 ? 's' : ''}</button>`);
  }
  body.insertAdjacentHTML('beforeend',
    '<button class="state-btn recapUnsnooze" onclick="closeRecap();resyncLibrary(false)">Resync library</button>');
  recapOpener = document.activeElement;
  const popup = document.getElementById('recapPopup');
  popup.classList.add('on');
  popup.setAttribute('aria-hidden', 'false');
  document.getElementById('recapClose').focus();
}
function closeRecap() {
  const popup = document.getElementById('recapPopup');
  popup.classList.remove('on');
  popup.setAttribute('aria-hidden', 'true');
  if (recapOpener && recapOpener.focus) recapOpener.focus();
  recapOpener = null;
}
function closeRecapFromOverlay(e) {
  if (e.target === document.getElementById('recapPopup')) closeRecap();
}

let helpOpener = null;
function openHelp() {
  helpOpener = document.activeElement;
  const popup = document.getElementById('helpPopup');
  popup.classList.add('on');
  popup.setAttribute('aria-hidden', 'false');
  document.getElementById('helpClose').focus();
}
function closeHelp() {
  const popup = document.getElementById('helpPopup');
  popup.classList.remove('on');
  popup.setAttribute('aria-hidden', 'true');
  if (helpOpener && helpOpener.focus) helpOpener.focus();
  helpOpener = null;
}
function closeHelpFromOverlay(e) {
  if (e.target === document.getElementById('helpPopup')) closeHelp();
}

function goBack() {
  if (!hist.length || busy) return;
  busy = true;
  clearTimeout(ratingTimer);

  const { item, dir } = hist.pop();
  queue.unshift(item);
  if (snoozeMap[item.ratingKey]) {
    delete snoozeMap[item.ratingKey];
    saveSnooze();
    if (!item.userRating && allItems.indexOf(item) === -1) allItems.push(item);
  }

  const stack = document.getElementById('posterStack');
  const p0 = stack.querySelector('.poster.p0');
  const p1 = stack.querySelector('.poster.p1');
  const p2 = stack.querySelector('.poster.p2');

  if (p2) p2.remove();
  if (p1) p1.className = 'poster p2';
  if (p0) p0.className = 'poster p1';

  const img = document.createElement('img');
  img.className = 'poster p0 skeleton';
  img.alt = item.title || '';
  img.style.transition = 'none';
  img.style.zIndex = 5;
  const x = dir === 'left' ? '-130%' : '130%';
  const rot = dir === 'left' ? '-18deg' : '18deg';
  img.style.transform = `translate(-50%,-50%) translateX(${x}) rotate(${rot})`;
  img.style.opacity = '0';
  stack.appendChild(img);
  loadPoster(item, img, true);

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      img.style.transition = 'transform 0.4s cubic-bezier(0.4,0,0.6,1), opacity 0.4s ease';
      img.style.transform = 'translate(-50%,-50%) scale(1)';
      img.style.opacity = '1';
    });
  });

  setInfo(item);
  if (item.userRating) showRating(item.userRating / 2);
  else resetRating();
  document.getElementById('btnBack').disabled = hist.length === 0;
  updateProgress();
  preloadAhead();

  setTimeout(() => {
    img.removeAttribute('style');
    img.className = 'poster p0';
    busy = false;
  }, 420);
}

function shuffleArray(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function toggleShuffle() {
  if (busy || queue.length < 2) return;
  clearTimeout(ratingTimer);
  shuffled = !shuffled;
  const shuffleBtn = document.getElementById('btnShuffle');
  shuffleBtn.classList.toggle('active', shuffled);
  shuffleBtn.setAttribute('aria-pressed', String(shuffled));

  const [current, ...rest] = queue;
  let reordered;
  if (shuffled) {
    reordered = shuffleArray(rest);
  } else {
    const restKeys = new Set(rest.map(it => it.ratingKey));
    reordered = chronological.filter(it => restKeys.has(it.ratingKey));
  }
  queue = [current, ...reordered];
  rebuild();
  toast(shuffled ? 'Shuffle on' : 'Shuffle off');
}

function setState(s) {
  [['stAuth','auth'],['stLoad','load'],['stErr','err'],['stDone','done']].forEach(([id, key]) => {
    const el = document.getElementById(id);
    const on = s === key;
    el.classList.toggle('on', on);
    el.setAttribute('aria-hidden', String(!on));
  });
  if (s === 'done') {
    const n = Object.keys(snoozeMap).length;
    const u = document.getElementById('btnUnsnooze');
    u.style.display = n ? '' : 'none';
    u.textContent = n === 1 ? 'Bring back 1 skipped title' : `Bring back ${n} skipped titles`;
  }
}
function showStage() {
  document.getElementById('stage').classList.add('on');
  document.getElementById('progress').classList.add('on');
  document.getElementById('typeFilter').classList.add('on');
  document.getElementById('counters').classList.add('on');
  document.getElementById('btnSignOut').classList.add('on');
  document.getElementById('btnHelp').classList.add('on');
  ['stAuth','stLoad','stErr','stDone'].forEach(id => document.getElementById(id).classList.remove('on'));
}
function hideStage() {
  document.getElementById('stage').classList.remove('on');
  document.getElementById('progress').classList.remove('on');
  document.getElementById('typeFilter').classList.remove('on');
  document.getElementById('counters').classList.remove('on');
  document.getElementById('btnSignOut').classList.remove('on');
  document.getElementById('btnHelp').classList.remove('on');
}

const RING_CIRC = 2 * Math.PI * 15.5;
function updateProgress() {
  const total = chronological.length;
  const remaining = Math.min(queue.length, total);
  const frac = total ? Math.min(1, Math.max(0, (total - remaining) / total)) : 0;
  const bar = document.querySelector('#progress .ring-bar');
  bar.style.strokeDasharray = RING_CIRC;
  bar.style.strokeDashoffset = RING_CIRC * (1 - frac);
  document.getElementById('progressCount').textContent = remaining;
  document.getElementById('progress').setAttribute('aria-label', remaining + (remaining === 1 ? ' title' : ' titles') + ' left to rate');
}

function fmtDate(ms) {
  const d = new Date(ms), diff = (Date.now() - ms) / 86400000;
  if (diff < 1)  return 'today';
  if (diff < 2)  return 'yesterday';
  if (diff < 7)  return Math.floor(diff) + 'd ago';
  if (diff < 30) return Math.floor(diff/7) + 'w ago';
  return d.toLocaleDateString(undefined, { month:'short', year:'numeric' });
}

function toast(msg, isCelebrate) {
  const t = document.getElementById('toast');
  const stackRect = document.getElementById('posterStack').getBoundingClientRect();
  if (stackRect.height) {
    t.style.top = (stackRect.top - 46) + 'px';
    t.style.bottom = 'auto';
  }
  if (isCelebrate) {
    t.innerHTML = '<img src="images/icons/ui/trophy.svg" class="icon" alt="" onerror="this.style.display=\'none\'">' + escHtml(msg);
    t.classList.add('celebrate');
    t.classList.remove('on');
    void t.offsetWidth;
  } else {
    t.textContent = msg;
    t.classList.remove('celebrate');
  }
  t.classList.add('on');
  clearTimeout(t._t);
  t._t = setTimeout(() => t.classList.remove('on'), isCelebrate ? 3200 : 1600);
}

window.addEventListener('pagehide', () => {
  if (!rating || submitting || !ratingTimer || !queue[0]) return;
  const item = queue[0];
  try {
    fetch(`${cfg.url}/:/rate?key=${encodeURIComponent(item.ratingKey)}&identifier=com.plexapp.plugins.library&rating=${rating * 2}`,
      { method: 'PUT', headers: H(), keepalive: true });
  } catch {}
});

let hiddenAt = 0;
const RESYNC_AWAY_MS = 5 * 60 * 1000;
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    hiddenAt = Date.now();
    const v = document.getElementById('trailerVideo');
    if (v && v.src && !v.paused) v.pause();
    return;
  }
  if (hiddenAt && Date.now() - hiddenAt > RESYNC_AWAY_MS) resyncLibrary(true);
});

window.addEventListener('offline', () => toast('You’re offline'));
window.addEventListener('online',  () => toast('Back online'));

['gesturestart','gesturechange','gestureend'].forEach(ev =>
  document.addEventListener(ev, e => e.preventDefault())
);
let lastTouch = 0;
document.addEventListener('touchend', e => {
  if (e.target.closest('button,[role="button"],a,input,select,textarea')) return;
  const now = Date.now();
  if (now - lastTouch <= 300) e.preventDefault();
  lastTouch = now;
}, { passive: false });
document.addEventListener('touchmove', e => {
  if (e.scale && e.scale !== 1) e.preventDefault();
}, { passive: false });

document.addEventListener('keydown', e => {
  if (document.getElementById('helpPopup').classList.contains('on')) {
    if (e.key === 'Escape') closeHelp();
    return;
  }
  if (document.getElementById('recapPopup').classList.contains('on')) {
    if (e.key === 'Escape') closeRecap();
    return;
  }
  if (document.getElementById('descPopup').classList.contains('on')) {
    if (e.key === 'Escape') closeDescPopup();
    return;
  }
  const overlayOn = document.getElementById('summaryOverlay').classList.contains('on');
  const desktop = isDesktop();

  if (overlayOn && !desktop) {
    if (e.key === 'Escape') { closeSummary(); return; }
    if (e.key === 'Tab') {
      const box = document.getElementById('summaryBox');
      const focusable = Array.from(box.querySelectorAll(
        'button:not([disabled]),[href],[tabindex]:not([tabindex="-1"]),video'
      )).filter(el => el.offsetParent !== null);
      if (!focusable.length) return;
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
    return;
  }

  if (desktop && e.key === 'Escape'
      && document.getElementById('summaryBox').classList.contains('playing-trailer')) {
    stopInlineTrailer();
    return;
  }

  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
  if (e.key === '?' && desktop && !e.ctrlKey && !e.metaKey && !e.altKey) {
    e.preventDefault();
    openHelp();
    return;
  }
  if (busy || !queue[0]) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;

  const digit = e.code && /^(?:Digit|Numpad)([0-5])$/.exec(e.code);
  if (digit) {
    e.preventDefault();
    const n = parseInt(digit[1], 10);
    if (n === 0) resetRating();
    else setRating(e.shiftKey ? n - 0.5 : n);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    setRating(Math.min(5, (rating || 0) + 0.5));
  } else if (e.key === 'ArrowDown') {
    e.preventDefault();
    setRating(Math.max(0.5, (rating || 0.5) - 0.5));
  } else if (e.key === 'Enter') {
    if (rating) { e.preventDefault(); clearTimeout(ratingTimer); submitRating(); }
  } else if (e.key === 'ArrowLeft') {
    e.preventDefault();
    goBack();
  } else if (e.key === 'ArrowRight') {
    e.preventDefault();
    doSkip();
  } else if (e.key === 'Backspace') {
    e.preventDefault();
    const cur = queue[0];
    if (ratingTimer) {
      if (cur && cur.userRating) showRating(cur.userRating / 2);
      else resetRating();
    } else if (cur && cur.userRating) {
      clearRating();
    } else {
      resetRating();
    }
  } else if (e.key && e.key.toLowerCase() === 't') {
    const tb = document.getElementById('btnTrailer');
    if (tb && !tb.classList.contains('hidden') && !tb.classList.contains('skeleton')) {
      e.preventDefault();
      playInlineTrailer();
    }
  }
});

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(e => console.warn('[sw]', e));
  });
}

updateSortButton();
if (cfg.token && cfg.url) {
  loadItems();
} else {
  setState('auth');
}
