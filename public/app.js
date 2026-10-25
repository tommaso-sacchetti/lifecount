// Lifecount client. Vanilla JS, no build step.
// State flows one way: server state -> store.state -> render(). Taps are applied
// optimistically, sent as actions, and reconciled when the server echoes back.

const $app = document.getElementById('app');
const $sheet = document.getElementById('sheet-root');
const $toast = document.getElementById('toast');

const COLORS = ['sky', 'crimson', 'jade', 'violet', 'amber', 'teal', 'orange', 'rose'];
const LETHAL_POISON = 10;
const LETHAL_CMDR = 21;
const DELTA_MS = 2600;

const store = {
  route: null,
  code: null,
  playerId: null,
  state: null,
  stashed: null,
  pending: 0,
  es: null,
  info: null,
  sheet: null, // { kind, id?, fresh? }
  deltas: {}, // playerId -> { v, t, by }
  tableAmount: 1,
  stats: null,
  gameRecord: null,
};

// ---------- utils ----------

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const ls = {
  get(k, d = null) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};
const clock = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
};
const dur = (ms) => {
  const m = Math.round(ms / 60000);
  return m >= 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m` : `${m}m`;
};
const signed = (n) => (n > 0 ? `+${n}` : `${n}`);
const minus = (n) => (n < 0 ? `−${-n}` : signed(n)); // typographic minus for display
const pct = (x) => `${Math.round(x * 100)}%`;
let serverSkew = 0; // serverNow - Date.now()
const now = () => Date.now() + serverSkew;

function toast(msg) {
  $toast.textContent = msg;
  $toast.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => $toast.classList.remove('show'), 2400);
}

const buzz = (ms = 8) => { try { navigator.vibrate?.(ms); } catch { /* unsupported */ } };

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(json.error || `HTTP ${res.status}`); e.status = res.status; throw e; }
  return json;
}

// ---------- icons ----------

const svg = (body) => `<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${body}</svg>`;
const icon = {
  poison: svg('<circle cx="12" cy="12" r="6.5"/><path d="M12 2.5v19"/>'), // phyrexian mana
  cmdr: svg('<path d="M20 4v4.5L10.5 18 6 13.5 15.5 4z"/><path d="M4.5 12.5l7 7M4 20l3-3"/>'),
  crown: svg('<path d="M3.5 8l4.5 4 4-6.5 4 6.5 4.5-4-1.8 10.5H5.3z"/>'),
  table: svg('<circle cx="8.5" cy="8" r="3"/><circle cx="16.5" cy="9" r="2.5"/><path d="M2.5 19.5c0-3.3 2.7-5.5 6-5.5s6 2.2 6 5.5M15 14.2c3.2-.4 6.5 1.4 6.5 5.3"/>'),
  undo: svg('<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>'),
  log: svg('<path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/>'),
  next: svg('<path d="M5 12h14M13 6l6 6-6 6"/>'),
  menu: svg('<path d="M4 7h16M4 12h16M4 17h16"/>'),
  up: svg('<path d="m6 15 6-6 6 6"/>'),
  down: svg('<path d="m6 9 6 6 6-6"/>'),
  x: svg('<path d="M6 6l12 12M18 6 6 18"/>'),
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  back: svg('<path d="m15 18-6-6 6-6"/>'),
  check: svg('<path d="m5 12 5 5 9-10"/>'),
  dice: svg('<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M9 9h.01M15 15h.01M15 9h.01M9 15h.01M12 12h.01"/>'),
};

// ---------- derived state ----------

const S = () => store.state;
const me = () => S()?.players.find((p) => p.id === store.playerId);
const byId = (id) => S()?.players.find((p) => p.id === id);
const seats = () => [...S().players].sort((a, b) => a.seat - b.seat);
const isOut = (p) => !!p.eliminatedAt;
const isOnline = (p) => !!p && S().online.includes(p.id);
const maxCmdr = (p) => Math.max(0, ...Object.values(p.cmdr || {}));
const lethal = (p) => !isOut(p) && (p.life <= 0 || p.poison >= LETHAL_POISON || maxCmdr(p) >= LETHAL_CMDR);

// Commander art. The server only accepts Scryfall image URLs; re-check here because they go into CSS url().
const safeImg = (u) => (typeof u === 'string' && /^https:\/\/cards\.scryfall\.io\/[\w\-./?=&%]+$/.test(u) ? u : '');
const artVar = (url) => (safeImg(url) ? `--art:url('${safeImg(url)}');` : '');
const artOf = (p) => artVar(p?.card?.art);
const parseCard = (c) => { if (typeof c !== 'string') return c || null; try { return JSON.parse(c); } catch { return null; } };

// Opponents in table order, starting from the player on your left, going clockwise.
function opponentsInOrder() {
  const list = seats();
  const i = list.findIndex((p) => p.id === store.playerId);
  if (i < 0) return list;
  return [...list.slice(i + 1), ...list.slice(0, i)];
}

function joinUrl(code) {
  const local = ['localhost', '127.0.0.1', '::1'].includes(location.hostname);
  const base = local && store.info?.lan?.[0] ? store.info.lan[0] : location.origin;
  return `${base}/#/s/${code}`;
}

// ---------- sync ----------

function adopt(state) {
  if (store.pending > 0) { store.stashed = state; return; }
  store.stashed = null;
  const prev = store.state;
  if (state.serverNow) serverSkew = state.serverNow - Date.now();
  // Surface changes made by other phones as small delta badges.
  if (prev && prev.code === state.code && state.game && prev.game) {
    for (const p of state.players) {
      const old = prev.players.find((q) => q.id === p.id);
      if (!old || old.life === p.life) continue;
      const last = [...state.game.log].reverse().find((e) => e.kind === 'adjust' && e.target === p.id);
      bumpDelta(p.id, p.life - old.life, last?.by);
    }
  }
  store.state = state;
  if (state.status === 'closed') disconnect();
  render();
}

function bumpDelta(id, v, by) {
  const d = store.deltas[id];
  const fresh = d && now() - d.t < DELTA_MS && d.by === by;
  store.deltas[id] = { v: (fresh ? d.v : 0) + v, t: now(), by };
  clearTimeout(bumpDelta.t);
  bumpDelta.t = setTimeout(render, DELTA_MS + 50);
}

function connect(code) {
  disconnect();
  const es = new EventSource(`/api/sessions/${code}/stream?playerId=${encodeURIComponent(store.playerId || '')}`);
  es.onmessage = (ev) => adopt(JSON.parse(ev.data));
  es.onerror = async () => {
    // EventSource retries on its own; just check whether the session is gone.
    try { await api('GET', `/api/sessions/${code}`); } catch (e) {
      if (e.status === 404) { disconnect(); store.state = { ...(store.state || {}), status: 'closed', closedReason: store.state?.closedReason || 'session no longer exists' }; render(); }
    }
  };
  store.es = es;
  // Free hosts sleep after ~15 min without requests; an open stream may not count, so poll gently.
  store.keepAlive = setInterval(refresh, 5 * 60_000);
}

function disconnect() {
  store.es?.close();
  store.es = null;
  clearInterval(store.keepAlive);
}

async function refresh() {
  if (!store.code) return;
  try { adopt(await api('GET', `/api/sessions/${store.code}`)); } catch (e) {
    if (e.status === 404) { store.state = { status: 'closed', closedReason: 'session no longer exists', players: [] }; render(); }
  }
}

async function send(action) {
  store.pending += 1;
  try {
    const { state } = await api('POST', `/api/sessions/${store.code}/action`, { ...action, playerId: store.playerId });
    store.pending -= 1;
    adopt(store.pending ? state : store.stashed && store.stashed.version > state.version ? store.stashed : state);
  } catch (e) {
    store.pending -= 1;
    toast(e.message);
    refresh();
  }
}

// Optimistic mirror of the server's adjust() for instant feedback. Returns false if it was a no-op.
function applyLocal(target, field, delta, source) {
  const p = byId(target);
  if (!p || S().status !== 'playing') return false;
  if (field === 'life') { p.life += delta; bumpDelta(target, delta, store.playerId); }
  if (field === 'poison') { if (p.poison + delta < 0) return false; p.poison += delta; }
  if (field === 'cmdr') {
    const cur = p.cmdr[source] || 0;
    if (cur + delta < 0) return false;
    p.cmdr[source] = cur + delta;
    p.life -= delta;
    bumpDelta(target, -delta, store.playerId);
  }
  return true;
}

function adjust(target, field, delta, source) {
  if (!applyLocal(target, field, delta, source)) return;
  buzz();
  render();
  send({ type: 'adjust', target, field, delta, source: source || undefined });
}

function bulk(label, ops) {
  ops = ops.filter((op) => applyLocal(op.target, op.field, op.delta, null));
  if (!ops.length) return;
  buzz(20);
  store.sheet = null;
  render();
  toast(label);
  send({ type: 'bulk', label, ops });
}

// ---------- wake lock ----------

let wakeLock = null;
async function keepAwake() {
  if (wakeLock || !('wakeLock' in navigator) || S()?.status !== 'playing') return;
  try { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); } catch { /* needs https */ }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') { refresh(); keepAwake(); }
});

// ---------- routing ----------

function parseRoute() {
  const h = location.hash.replace(/^#\/?/, '');
  const [a, b] = h.split('/');
  if (a === 's' && b) return { name: 'session', code: b.toUpperCase() };
  if (a === 'stats') return { name: 'stats' };
  if (a === 'g' && b) return { name: 'game', id: b };
  return { name: 'home' };
}

async function route() {
  const r = parseRoute();
  store.route = r;
  store.sheet = null;
  if (r.name !== 'session') { disconnect(); store.code = null; store.state = null; }
  if (r.name === 'session') {
    if (store.code !== r.code) {
      store.code = r.code;
      store.state = null;
      store.playerId = ls.get(`lc.player.${r.code}`);
      render();
      try {
        const st = await api('GET', `/api/sessions/${r.code}`);
        store.state = st;
        if (store.playerId && !st.players.some((p) => p.id === store.playerId)) store.playerId = null;
        if (store.playerId) { ls.set('lc.last', r.code); connect(r.code); }
      } catch (e) {
        store.state = { status: 'closed', closedReason: e.status === 404 ? 'Session not found.' : e.message, players: [] };
      }
    }
  }
  if (r.name === 'stats') { store.stats = null; render(); api('GET', '/api/stats').then((s) => { store.stats = s; render(); }).catch((e) => toast(e.message)); }
  if (r.name === 'game') { store.gameRecord = null; render(); api('GET', `/api/games/${r.id}`).then((g) => { store.gameRecord = g; render(); }).catch((e) => toast(e.message)); }
  render();
}
window.addEventListener('hashchange', route);
// In-app navigation marks its history entries, so Back knows whether there's an app page behind it.
const go = (hash) => {
  if (location.hash === hash) return;
  history.pushState({ inApp: true }, '', hash);
  route();
};
// Where Back leads when this page was opened directly (reload, shared link, home-screen start).
function parentHash() {
  const r = store.route || {};
  if (r.name === 'game') return '#/stats';
  const last = ls.get('lc.last');
  return last ? `#/s/${last}` : '#/';
}

// ---------- render ----------

function render() {
  const r = store.route || { name: 'home' };
  let html = '';
  if (r.name === 'home') html = viewHome();
  else if (r.name === 'stats') html = viewStats();
  else if (r.name === 'game') html = viewGameRecord();
  else if (r.name === 'session') {
    const s = S();
    if (!s) html = `<div class="page"><div class="empty">Connecting to ${esc(store.code)}…</div></div>`;
    else if (s.status === 'closed') html = viewClosed();
    else if (!me()) html = viewJoin();
    else if (s.status === 'lobby') html = viewLobby();
    else if (s.status === 'playing') html = viewGame();
    else if (s.status === 'ended') html = viewEnded();
  }
  const typed = snapshotForms($app);
  $app.innerHTML = html;
  restoreForms($app, typed);
  renderSheet();
  tick();
}

// A server update (someone else joining, say) re-renders the page; keep what this person was typing.
function snapshotForms(root) {
  const forms = {};
  root.querySelectorAll('form[data-form]').forEach((f) => {
    forms[f.dataset.form] = [...f.elements].filter((el) => el.name).map((el) => [el.name, el.value]);
  });
  const a = document.activeElement;
  const focus = a?.form && root.contains(a) ? { form: a.form.dataset.form, name: a.name, at: a.selectionStart } : null;
  return { forms, focus };
}

function restoreForms(root, { forms, focus }) {
  for (const [name, fields] of Object.entries(forms)) {
    const f = root.querySelector(`form[data-form="${name}"]`);
    if (!f) continue;
    for (const [k, v] of fields) {
      const el = f.elements[k];
      if (!el || el.length) continue;
      if (k === 'color') { const sw = f.querySelector(`.swatch[data-color="${v}"]:not(.taken)`); if (sw) actions.pickColor(sw.dataset, sw); continue; }
      el.value = v;
    }
    syncCmdrField(f);
  }
  const el = focus && root.querySelector(`form[data-form="${focus.form}"]`)?.elements[focus.name];
  if (el?.focus) { el.focus(); try { el.setSelectionRange(focus.at, focus.at); } catch { /* not a text input */ } }
}

function renderSheet() {
  // Don't clobber an input the user is typing into.
  if ($sheet.contains(document.activeElement) && document.activeElement.matches('input')) return;
  const sh = store.sheet;
  if (!sh || !S() || S().status === 'closed') { $sheet.innerHTML = ''; return; }
  const body = {
    player: sheetPlayer, table: sheetTable, menu: sheetMenu, invite: sheetInvite, log: sheetLog, end: sheetEnd, profile: sheetProfile, start: sheetStart, addPlayer: sheetAddPlayer,
  }[sh.kind]?.(sh);
  if (!body) { store.sheet = null; $sheet.innerHTML = ''; return; }
  const enter = sh.fresh ? ' enter' : '';
  sh.fresh = false;
  const typed = enter ? { forms: {}, focus: null } : snapshotForms($sheet);
  $sheet.innerHTML = `<div class="backdrop${enter}" data-act="closeSheet"></div><div class="sheet${enter}" role="dialog">${body}</div>`;
  restoreForms($sheet, typed);
}

function openSheet(kind, id) { store.sheet = { kind, id, fresh: true }; renderSheet(); }

const sheetHead = (title, sub = '', color = null, art = null) => `<div class="sheet-head ${color ? 'colored' : ''} ${artVar(art) ? 'has-art' : ''}" ${color ? `data-c="${color}"` : ''} style="${artVar(art)}">
  <div class="t"><b>${title}</b>${sub ? `<span>${sub}</span>` : ''}</div>
  <button class="icon-btn" data-act="closeSheet" aria-label="Close">${icon.x}</button></div>`;

// Live clocks update in place every second instead of re-rendering everything.
function tick() {
  const g = S()?.game;
  document.querySelectorAll('[data-clock="turn"]').forEach((el) => { el.textContent = g?.turnStartedAt ? clock(now() - g.turnStartedAt) : ''; });
  document.querySelectorAll('[data-clock="game"]').forEach((el) => { el.textContent = g?.startedAt ? clock((g.endedAt || now()) - g.startedAt) : ''; });
}
setInterval(tick, 1000);

// ---------- views: home / join / closed ----------

// `p` is whoever the form is for: this phone's saved profile by default, or a seat being edited.
function profileFields(taken = [], p = ls.get('lc.profile', {}), namePh = 'Tommaso') {
  const color = p.color && !taken.includes(p.color) ? p.color : COLORS.find((c) => !taken.includes(c));
  const card = parseCard(p.card);
  const picked = card && card.name === p.commander ? card : null;
  return `
    <label class="field"><span class="cap">Your name</span>
      <input class="input" name="name" maxlength="20" autocomplete="nickname" required value="${esc(p.name || '')}" placeholder="${esc(namePh)}"></label>
    <div class="field">
      <label class="cap" for="cmdr-${store.sheet ? 'sheet' : 'page'}">Commander (optional)</label>
      <div class="cmdr-input ${picked ? 'picked' : ''}" style="${artVar(picked?.art)}"><span class="thumb"></span>
        <input class="input" id="cmdr-${store.sheet ? 'sheet' : 'page'}" name="commander" maxlength="80" autocomplete="off" autocorrect="off" spellcheck="false" data-cmdr
          value="${esc(p.commander || '')}" placeholder="Search legal commanders"></div>
      <input type="hidden" name="card" value="${esc(picked ? JSON.stringify(picked) : '')}">
      <div class="cmdr-results" role="listbox"></div>
    </div>
    <div class="field"><span class="cap">Colour</span>
      <div class="swatches">${COLORS.map((c) => `<button type="button" class="swatch ${c === color ? 'on' : ''} ${taken.includes(c) ? 'taken' : ''}" data-c="${c}" data-act="pickColor" data-color="${c}" aria-label="${c}">${c === color ? icon.check : ''}</button>`).join('')}</div>
      <input type="hidden" name="color" value="${color}"></div>`;
}

function viewHome() {
  const last = ls.get('lc.last');
  return `<div class="page">
    <div class="brand">
      <img src="/icon.svg" alt="">
      <div><h1 class="h1">Lifecount</h1><p>Commander life counter, synced across the table</p></div>
    </div>
    ${last ? `<button class="btn block big" data-act="resume" data-code="${esc(last)}">Resume game ${esc(last)}</button>` : ''}
    <form class="panel section" data-form="create">
      <h2 class="h2">New game</h2>
      ${profileFields()}
      <button class="btn primary block big" type="submit">Create table</button>
    </form>
    <form class="panel section" data-form="joinCode">
      <h2 class="h2">Join a table</h2>
      <input class="input code" name="code" maxlength="4" autocomplete="off" autocapitalize="characters" placeholder="CODE" required aria-label="Session code">
      <button class="btn block" type="submit">Join</button>
      <p class="or" style="margin:0">Or scan the QR code on the host's phone</p>
    </form>
    <button class="btn ghost block" data-act="go" data-to="#/stats">Stats and past games</button>
  </div>`;
}

const seatArt = (p) => (p.card?.art ? `class="seat has-art" style="${artOf(p)}"` : 'class="seat"');

function seatRow(p, i, right = '') {
  const s = S();
  return `<div class="seat-n" data-c="${p.color}">${i + 1}</div>
    <div class="seat-who"><b>${esc(p.name)}${s.online.includes(p.id) ? '<span class="online on"></span>' : ''}</b>
      <span class="sub">${esc(p.commander || 'No commander set')}</span></div>${right}`;
}

const claimRow = (p, i) => `<button ${seatArt(p)} data-act="claim" data-id="${p.id}">${seatRow(p, i, `<span class="tag">${isOnline(p) ? 'On a phone' : 'Take seat'}</span>`)}</button>`;

function viewJoin() {
  const s = S();
  if (s.status === 'lobby') {
    return `<div class="page">
      <div class="brand"><img src="/icon.svg" alt=""><div><h1 class="h1">Table ${esc(s.code)}</h1>
        <p>${s.players.length} player${s.players.length === 1 ? '' : 's'} · ${s.settings.startingLife} life</p></div></div>
      ${s.players.length ? `<div class="section"><h2 class="h2">Already at the table?</h2><span class="muted small" style="margin-top:-6px">Tap your seat to use it on this phone</span>
        <div class="seat-list">${seats().map((p, i) => claimRow(p, i)).join('')}</div></div>` : ''}
      <form class="panel section" data-form="join"><h2 class="h2">New seat</h2>${profileFields(s.players.map((p) => p.color))}
        <button class="btn primary block big" type="submit">Take a new seat</button></form>
    </div>`;
  }
  // Mid-game: claim an existing seat (e.g. phone died or switched device).
  return `<div class="page">
    <div class="brand"><img src="/icon.svg" alt=""><div><h1 class="h1">Game in progress</h1><p>Tap your seat to rejoin</p></div></div>
    <div class="seat-list">${seats().map((p, i) => claimRow(p, i)).join('')}</div>
    <button class="btn ghost block" data-act="go" data-to="#/">Back to home</button>
  </div>`;
}

function viewClosed() {
  return `<div class="page" style="padding-top:20vh;text-align:center">
    <div><h1 class="h1">Session closed</h1>
    <p class="muted">${esc(S().closedReason || '')}</p></div>
    <button class="btn primary block big" data-act="home">New game</button>
    <button class="btn ghost block" data-act="go" data-to="#/stats">See stats</button>
  </div>`;
}

// ---------- views: lobby ----------

function viewLobby() {
  const s = S();
  const host = s.hostId === store.playerId;
  const list = seats();
  return `<div class="page">
    <div class="spread">
      <button class="icon-btn" data-act="go" data-to="#/" aria-label="Home">${icon.back}</button>
      <b>Lobby</b>
      <button class="icon-btn" data-act="sheet" data-kind="menu" aria-label="Menu">${icon.menu}</button>
    </div>
    <div class="panel qr-wrap">
      <div class="qr">${qrSvg(joinUrl(s.code))}</div>
      <div class="code-big">${esc(s.code)}</div>
      <div class="url-small">${esc(joinUrl(s.code))}</div>
    </div>
    <div class="section">
      <div class="section-head"><div><h2 class="h2">Seats</h2><span class="muted small">Sit clockwise in this order</span></div><button class="btn sm" data-act="shuffle">${icon.dice} Shuffle</button></div>
      <div class="seat-list">${list.map((p, i) => `<div ${seatArt(p)}>${seatRow(p, i, `
          <div class="seat-tools">
            ${p.id === store.playerId || !isOnline(p) ? `<button class="btn sm" data-act="sheet" data-kind="profile" data-id="${p.id}">Edit</button>` : p.id === s.hostId ? '<span class="tag" style="align-self:center;margin-right:6px">Host</span>' : ''}
            <button class="icon-btn" data-act="seat" data-id="${p.id}" data-dir="-1" ${i === 0 ? 'disabled' : ''} aria-label="Move up">${icon.up}</button>
            <button class="icon-btn" data-act="seat" data-id="${p.id}" data-dir="1" ${i === list.length - 1 ? 'disabled' : ''} aria-label="Move down">${icon.down}</button>
            ${(host || !isOnline(p)) && p.id !== store.playerId ? `<button class="icon-btn" data-act="kick" data-id="${p.id}" aria-label="Remove">${icon.x}</button>` : ''}
          </div>`)}</div>`).join('')}</div>
      <button class="btn block" data-act="sheet" data-kind="addPlayer">${icon.plus} Add a player without a phone</button>
    </div>
    <div class="section">
      <h2 class="h2">Starting life</h2>
      <div class="seg">${[20, 30, 40, 50, 60].map((n) => `<button class="${s.settings.startingLife === n ? 'on' : ''}" data-act="life" data-n="${n}">${n}</button>`).join('')}</div>
    </div>
    <button class="btn primary block big" data-act="sheet" data-kind="start">Start game</button>
  </div>`;
}

function qrSvg(text) {
  if (typeof window.qrcode !== 'function') return `<div style="color:#111;line-height:1.4;padding:20px;width:210px">QR unavailable. Use the code below.</div>`;
  const qr = window.qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  return qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
}

// ---------- views: game ----------

// Table-shaped layout: left neighbour bottom-left, right neighbour bottom-right,
// everyone across the table on the top row — like looking at the table from your seat.
function oppLayout(n) {
  if (n <= 3) return { cols: Math.max(n, 1), cells: Array.from({ length: n }, (_, i) => [1, i + 1]) };
  const cols = n - 2;
  return { cols, cells: [[2, 1], ...Array.from({ length: n - 2 }, (_, i) => [1, i + 1]), [2, cols]] };
}

function deltaBadge(id) {
  const d = store.deltas[id];
  if (!d || now() - d.t > DELTA_MS || !d.v) return '';
  const by = d.by && d.by !== store.playerId ? byId(d.by)?.name : '';
  return `<span class="delta ${d.v < 0 ? 'neg' : 'pos'}">${minus(d.v)}${by ? `<small>${esc(by)}</small>` : ''}</span>`;
}

function pills(p) {
  const out = [];
  if (lethal(p)) out.push('<span class="pill ko">Lethal</span>');
  if (p.monarch) out.push(`<span class="pill">${icon.crown}</span>`);
  if (p.poison) out.push(`<span class="pill ${p.poison >= LETHAL_POISON ? 'warn' : ''}">${icon.poison}${p.poison}</span>`);
  const c = maxCmdr(p);
  if (c) out.push(`<span class="pill ${c >= LETHAL_CMDR ? 'warn' : ''}">${icon.cmdr}${c}</span>`);
  return out.join('');
}

function viewGame() {
  const s = S();
  const g = s.game;
  const self = me();
  const opps = opponentsInOrder();
  const L = oppLayout(opps.length);
  const active = byId(g.activeId);
  const size = { 1: 32, 2: 27, 3: 23, 4: 16, 5: 12 }[L.cols] || 10;

  const oppHtml = opps.map((p, i) => {
    const [r, c] = L.cells[i];
    return `<div class="opp ${p.id === g.activeId ? 'active' : ''} ${isOut(p) ? 'out' : ''} ${p.card?.art ? 'has-art' : ''}" data-c="${p.color}" style="grid-row:${r};grid-column:${c};${artOf(p)}">
      ${p.id === g.activeId ? '<span class="turn-flag">Turn</span>' : ''}
      <button class="opp-head" data-act="sheet" data-kind="player" data-id="${p.id}">
        <span class="opp-name">${esc(p.name)}</span><span class="opp-cmdr">${esc(p.commander || ' ')}</span>
      </button>
      <button class="opp-life" data-act="sheet" data-kind="player" data-id="${p.id}" aria-label="${esc(p.name)} life ${p.life}">${p.life}${deltaBadge(p.id)}</button>
      <div>
        <div class="opp-counters">${pills(p)}</div>
        <div class="opp-pm">
          <button data-hold="1" data-target="${p.id}" data-field="life" data-delta="-1" aria-label="${esc(p.name)} minus one">−</button>
          <button data-hold="1" data-target="${p.id}" data-field="life" data-delta="1" aria-label="${esc(p.name)} plus one">+</button>
        </div>
      </div>
      ${isOut(p) ? '<div class="out-flag"><span>OUT</span></div>' : ''}
    </div>`;
  }).join('');

  const myTurn = g.activeId === self.id;
  const c = maxCmdr(self);
  let action;
  if (lethal(self)) action = `<button class="pass-btn warn wide" data-act="sheet" data-kind="player" data-id="${self.id}">You're at lethal. Concede?</button>`;
  else if (myTurn) action = `<button class="pass-btn wide" data-act="pass">Pass turn ${icon.next}</button>`;
  else action = `<div class="wide grid2"><button class="stat-btn" data-act="undo">${icon.undo}<span class="k">Undo</span></button><button class="stat-btn" data-act="sheet" data-kind="log">${icon.log}<span class="k">Log</span></button></div>`;

  return `<div class="game">
    <div class="topbar">
      <span class="turn-no">Turn ${g.turnNumber}</span>
      <button class="turn-now" data-act="sheet" data-kind="player" data-id="${active?.id || ''}" data-c="${active?.color || 'sky'}">
        <span class="dot"></span><span class="name">${active?.id === self.id ? 'Your turn' : esc(active?.name || '')}</span><span class="clock" data-clock="turn"></span>
      </button>
      ${active && active.id !== self.id && !isOnline(active) ? `<button class="pass-for" data-act="pass" aria-label="Pass ${esc(active.name)}'s turn">Pass ${icon.next}</button>` : ''}
      <button class="icon-btn" data-act="sheet" data-kind="menu" aria-label="Menu">${icon.menu}</button>
    </div>
    <div class="opps" style="--cols:${L.cols};--opp-size:${size}vw">${oppHtml}</div>
    <div class="me ${myTurn ? 'active' : ''} ${isOut(self) ? 'out' : ''} ${self.card?.art ? 'has-art' : ''}" data-c="${self.color}" style="${artOf(self)}">
      <div class="me-head">
        <button class="who" data-act="sheet" data-kind="player" data-id="${self.id}">
          <b>${esc(self.name)}</b><span>${esc(self.commander || 'Tap for all counters')}</span>
        </button>
        <div class="row" style="gap:6px">${self.monarch ? `<span class="pill">${icon.crown}</span>` : ''}${myTurn ? '<span class="your-turn">Your turn</span>' : ''}</div>
      </div>
      <div class="me-body">
        <div class="zone minus" data-hold="1" data-target="${self.id}" data-field="life" data-delta="-1">−</div>
        <div class="zone plus" data-hold="1" data-target="${self.id}" data-field="life" data-delta="1">+</div>
        <div class="me-life">${self.life}${deltaBadge(self.id)}</div>
        ${isOut(self) ? `<div class="me-out"><div><b>You're out</b><p class="muted">Place ${self.place}. You can still update everyone else.</p><button class="btn sm" data-act="revive" data-id="${self.id}">Undo elimination</button></div></div>` : ''}
      </div>
      <div class="me-foot">
        <button class="stat-btn ${self.poison >= LETHAL_POISON ? 'warn' : ''}" data-act="sheet" data-kind="player" data-id="${self.id}">${icon.poison}<span class="v">${self.poison}</span><span class="k">Poison</span></button>
        <button class="stat-btn ${c >= LETHAL_CMDR ? 'warn' : ''}" data-act="sheet" data-kind="player" data-id="${self.id}">${icon.cmdr}<span class="v">${c}</span><span class="k">Cmdr<br>damage</span></button>
        <button class="stat-btn" data-act="sheet" data-kind="table">${icon.table}<span class="k">Table<br>actions</span></button>
        ${action}
      </div>
    </div>
  </div>`;
}

// ---------- sheets ----------

function sheetPlayer({ id }) {
  const p = byId(id);
  if (!p || S().status !== 'playing') return null;
  const s = S();
  const self = p.id === store.playerId;
  const others = seats().filter((q) => q.id !== p.id);
  const step = (field, d, src = '') => `<button class="step ${d < 0 ? 'neg' : 'pos'}" data-hold="1" data-target="${p.id}" data-field="${field}" data-delta="${d}" data-source="${src}">${minus(d)}</button>`;
  return `
    ${sheetHead(`${esc(p.name)}${self ? ' (you)' : ''}`, esc(p.commander || `Seat ${p.seat + 1}`), p.color, p.card?.art)}
    <h4>Life</h4>
    <div class="life-edit">${step('life', -10)}${step('life', -5)}${step('life', -1)}
      <div class="v" style="${p.life <= 0 ? 'color:var(--danger)' : ''}">${p.life}</div>
      ${step('life', 1)}${step('life', 5)}${step('life', 10)}</div>
    <h4>Poison</h4>
    <div class="counter"><div class="lbl">${icon.poison}<span>Poison <em>/ ${LETHAL_POISON}</em></span></div>${step('poison', -1)}<div class="val ${p.poison >= LETHAL_POISON ? 'warn' : ''}">${p.poison}</div>${step('poison', 1)}</div>
    ${others.length ? `<h4>Commander damage taken (also removes life)</h4>
      ${others.map((q) => `<div class="counter"><div class="lbl" data-c="${q.color}"><span class="dot"></span><span class="two"><span>${esc(q.name)}</span>${q.commander ? `<small>${esc(q.commander)}</small>` : ''}</span></div>
        ${step('cmdr', -1, q.id)}<div class="val ${(p.cmdr[q.id] || 0) >= LETHAL_CMDR ? 'warn' : ''}">${p.cmdr[q.id] || 0}</div>${step('cmdr', 1, q.id)}</div>`).join('')}` : ''}
    <h4>Table</h4>
    <div class="grid2">
      <button class="btn" data-act="monarch" data-id="${p.id}">${p.monarch ? 'Not monarch' : 'Monarch'}</button>
      <button class="btn" data-act="setActive" data-id="${p.id}" ${s.game.activeId === p.id || isOut(p) ? 'disabled' : ''}>Give the turn</button>
    </div>
    <div style="margin-top:8px">${isOut(p)
      ? `<button class="btn block" data-act="revive" data-id="${p.id}">Undo elimination</button>`
      : `<button class="btn danger block" data-act="eliminate" data-id="${p.id}">${self ? 'I concede' : `Eliminate ${esc(p.name)}`}</button>`}</div>
    ${commanderCard(p, self)}`;
}

function commanderCard(p, self) {
  const img = safeImg(p.card?.image);
  const editable = self || !isOnline(p);
  if (!img && !editable) return '';
  return `<h4>Commander</h4>
    ${img ? `<a class="card-img" href="${esc(p.card.uri || '#')}" target="_blank" rel="noopener"><img src="${img}" alt="${esc(p.card.name)}" loading="lazy"></a>
      ${p.card.artist ? `<p class="muted small" style="text-align:center;margin:6px 0 0">Art by ${esc(p.card.artist)} · Scryfall</p>` : ''}` : ''}
    ${editable ? `<button class="btn block" style="margin-top:8px" data-act="sheet" data-kind="profile" data-id="${p.id}">${p.commander ? 'Change commander' : 'Choose commander'}</button>` : ''}`;
}

function sheetTable() {
  if (S().status !== 'playing') return null;
  const n = store.tableAmount;
  const opps = opponentsInOrder().filter((p) => !isOut(p));
  const poisoned = opps.filter((p) => p.poison > 0);
  const k = opps.length;
  const btn = (act, title, sub, cls = '', extra = '') => `<button class="tbl-btn ${extra}" data-act="table" data-op="${act}" ${act === 'proliferate' && !poisoned.length ? 'disabled' : ''}><b class="${cls}">${title}</b><span>${sub}</span></button>`;
  return `${sheetHead('Table actions', 'Applies to every player still in the game')}
    <div class="amount">
      <button data-act="amount" data-d="-1" aria-label="Less">−</button>
      <div class="v">${n}</div>
      <button data-act="amount" data-d="1" aria-label="More">+</button>
    </div>
    <div class="amount-quick">${[1, 2, 3, 5, 10].map((x) => `<button class="${x === n ? 'on' : ''}" data-act="amount" data-set="${x}">${x}</button>`).join('')}</div>
    <h4>Life</h4>
    <div class="grid2">
      ${btn('oppLose', `Opponents −${n}`, `${k} player${k === 1 ? '' : 's'} lose ${n}`, 'neg')}
      ${btn('allLose', `Everyone −${n}`, 'You included', 'neg')}
      ${btn('oppGain', `Opponents +${n}`, `${k} player${k === 1 ? '' : 's'} gain ${n}`, 'pos')}
      ${btn('allGain', `Everyone +${n}`, 'You included', 'pos')}
      ${btn('drain', `Drain ${n}`, `Opponents lose ${n}, you gain ${n * k}`, '', 'wide')}
    </div>
    <h4>Poison</h4>
    <div class="grid2">
      ${btn('oppPoison', `Opponents +${n} poison`, `${k} player${k === 1 ? '' : 's'}`)}
      ${btn('proliferate', 'Proliferate', poisoned.length ? `+1 poison to ${poisoned.map((p) => esc(p.name)).join(', ')}` : 'No opponent has poison')}
    </div>
    <p class="muted small" style="margin:14px 0 0">Undo reverts a table action in one tap. Life your actions take from opponents counts as your damage in the stats.</p>`;
}

function sheetMenu() {
  const s = S();
  const host = s.hostId === store.playerId;
  const playing = s.status === 'playing';
  const idleLeft = s.idleMinutes * 60000 - (now() - s.lastActivity);
  return `${sheetHead(`Table ${esc(s.code)}`, playing ? `Game time <span data-clock="game"></span>` : `Closes after ${s.idleMinutes} min without activity`)}
    <div class="section" style="gap:8px">
      <button class="btn block" data-act="sheet" data-kind="invite">Show QR code</button>
      ${playing ? `<button class="btn block" data-act="undo">${icon.undo} Undo my last change</button>
        <button class="btn block" data-act="sheet" data-kind="log">${icon.log} Game log</button>
        <button class="btn block" data-act="sheet" data-kind="end">End game</button>` : ''}
      <button class="btn block" data-act="go" data-to="#/stats">Stats and past games</button>
      <button class="btn ghost block" data-act="leave">Leave on this phone</button>
      ${host ? `<button class="btn danger block" data-act="closeSession">Close the table for everyone</button>` : ''}
      <p class="muted small" style="text-align:center;margin:4px 0 0">Auto-closes in ${dur(Math.max(0, idleLeft))} if nobody plays</p>
    </div>`;
}

function sheetInvite() {
  const s = S();
  return `${sheetHead('Invite')}
    <div class="qr-wrap"><div class="qr">${qrSvg(joinUrl(s.code))}</div><div class="code-big">${esc(s.code)}</div>
    <div class="url-small">${esc(joinUrl(s.code))}</div>
    ${s.status === 'playing' ? '<p class="muted small">During a game, people can rejoin their own seat.</p>' : ''}</div>`;
}

function describe(e, names) {
  const n = (id) => `<span class="who-tag" data-c="${byId(id)?.color || ''}">${esc(names(id))}</span>`;
  if (e.kind === 'adjust') {
    const what = e.field === 'life' ? '' : e.field === 'poison' ? ' poison' : ` cmdr damage from ${n(e.source)}`;
    const by = e.by !== e.target && !e.group && !(e.field === 'cmdr' && e.by === e.source) ? ` <span class="by">by ${esc(names(e.by))}</span>` : '';
    return { text: `${n(e.target)}${what}${by}`, d: e.field === 'cmdr' ? -e.delta : e.delta, poison: e.field === 'poison' };
  }
  if (e.kind === 'table') return { text: `${n(e.by)}: ${esc(e.label)}`, group: true };
  if (e.kind === 'eliminate') return { text: `${n(e.target)} is out` };
  if (e.kind === 'revive') return { text: `${n(e.target)} is back in` };
  if (e.kind === 'monarch') return { text: `${n(e.target)} ${e.on ? 'became' : 'is no longer'} the monarch` };
  if (e.kind === 'start') return { text: `Game started. ${n(e.target)} goes first` };
  return { text: e.kind };
}

function logRows(log, startedAt, names) {
  // Newest first, but a table action's header stays above the changes it caused.
  const out = [];
  for (let i = log.length - 1; i >= 0; i--) {
    const e = log[i];
    if (e.group && e.kind === 'adjust') continue;
    if (e.kind === 'table') { out.push(e, ...log.filter((x) => x.group === e.group && x.kind === 'adjust')); continue; }
    out.push(e);
  }
  return out.slice(0, 150).map((e) => {
    const x = describe(e, names);
    const val = x.d === undefined ? '' : `<span class="d ${(x.poison ? -x.d : x.d) < 0 ? 'neg' : 'pos'}">${minus(x.d)}${x.poison ? ' ☣' : ''}</span>`;
    const t = e.group && e.kind === 'adjust' ? '' : `T${e.turn ?? ''} · ${clock(e.t - startedAt)}`;
    return `<div class="log-row ${x.group ? 'group' : ''}"><span class="t">${t}</span><span${e.group && e.kind === 'adjust' ? ' style="padding-left:12px"' : ''}>${x.text}</span>${val}</div>`;
  }).join('');
}

function sheetLog() {
  const g = S().game;
  if (!g) return null;
  const rows = logRows(g.log, g.startedAt, (id) => byId(id)?.name || '?');
  return `${sheetHead('Game log', `${g.log.length} events`)}<div class="log">${rows || '<div class="empty">Nothing yet</div>'}</div>`;
}

function sheetEnd() {
  const left = seats().filter((p) => !isOut(p));
  return `${sheetHead('End game', 'Who won?')}
    <div class="section" style="gap:8px">${left.map((p) => `<button class="btn fill block big" data-c="${p.color}" data-act="endGame" data-id="${p.id}">${esc(p.name)}</button>`).join('')}
    <button class="btn ghost block" data-act="endGame" data-id="">Draw / no winner</button></div>`;
}

function sheetProfile({ id }) {
  const p = id ? byId(id) : me();
  if (!p) return null;
  const self = p.id === store.playerId;
  const taken = S().players.filter((q) => q.id !== p.id).map((q) => q.color);
  return `${sheetHead(self ? 'Your seat' : esc(p.name), self ? '' : 'Editing from your phone')}
    <form class="section" data-form="profile"><input type="hidden" name="target" value="${self ? '' : p.id}">
      ${profileFields(taken, p)}<button class="btn primary block big" type="submit">Save</button></form>`;
}

function sheetAddPlayer() {
  if (S().status !== 'lobby') return null;
  const taken = S().players.map((q) => q.color);
  return `${sheetHead('Add a player', 'For someone without a phone')}
    <form class="section" data-form="addPlayer">${profileFields(taken, {}, 'Their name')}
      <p class="muted small" style="margin:0">Everyone can update their life. If they get a phone later, they open the link and tap this seat.</p>
      <button class="btn primary block big" type="submit">Add to the table</button></form>`;
}

function sheetStart() {
  return `${sheetHead('Who goes first?')}
    <div class="section" style="gap:8px">
      <button class="btn primary block big" data-act="start" data-id="">${icon.dice} Random</button>
      ${seats().map((p) => `<button class="btn fill block" data-c="${p.color}" data-act="start" data-id="${p.id}">${esc(p.name)}</button>`).join('')}
    </div>`;
}

// ---------- summary (live end screen + archived games) ----------

function summarize(g) {
  // g: { players, log, turns, startedAt, endedAt, winnerId, startingLife }
  const life = Object.fromEntries(g.players.map((p) => [p.id, g.startingLife]));
  const series = Object.fromEntries(g.players.map((p) => [p.id, [[0, g.startingLife]]]));
  const dealt = {}, kos = {}, lastHit = {};
  for (const e of g.log) {
    if (e.kind === 'adjust' && (e.field === 'life' || e.field === 'cmdr')) {
      const d = e.field === 'life' ? e.delta : -e.delta;
      life[e.target] += d;
      series[e.target]?.push([e.t - g.startedAt, life[e.target]]);
      if (e.source && e.source !== e.target && d < 0) { dealt[e.source] = (dealt[e.source] || 0) - d; lastHit[e.target] = e.source; }
    }
    if (e.kind === 'eliminate' && lastHit[e.target]) kos[lastHit[e.target]] = (kos[lastHit[e.target]] || 0) + 1;
  }
  const end = (g.endedAt || now()) - g.startedAt;
  for (const id in series) series[id].push([end, life[id]]);
  const turnTime = {};
  for (const t of g.turns) if (t.end) { const x = turnTime[t.playerId] || (turnTime[t.playerId] = { ms: 0, n: 0 }); x.ms += t.end - t.start; x.n += 1; }
  return { series, dealt, kos, turnTime, end };
}

function lifeChart(g, sum) {
  const W = 340, H = 180, P = { l: 28, r: 8, t: 10, b: 22 };
  const all = Object.values(sum.series).flat();
  const maxY = Math.max(g.startingLife, ...all.map((x) => x[1]));
  const minY = Math.min(0, ...all.map((x) => x[1]));
  const X = (t) => P.l + (t / Math.max(sum.end, 1)) * (W - P.l - P.r);
  const Y = (v) => P.t + (1 - (v - minY) / Math.max(maxY - minY, 1)) * (H - P.t - P.b);
  const lines = g.players.map((p) => {
    const pts = sum.series[p.id];
    // step line: life holds until the next change
    let d = `M${X(pts[0][0]).toFixed(1)},${Y(pts[0][1]).toFixed(1)}`;
    for (let i = 1; i < pts.length; i++) d += `H${X(pts[i][0]).toFixed(1)}V${Y(pts[i][1]).toFixed(1)}`;
    return `<path d="${d}" fill="none" data-c="${p.color}" style="stroke:var(--hi)" stroke-width="2.5" stroke-linejoin="round"/>`;
  }).join('');
  const ticks = [minY, Math.round((minY + maxY) / 2), maxY];
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Life totals over time">
    ${ticks.map((v) => `<line class="axis" x1="${P.l}" x2="${W - P.r}" y1="${Y(v)}" y2="${Y(v)}" stroke-dasharray="${v === 0 ? '' : '2 4'}"/><text x="${P.l - 6}" y="${Y(v) + 4}" text-anchor="end">${v}</text>`).join('')}
    <text x="${P.l}" y="${H - 4}">0:00</text><text x="${W - P.r}" y="${H - 4}" text-anchor="end">${clock(sum.end)}</text>
    ${lines}</svg>
    <div class="legend">${g.players.map((p) => `<span data-c="${p.color}"><span class="dot"></span>${esc(p.name)}</span>`).join('')}</div>`;
}

function summaryBody(g) {
  const sum = summarize(g);
  const winner = g.players.find((p) => p.id === g.winnerId);
  const ranked = [...g.players].sort((a, b) => (a.place || 99) - (b.place || 99) || b.finalLife - a.finalLife);
  const turnsDone = g.turns.filter((t) => t.end);
  const avgTurn = turnsDone.length ? turnsDone.reduce((a, t) => a + t.end - t.start, 0) / turnsDone.length : 0;
  return `
    <div class="winner" data-c="${winner?.color || 'sky'}">
      <div class="cap">${winner ? 'Winner' : 'Game over'}</div>
      <h2>${winner ? esc(winner.name) : 'Draw'}</h2>
      <div class="sub">${esc(winner?.commander || '')}</div>
    </div>
    <div class="kpis">
      <div class="kpi"><span class="cap">Length</span><b>${dur(sum.end)}</b></div>
      <div class="kpi"><span class="cap">Turns</span><b>${g.turns.length}</b></div>
      <div class="kpi"><span class="cap">Avg turn</span><b>${clock(avgTurn)}</b></div>
    </div>
    <div class="panel"><h2 class="h2" style="margin-bottom:10px">Life over time</h2>${lifeChart(g, sum)}</div>
    <div class="panel">
      <table class="t"><thead><tr><th></th><th>Player</th><th class="r">Life</th><th class="r">Dealt</th><th class="r">KOs</th><th class="r">Turn</th></tr></thead><tbody>
      ${ranked.map((p) => { const tt = sum.turnTime[p.id]; return `<tr><td class="place">${p.place || '–'}</td>
        <td><div class="row" style="gap:8px" data-c="${p.color}"><span class="dot"></span><div style="min-width:0"><div>${esc(p.name)}</div><div class="sub">${esc(p.commander || '')}</div></div></div></td>
        <td class="r n">${p.finalLife}</td><td class="r n">${sum.dealt[p.id] || 0}</td><td class="r n">${sum.kos[p.id] || 0}</td><td class="r">${tt ? clock(tt.ms / tt.n) : '–'}</td></tr>`; }).join('')}
      </tbody></table>
      <p class="muted small" style="margin:10px 0 0">Dealt counts life a player took from others on their phone, plus commander damage.</p>
    </div>`;
}

function viewEnded() {
  const s = S();
  const g = { ...s.game, startingLife: s.settings.startingLife, players: s.players.map((p) => ({ ...p, finalLife: p.life })) };
  const host = s.hostId === store.playerId;
  return `<div class="page">
    <div class="spread"><b>Table ${esc(s.code)}</b><button class="icon-btn" data-act="sheet" data-kind="menu" aria-label="Menu">${icon.menu}</button></div>
    ${summaryBody(g)}
    <button class="btn primary block big" data-act="sheet" data-kind="start">Rematch, same seats</button>
    <button class="btn block" data-act="backToLobby">Back to lobby</button>
    ${host ? '<button class="btn danger block" data-act="closeSession">Close the table</button>' : ''}
  </div>`;
}

function viewGameRecord() {
  const g = store.gameRecord;
  return `<div class="page">
    <div class="spread"><button class="icon-btn" data-act="back" aria-label="Back">${icon.back}</button><span class="muted">${g ? new Date(g.endedAt).toLocaleString() : 'Loading…'}</span><span style="width:44px"></span></div>
    ${g ? summaryBody(g) : ''}
  </div>`;
}

function viewStats() {
  const st = store.stats;
  const head = `<div class="spread"><button class="icon-btn" data-act="back" aria-label="Back">${icon.back}</button><h1 class="h1" style="font-size:32px">Stats</h1><a class="btn sm ghost" href="/api/games" download>Export</a></div>`;
  if (!st) return `<div class="page">${head}<div class="empty">Loading…</div></div>`;
  if (!st.games) return `<div class="page">${head}<div class="panel empty">No finished games yet.<br>Play one and the numbers show up here.</div></div>`;
  return `<div class="page">${head}
    <div class="kpis">
      <div class="kpi"><span class="cap">Games</span><b>${st.games}</b></div>
      <div class="kpi"><span class="cap">Avg length</span><b>${dur(st.avgDurationMs)}</b></div>
      <div class="kpi"><span class="cap">Avg turns</span><b>${Math.round(st.avgTurns)}</b></div>
    </div>
    <div class="panel"><h2 class="h2" style="margin-bottom:8px">Players</h2>
      <table class="t"><thead><tr><th>Player</th><th class="r">Wins</th><th class="r">Win %</th><th class="r">Dealt</th><th class="r">KOs</th></tr></thead><tbody>
      ${st.players.map((p) => `<tr><td><div>${esc(p.name)}</div><div class="sub">${esc(p.favorite)}${p.avgTurnMs ? ` · ${clock(p.avgTurnMs)}/turn` : ''}</div></td><td class="r n">${p.wins}<span class="sub">/${p.games}</span></td><td class="r n">${pct(p.winRate)}</td><td class="r n">${p.damage}</td><td class="r n">${p.kos}</td></tr>`).join('')}
      </tbody></table></div>
    ${st.commanders.length ? `<div class="panel"><h2 class="h2" style="margin-bottom:8px">Commanders</h2>
      <table class="t"><thead><tr><th>Commander</th><th class="r">Games</th><th class="r">Wins</th><th class="r">Win %</th></tr></thead><tbody>
      ${st.commanders.map((c) => `<tr><td><div class="row" style="gap:10px">${artVar(c.art) ? `<span class="thumb" style="${artVar(c.art)}"></span>` : ''}<span>${esc(c.commander)}</span></div></td><td class="r n">${c.games}</td><td class="r n">${c.wins}</td><td class="r n">${pct(c.wins / c.games)}</td></tr>`).join('')}
      </tbody></table></div>` : ''}
    <div class="panel"><h2 class="h2">Recent games</h2>
      ${st.recent.map((g) => `<button class="game-row" data-act="go" data-to="#/g/${g.id}">
        <div style="min-width:0"><div style="font-weight:600">${g.winner ? esc(g.winner) + ' won' : 'Draw'}</div><div class="muted small">${g.players.map((p) => esc(p.name)).join(', ')}</div></div>
        <div style="text-align:right;flex:none"><div>${dur(g.durationMs)} · ${g.turns} turns</div><div class="muted small">${new Date(g.endedAt).toLocaleDateString()}</div></div>
      </button>`).join('')}
    </div>
  </div>`;
}

// ---------- commander search (Scryfall) ----------

const cmdrSearch = { timer: null, ctl: null, results: [] };
const PIPS = 'WUBRG';

function syncCmdrField(f) {
  const input = f.elements.commander;
  if (!input || !f.elements.card) return;
  const card = parseCard(f.elements.card.value);
  // Editing the text after picking drops the card; only an exact pick carries art.
  const ok = card && card.name === input.value;
  if (!ok) f.elements.card.value = '';
  const box = input.closest('.cmdr-input');
  box.classList.toggle('picked', !!ok);
  box.style.cssText = ok ? artVar(card.art) : '';
}

function toCard(c) {
  const face = c.card_faces?.[0] || {};
  const img = c.image_uris || face.image_uris || {};
  return {
    name: (face.name || c.name).slice(0, 80),
    art: img.art_crop || null, image: img.normal || null,
    colors: c.color_identity || [], uri: c.scryfall_uri || null,
    artist: face.artist || c.artist || '', type: (face.type_line || c.type_line || '').replace('Legendary ', ''),
  };
}

async function searchCommanders(text, signal) {
  const words = text.toLowerCase().replace(/[^\p{L}\p{N}' ]+/gu, ' ').split(/\s+/).filter(Boolean).slice(0, 6);
  if (words.join('').length < 2) return null;
  const q = `is:commander legal:commander ${words.map((w) => `name:"${w}"`).join(' ')}`;
  const res = await fetch(`https://api.scryfall.com/cards/search?order=edhrec&q=${encodeURIComponent(q)}`, { signal, headers: { Accept: 'application/json' } });
  if (res.status === 404) return []; // Scryfall's "no cards matched"
  if (!res.ok) throw new Error(`Scryfall ${res.status}`);
  const cards = (await res.json()).data.map(toCard);
  // Scryfall ranks by popularity; put names whose words start with what was typed first.
  const starts = (c) => words.every((w) => c.name.toLowerCase().split(/[\s,'-]+/).some((n) => n.startsWith(w)));
  return [...cards.filter(starts), ...cards.filter((c) => !starts(c))].slice(0, 8);
}

function showCmdrResults(input, html) {
  const box = input.closest('.field').querySelector('.cmdr-results');
  box.innerHTML = html;
}

function cmdrOptions(cards) {
  if (!cards.length) return '<div class="cmdr-note">No legal commander with that name</div>';
  return cards.map((c, i) => `<button type="button" class="cmdr-opt" data-act="pickCmdr" data-i="${i}" role="option">
    <span class="thumb" style="${artVar(c.art)}"></span>
    <span class="t"><b>${esc(c.name)}</b><small>${esc(c.type)}</small></span>
    <span class="pips">${c.colors.length ? PIPS.split('').filter((x) => c.colors.includes(x)).map((x) => `<i class="pip ${x}"></i>`).join('') : '<i class="pip C"></i>'}</span>
  </button>`).join('');
}

document.addEventListener('input', (e) => {
  const input = e.target.closest('[data-cmdr]');
  if (!input) return;
  syncCmdrField(input.form);
  clearTimeout(cmdrSearch.timer);
  cmdrSearch.ctl?.abort();
  const text = input.value.trim();
  if (text.length < 2) { showCmdrResults(input, ''); return; }
  cmdrSearch.timer = setTimeout(async () => {
    const ctl = (cmdrSearch.ctl = new AbortController());
    try {
      const cards = await searchCommanders(text, ctl.signal);
      if (ctl.signal.aborted || !cards) return;
      cmdrSearch.results = cards;
      showCmdrResults(input, cmdrOptions(cards));
    } catch (err) {
      if (err.name !== 'AbortError') showCmdrResults(input, '<div class="cmdr-note">Card search is offline. The name is saved as typed.</div>');
    }
  }, 220);
});

document.addEventListener('keydown', (e) => {
  const input = e.target.closest('[data-cmdr]');
  if (!input) return;
  const first = input.closest('.field').querySelector('.cmdr-opt');
  if (e.key === 'Enter' && first) { e.preventDefault(); first.click(); }
  if (e.key === 'Escape') showCmdrResults(input, '');
});
// Picking a result shouldn't blur the input first (that would close the keyboard and shift the list).
document.addEventListener('mousedown', (e) => { if (e.target.closest('.cmdr-opt')) e.preventDefault(); });
document.addEventListener('focusout', (e) => {
  const input = e.target.closest?.('[data-cmdr]');
  if (input) setTimeout(() => { if (document.activeElement !== input && input.isConnected) showCmdrResults(input, ''); }, 200);
});

// ---------- events ----------

function tableOps(op) {
  const n = store.tableAmount;
  const self = me();
  const opps = opponentsInOrder().filter((p) => !isOut(p));
  const all = seats().filter((p) => !isOut(p));
  const life = (list, d) => list.map((p) => ({ target: p.id, field: 'life', delta: d }));
  switch (op) {
    case 'oppLose': return [`Opponents lose ${n}`, life(opps, -n)];
    case 'allLose': return [`Everyone loses ${n}`, life(all, -n)];
    case 'oppGain': return [`Opponents gain ${n}`, life(opps, n)];
    case 'allGain': return [`Everyone gains ${n}`, life(all, n)];
    case 'drain': return [`Drain ${n}`, [...life(opps, -n), { target: self.id, field: 'life', delta: n * opps.length }]];
    case 'oppPoison': return [`Opponents get ${n} poison`, opps.map((p) => ({ target: p.id, field: 'poison', delta: n }))];
    case 'proliferate': return ['Proliferate', opps.filter((p) => p.poison > 0).map((p) => ({ target: p.id, field: 'poison', delta: 1 }))];
    default: return [null, []];
  }
}

const actions = {
  go: (d) => go(d.to),
  back: () => {
    if (history.state?.inApp) return history.back();
    // Nothing of ours behind this page: swap it for its parent instead of stacking a new entry.
    history.replaceState(null, '', parentHash());
    route();
  },
  home: () => go('#/'),
  resume: (d) => go(`#/s/${d.code}`),
  closeSheet: () => { store.sheet = null; renderSheet(); },
  sheet: (d) => { if (d.kind === 'player' && !d.id) return; openSheet(d.kind, d.id); },
  pickColor: (d, el) => {
    const form = el.closest('form');
    form.querySelectorAll('.swatch').forEach((s) => { s.classList.toggle('on', s === el); s.innerHTML = s === el ? icon.check : ''; });
    form.querySelector('[name=color]').value = d.color;
  },
  pickCmdr: (d, el) => {
    const card = cmdrSearch.results[Number(d.i)];
    const f = el.closest('form');
    if (!card || !f) return;
    f.elements.commander.value = card.name;
    f.elements.card.value = JSON.stringify(card);
    syncCmdrField(f);
    showCmdrResults(f.elements.commander, '');
    f.elements.commander.blur();
  },
  claim: (d) => {
    const p = byId(d.id);
    if (isOnline(p) && !confirm(`${p.name} is already on a phone. Use this seat here too?`)) return;
    store.playerId = d.id;
    ls.set(`lc.player.${store.code}`, d.id);
    ls.set('lc.last', store.code);
    connect(store.code);
    render();
  },
  seat: (d) => {
    const ids = seats().map((p) => p.id);
    const i = ids.indexOf(d.id), j = i + Number(d.dir);
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    send({ type: 'seats', order: ids });
  },
  shuffle: () => send({ type: 'shuffleSeats' }),
  kick: (d) => { if (confirm(`Remove ${byId(d.id)?.name}?`)) send({ type: 'kick', target: d.id }); },
  life: (d) => send({ type: 'settings', startingLife: Number(d.n) }),
  start: (d) => { store.sheet = null; send({ type: 'start', firstId: d.id || undefined }); keepAwake(); },
  // `turn` makes a double tap (or two phones passing at once) end only one turn.
  pass: () => { buzz(15); send({ type: 'passTurn', turn: S().game.turnNumber }); },
  setActive: (d) => { store.sheet = null; send({ type: 'setActive', target: d.id }); },
  monarch: (d) => send({ type: 'monarch', target: d.id }),
  eliminate: (d) => { store.sheet = null; send({ type: 'eliminate', target: d.id }); },
  revive: (d) => send({ type: 'revive', target: d.id }),
  undo: () => { store.sheet = null; buzz(15); send({ type: 'undo' }); },
  amount: (d) => { store.tableAmount = d.set ? Number(d.set) : Math.max(1, Math.min(99, store.tableAmount + Number(d.d))); renderSheet(); },
  table: (d) => { const [label, ops] = tableOps(d.op); if (label) bulk(label, ops); },
  endGame: (d) => { store.sheet = null; send({ type: 'end', winnerId: d.id || undefined }); },
  backToLobby: () => send({ type: 'backToLobby' }),
  leave: () => {
    if (!confirm('Leave this table on this phone? You can rejoin your seat later.')) return;
    ls.del(`lc.player.${store.code}`);
    ls.del('lc.last');
    disconnect();
    store.code = null;
    go('#/');
  },
  closeSession: () => { if (confirm('Close the table for everyone? A game in progress is saved as abandoned.')) { ls.del('lc.last'); send({ type: 'close' }); } },
};

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled) return;
  actions[el.dataset.act]?.(el.dataset, el);
});

const forms = {
  addPlayer(f) {
    store.sheet = null;
    document.activeElement?.blur();
    send({ type: 'addPlayer', ...Object.fromEntries(new FormData(f)) });
  },
  async create(f) {
    const body = Object.fromEntries(new FormData(f));
    ls.set('lc.profile', body);
    const { code, playerId, state } = await api('POST', '/api/sessions', body);
    ls.set(`lc.player.${code}`, playerId);
    ls.set('lc.last', code);
    store.code = code; store.playerId = playerId; store.state = state;
    connect(code);
    go(`#/s/${code}`);
  },
  joinCode(f) { go(`#/s/${String(new FormData(f).get('code')).trim().toUpperCase()}`); },
  async join(f) {
    const body = Object.fromEntries(new FormData(f));
    ls.set('lc.profile', body);
    const { playerId, state } = await api('POST', `/api/sessions/${store.code}/join`, body);
    store.playerId = playerId;
    ls.set(`lc.player.${store.code}`, playerId);
    ls.set('lc.last', store.code);
    adopt(state);
    connect(store.code);
  },
  profile(f) {
    const { target, ...body } = Object.fromEntries(new FormData(f));
    if (!target) ls.set('lc.profile', body);
    if (target) body.target = target;
    store.sheet = null;
    document.activeElement?.blur();
    send({ type: 'profile', ...body });
  },
};

document.addEventListener('submit', (e) => {
  const f = e.target.closest('[data-form]');
  if (!f) return;
  e.preventDefault();
  Promise.resolve(forms[f.dataset.form]?.(f)).catch((err) => toast(err.message));
});

// Hold-to-repeat on every +/- control: one step on press, then accelerating repeats.
let hold = null;
function stopHold() { if (hold) { clearTimeout(hold.timer); hold = null; } }
document.addEventListener('pointerdown', (e) => {
  const el = e.target.closest('[data-hold]');
  if (!el) return;
  e.preventDefault();
  keepAwake();
  const d = { ...el.dataset };
  const fire = () => adjust(d.target, d.field, Number(d.delta), d.source || null);
  fire();
  let n = 0;
  hold = { x: e.clientX, y: e.clientY, timer: setTimeout(function rep() { n += 1; fire(); if (hold) hold.timer = setTimeout(rep, n > 10 ? 70 : 140); }, 450) };
});
document.addEventListener('pointermove', (e) => { if (hold && Math.hypot(e.clientX - hold.x, e.clientY - hold.y) > 14) stopHold(); });
['pointerup', 'pointercancel', 'blur'].forEach((ev) => window.addEventListener(ev, stopHold));
document.addEventListener('contextmenu', (e) => { if (e.target.closest('[data-hold]')) e.preventDefault(); });

// ---------- boot ----------

api('GET', '/api/info').then((i) => { store.info = i; render(); }).catch(() => {});
route();
