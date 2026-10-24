// Lifecount client. Vanilla JS, no build step.
// State flows one way: server state -> store.state -> render(). Taps are applied
// optimistically, sent as actions, and reconciled when the server echoes back.

const $app = document.getElementById('app');
const $sheet = document.getElementById('sheet-root');
const $toast = document.getElementById('toast');

const COLORS = ['amber', 'sky', 'violet', 'crimson', 'jade', 'teal', 'orange', 'rose'];
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
  sheet: null, // { kind, id? }
  deltas: {}, // playerId -> { v, t, by }
  stats: null,
  gameRecord: null,
  error: null,
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

// ---------- derived state ----------

const S = () => store.state;
const me = () => S()?.players.find((p) => p.id === store.playerId);
const byId = (id) => S()?.players.find((p) => p.id === id);
const seats = () => [...S().players].sort((a, b) => a.seat - b.seat);
const isOut = (p) => !!p.eliminatedAt;
const maxCmdr = (p) => Math.max(0, ...Object.values(p.cmdr || {}));
const lethal = (p) => !isOut(p) && (p.life <= 0 || p.poison >= LETHAL_POISON || maxCmdr(p) >= LETHAL_CMDR);

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
}

function disconnect() {
  store.es?.close();
  store.es = null;
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

// Optimistic mirror of the server's adjust() for instant feedback.
function adjust(target, field, delta, source) {
  const p = byId(target);
  if (!p || S().status !== 'playing') return;
  if (field === 'life') { p.life += delta; bumpDelta(target, delta, store.playerId); }
  if (field === 'poison') { if (p.poison + delta < 0) return; p.poison += delta; }
  if (field === 'cmdr') {
    const cur = p.cmdr[source] || 0;
    if (cur + delta < 0) return;
    p.cmdr[source] = cur + delta;
    p.life -= delta;
    bumpDelta(target, -delta, store.playerId);
  }
  buzz();
  render();
  send({ type: 'adjust', target, field, delta, source: source || undefined });
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
        store.state = { status: 'closed', closedReason: e.status === 404 ? 'session not found' : e.message, players: [] };
      }
    }
  }
  if (r.name === 'stats') { store.stats = null; render(); api('GET', '/api/stats').then((s) => { store.stats = s; render(); }).catch((e) => toast(e.message)); }
  if (r.name === 'game') { store.gameRecord = null; render(); api('GET', `/api/games/${r.id}`).then((g) => { store.gameRecord = g; render(); }).catch((e) => toast(e.message)); }
  render();
}
window.addEventListener('hashchange', route);
const go = (hash) => { location.hash = hash; };

// ---------- render ----------

function render() {
  const r = store.route || { name: 'home' };
  let html = '';
  if (r.name === 'home') html = viewHome();
  else if (r.name === 'stats') html = viewStats();
  else if (r.name === 'game') html = viewGameRecord();
  else if (r.name === 'session') {
    const s = S();
    if (!s) html = `<div class="page"><div class="empty mono">connecting to ${esc(store.code)}…</div></div>`;
    else if (s.status === 'closed') html = viewClosed();
    else if (!me()) html = viewJoin();
    else if (s.status === 'lobby') html = viewLobby();
    else if (s.status === 'playing') html = viewGame();
    else if (s.status === 'ended') html = viewEnded();
  }
  $app.innerHTML = html;
  renderSheet();
  tick();
}

function renderSheet() {
  // Don't clobber an input the user is typing into.
  if ($sheet.contains(document.activeElement) && document.activeElement.matches('input')) return;
  const sh = store.sheet;
  if (!sh || !S() || S().status === 'closed') { $sheet.innerHTML = ''; return; }
  const body = {
    player: sheetPlayer, menu: sheetMenu, invite: sheetInvite, log: sheetLog, end: sheetEnd, profile: sheetProfile, start: sheetStart,
  }[sh.kind]?.(sh);
  if (!body) { store.sheet = null; $sheet.innerHTML = ''; return; }
  const enter = sh.fresh ? ' enter' : '';
  sh.fresh = false;
  $sheet.innerHTML = `<div class="backdrop${enter}" data-act="closeSheet"></div><div class="sheet${enter}" role="dialog"><div class="grab"></div>${body}</div>`;
}

function openSheet(kind, id) { store.sheet = { kind, id, fresh: true }; renderSheet(); }

// Live clocks update in place every second instead of re-rendering everything.
function tick() {
  const g = S()?.game;
  document.querySelectorAll('[data-clock="turn"]').forEach((el) => { el.textContent = g?.turnStartedAt ? clock(now() - g.turnStartedAt) : '—'; });
  document.querySelectorAll('[data-clock="game"]').forEach((el) => { el.textContent = g?.startedAt ? clock((g.endedAt || now()) - g.startedAt) : '—'; });
}
setInterval(tick, 1000);

// ---------- views: home / join / closed ----------

const icon = {
  menu: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7h16M4 12h16M4 17h16"/></svg>',
  up: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 15 6-6 6 6"/></svg>',
  down: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>',
  x: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  back: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>',
};

function profileFields(taken = []) {
  const p = ls.get('lc.profile', {});
  const color = p.color && !taken.includes(p.color) ? p.color : COLORS.find((c) => !taken.includes(c));
  return `
    <label class="field"><span class="label">Your name</span>
      <input class="input" name="name" maxlength="20" autocomplete="nickname" required value="${esc(p.name || '')}" placeholder="e.g. Tommaso"></label>
    <label class="field"><span class="label">Commander <span style="opacity:.6">· optional</span></span>
      <input class="input" name="commander" maxlength="40" value="${esc(p.commander || '')}" placeholder="e.g. Atraxa, Praetors' Voice"></label>
    <div class="field"><span class="label">Color</span>
      <div class="swatches">${COLORS.map((c) => `<button type="button" class="swatch ${c === color ? 'on' : ''} ${taken.includes(c) ? 'taken' : ''}" data-c="${c}" data-act="pickColor" data-color="${c}" aria-label="${c}"></button>`).join('')}</div>
      <input type="hidden" name="color" value="${color}"></div>`;
}

function viewHome() {
  const last = ls.get('lc.last');
  return `<div class="page stack">
    <div class="brand">
      <img src="/icon.svg" alt="">
      <div><h1>Lifecount</h1><p class="label">commander · synced across the table</p>
        <div class="mana-row">${['amber', 'sky', 'violet', 'crimson', 'jade'].map((c) => `<span style="background:var(--${c})"></span>`).join('')}</div></div>
    </div>
    ${last ? `<button class="btn block" data-act="resume" data-code="${esc(last)}"><span class="label" style="color:inherit">resume</span> <span class="mono">${esc(last)}</span></button>` : ''}
    <form class="card stack" data-form="create">
      <div class="spread"><h2 class="h">New table</h2><span class="label">you host</span></div>
      ${profileFields()}
      <button class="btn primary block" type="submit">Create session</button>
    </form>
    <div class="divider label">or join</div>
    <form class="card stack" data-form="joinCode">
      <input class="input code" name="code" maxlength="4" autocomplete="off" autocapitalize="characters" placeholder="CODE" required>
      <button class="btn block" type="submit">Join with code</button>
      <p class="label" style="text-align:center;margin:0">or just scan the host's QR</p>
    </form>
    <button class="btn ghost block" data-act="go" data-to="#/stats">Stats & history →</button>
  </div>`;
}

function viewJoin() {
  const s = S();
  if (s.status === 'lobby') {
    return `<div class="page stack">
      <div class="brand"><img src="/icon.svg" alt=""><div><h1>Join <span class="mono">${esc(s.code)}</span></h1>
        <p class="label">${s.players.length} at the table · ${s.settings.startingLife} life</p></div></div>
      <div class="card"><div class="seat-list">${seats().map((p) => `<div class="seat" data-c="${p.color}"><span class="n">${p.seat + 1}</span><div class="who"><b>${esc(p.name)}</b><small>${esc(p.commander || '—')}</small></div><span></span></div>`).join('')}</div></div>
      <form class="card stack" data-form="join">${profileFields(s.players.map((p) => p.color))}
        <button class="btn primary block" type="submit">Take a seat</button></form>
    </div>`;
  }
  // Mid-game: claim an existing seat (e.g. phone died or switched device).
  return `<div class="page stack">
    <div class="brand"><img src="/icon.svg" alt=""><div><h1>Game in progress</h1><p class="label">pick your seat to rejoin</p></div></div>
    <div class="card"><div class="seat-list">${seats().map((p) => {
      const online = s.online.includes(p.id);
      return `<button class="seat" data-c="${p.color}" data-act="claim" data-id="${p.id}" style="text-align:left">
        <span class="n">${p.seat + 1}</span><div class="who"><b>${esc(p.name)}<span class="dot-online ${online ? 'on' : ''}"></span></b><small>${esc(p.commander || '—')}</small></div>
        <span class="label">${online ? 'online' : 'claim'}</span></button>`;
    }).join('')}</div></div>
    <button class="btn ghost block" data-act="go" data-to="#/">← Home</button>
  </div>`;
}

function viewClosed() {
  return `<div class="page stack" style="padding-top:20vh;text-align:center">
    <div class="label">session ${esc(store.code)}</div>
    <h1 style="margin:6px 0">Session closed</h1>
    <p style="color:var(--muted)">${esc(S().closedReason || '')}</p>
    <button class="btn primary block" data-act="home">New game</button>
    <button class="btn ghost block" data-act="go" data-to="#/stats">See stats</button>
  </div>`;
}

// ---------- views: lobby ----------

function viewLobby() {
  const s = S();
  const host = s.hostId === store.playerId;
  const list = seats();
  return `<div class="page stack">
    <div class="spread">
      <button class="icon-btn" data-act="go" data-to="#/">${icon.back}</button>
      <span class="label">lobby · ${list.length} player${list.length === 1 ? '' : 's'}</span>
      <button class="icon-btn" data-act="sheet" data-kind="menu">${icon.menu}</button>
    </div>
    <div class="card qr-card">
      <div class="qr">${qrSvg(joinUrl(s.code))}</div>
      <div><div class="label">session code</div><div class="code-big">${esc(s.code)}</div></div>
      <div class="url-small">${esc(joinUrl(s.code))}</div>
    </div>
    <div class="card stack">
      <div class="spread"><h2 class="h">Seats</h2><button class="btn sm" data-act="shuffle">Shuffle</button></div>
      <div class="seat-list">${list.map((p, i) => `
        <div class="seat" data-c="${p.color}">
          <span class="n">${String(i + 1).padStart(2, '0')}</span>
          <div class="who"><b>${esc(p.name)}<span class="dot-online ${s.online.includes(p.id) ? 'on' : ''}"></span></b>
            <small>${[p.id === store.playerId && 'you', p.id === s.hostId && 'host'].filter(Boolean).map((t) => `<span class="label">${t}</span> · `).join('')}${esc(p.commander || 'no commander set')}</small></div>
          <div class="tools">
            ${p.id === store.playerId ? `<button class="btn sm ghost" data-act="sheet" data-kind="profile">Edit</button>` : ''}
            <button class="icon-btn" data-act="seat" data-id="${p.id}" data-dir="-1" ${i === 0 ? 'disabled style="opacity:.25"' : ''}>${icon.up}</button>
            <button class="icon-btn" data-act="seat" data-id="${p.id}" data-dir="1" ${i === list.length - 1 ? 'disabled style="opacity:.25"' : ''}>${icon.down}</button>
            ${host && p.id !== store.playerId ? `<button class="icon-btn" data-act="kick" data-id="${p.id}">${icon.x}</button>` : ''}
          </div>
        </div>`).join('')}</div>
      <div class="table-hint">sit clockwise in this order ↻</div>
    </div>
    <div class="card stack">
      <span class="label">Starting life</span>
      <div class="seg">${[20, 30, 40, 50, 60].map((n) => `<button class="${s.settings.startingLife === n ? 'on' : ''}" data-act="life" data-n="${n}">${n}</button>`).join('')}</div>
    </div>
    <button class="btn primary block" data-act="sheet" data-kind="start" style="min-height:56px;font-size:17px">Start game</button>
  </div>`;
}

function qrSvg(text) {
  if (typeof window.qrcode !== 'function') return `<div class="mono" style="color:#111;line-height:1.4;padding:20px;width:196px">QR unavailable offline — use the code below</div>`;
  const qr = window.qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  return qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
}

// ---------- views: game ----------

// Table-shaped layout: left neighbour bottom-left, right neighbour bottom-right,
// everyone across the table on the top row — like looking at the table from your seat.
function oppLayout(n) {
  if (n <= 3) return { cols: Math.max(n, 1), cells: Array.from({ length: n }, (_, i) => [1, i + 1]), center: null };
  const cols = n - 2;
  const cells = [[2, 1], ...Array.from({ length: n - 2 }, (_, i) => [1, i + 1]), [2, cols]];
  return { cols, cells, center: cols > 2 ? [2, 2, cols - 2] : null };
}

function deltaBadge(id) {
  const d = store.deltas[id];
  if (!d || now() - d.t > DELTA_MS || !d.v) return '';
  const by = d.by && d.by !== store.playerId ? byId(d.by)?.name : '';
  return `<span class="delta ${d.v < 0 ? 'neg' : 'pos'}">${signed(d.v)}${by ? `<small>${esc(by)}</small>` : ''}</span>`;
}

function badges(p) {
  const out = [];
  if (p.monarch) out.push('<span class="badge crown">♛</span>');
  if (p.poison) out.push(`<span class="badge ${p.poison >= LETHAL_POISON ? 'warn' : ''}">☣${p.poison}</span>`);
  const c = maxCmdr(p);
  if (c) out.push(`<span class="badge ${c >= LETHAL_CMDR ? 'warn' : ''}">⚔${c}</span>`);
  if (lethal(p)) out.push('<span class="badge warn">KO?</span>');
  if (isOut(p)) out.push('<span class="badge">OUT</span>');
  return out.join('');
}

function viewGame() {
  const s = S();
  const g = s.game;
  const self = me();
  const opps = opponentsInOrder();
  const L = oppLayout(opps.length);
  const active = byId(g.activeId);
  const size = { 1: 24, 2: 19, 3: 16, 4: 11, 5: 9, 6: 8 }[L.cols] || 7;

  const oppHtml = opps.map((p, i) => {
    const [r, c] = L.cells[i];
    const low = p.life <= 10;
    return `<div class="opp ${p.id === g.activeId ? 'active' : ''} ${isOut(p) ? 'out' : ''}" data-c="${p.color}" style="grid-row:${r};grid-column:${c}">
      ${p.id === g.activeId ? '<span class="turn-tag">TURN</span>' : ''}
      <button class="opp-head" data-act="sheet" data-kind="player" data-id="${p.id}">
        <span class="opp-seat">${String(p.seat + 1).padStart(2, '0')}</span><span class="opp-name">${esc(p.name)}</span>
      </button>
      <button class="opp-life num ${low ? 'low' : ''}" data-act="sheet" data-kind="player" data-id="${p.id}">${p.life}${deltaBadge(p.id)}</button>
      <div>
        <div class="opp-cmdr">${esc(p.commander || '')}</div>
        <div class="opp-foot">
          <button class="pm" data-hold="1" data-target="${p.id}" data-field="life" data-delta="-1" aria-label="minus">−</button>
          <div class="badges">${badges(p)}</div>
          <button class="pm" data-hold="1" data-target="${p.id}" data-field="life" data-delta="1" aria-label="plus">+</button>
        </div>
      </div>
    </div>`;
  }).join('');

  const center = L.center ? `<div style="grid-row:${L.center[0]};grid-column:${L.center[1]} / span ${L.center[2]};display:grid;place-items:center;border:1px dashed var(--line);border-radius:var(--r);color:var(--faint)" class="mono">
      <div style="text-align:center;font-size:11px;letter-spacing:.1em">TABLE<br><span style="font-size:18px">↻</span></div></div>` : '';

  const myTurn = g.activeId === self.id;
  return `<div class="game">
    <div class="topbar">
      <div class="meta"><span><b>${esc(s.code)}</b></span><span>T<b>${g.turnNumber}</b></span><span data-clock="game"></span></div>
      <button class="turn-pill" data-act="sheet" data-kind="player" data-id="${active?.id || ''}" data-c="${active?.color || 'amber'}">
        <span class="pip"></span><span class="mono" style="font-size:12px">${esc(active?.name || '—')}</span><span class="mono" style="font-size:12px;color:var(--muted)" data-clock="turn"></span>
      </button>
      <button class="icon-btn" data-act="sheet" data-kind="menu" aria-label="menu">${icon.menu}</button>
    </div>
    <div class="opps" style="--cols:${L.cols};--opp-size:${size}vw">${oppHtml}${center}</div>
    <div class="me ${myTurn ? 'active' : ''} ${isOut(self) ? 'out' : ''}" data-c="${self.color}">
      <div class="me-head">
        <button class="who" data-act="sheet" data-kind="player" data-id="${self.id}" style="text-align:left">
          <b>${esc(self.name)}</b> <span class="label">· seat ${self.seat + 1}</span><small>${esc(self.commander || 'tap for counters')}</small>
        </button>
        <div class="badges">${badges(self)}</div>
      </div>
      <div class="me-body">
        <div class="zone minus" data-hold="1" data-target="${self.id}" data-field="life" data-delta="-1">−</div>
        <div class="zone plus" data-hold="1" data-target="${self.id}" data-field="life" data-delta="1">+</div>
        <div class="me-life num ${self.life <= 10 ? 'low' : ''}">${self.life}${deltaBadge(self.id)}</div>
        ${isOut(self) ? `<div class="out-banner"><div><div class="label">you're out · place ${self.place}</div><p style="color:var(--muted);margin:6px 0 12px">you can still adjust everyone else</p><button class="btn sm" data-act="revive" data-id="${self.id}">Undo elimination</button></div></div>` : ''}
      </div>
      <div class="me-foot">
        <button class="chip" data-act="sheet" data-kind="player" data-id="${self.id}">☣ <b>${self.poison}</b></button>
        <button class="chip ${maxCmdr(self) >= LETHAL_CMDR ? 'warn' : ''}" data-act="sheet" data-kind="player" data-id="${self.id}">⚔ <b>${maxCmdr(self)}</b></button>
        ${lethal(self) ? `<button class="chip warn grow" data-act="sheet" data-kind="player" data-id="${self.id}"><b>Lethal — concede?</b></button>`
          : myTurn ? `<button class="chip turn grow" data-act="pass">Pass turn →</button>`
          : `<button class="chip grow" data-act="sheet" data-kind="log">log</button>`}
      </div>
    </div>
  </div>`;
}

// ---------- sheets ----------

function sheetPlayer({ id }) {
  const p = byId(id);
  if (!p || S().status !== 'playing') return null;
  const s = S();
  const others = seats().filter((q) => q.id !== p.id);
  const step = (field, d, src = '') => `<button class="step ${d < 0 ? 'neg' : 'pos'}" data-hold="1" data-target="${p.id}" data-field="${field}" data-delta="${d}" data-source="${src}">${signed(d)}</button>`;
  return `
    <div class="spread" data-c="${p.color}">
      <div class="row"><span class="pip"></span><div><h3>${esc(p.name)}${p.id === store.playerId ? ' <span class="label">· you</span>' : ''}</h3><div style="color:var(--muted);font-size:14px">${esc(p.commander || 'seat ' + (p.seat + 1))}</div></div></div>
      <button class="icon-btn" data-act="closeSheet">${icon.x}</button>
    </div>
    <div class="section-title label">Life</div>
    <div class="sheet-life">${step('life', -10)}${step('life', -5)}${step('life', -1)}
      <div class="v num ${p.life <= 10 ? 'low' : ''}" style="${p.life <= 10 ? 'color:var(--danger)' : ''}">${p.life}</div>
      ${step('life', 1)}${step('life', 5)}${step('life', 10)}</div>
    <div class="section-title label">Poison</div>
    <div class="counter"><div class="lbl">☣ <span>Infect counters</span></div>${step('poison', -1)}<div class="val ${p.poison >= LETHAL_POISON ? 'warn' : ''}">${p.poison}</div>${step('poison', 1)}</div>
    ${others.length ? `<div class="section-title label">Commander damage taken · also subtracts life</div>
      ${others.map((q) => `<div class="counter" data-c="${q.color}"><div class="lbl"><span class="pip"></span><span>${esc(q.commander || q.name)}${q.commander ? ` <span style="color:var(--faint)">· ${esc(q.name)}</span>` : ''}</span></div>
        ${step('cmdr', -1, q.id)}<div class="val ${(p.cmdr[q.id] || 0) >= LETHAL_CMDR ? 'warn' : ''}">${p.cmdr[q.id] || 0}</div>${step('cmdr', 1, q.id)}</div>`).join('')}` : ''}
    <div class="section-title label">Table</div>
    <div class="grid2">
      <button class="btn" data-act="monarch" data-id="${p.id}">${p.monarch ? '♛ Remove monarch' : '♛ Make monarch'}</button>
      <button class="btn" data-act="setActive" data-id="${p.id}" ${s.game.activeId === p.id || isOut(p) ? 'disabled' : ''}>Set as active</button>
    </div>
    <div style="margin-top:8px">${isOut(p)
      ? `<button class="btn block" data-act="revive" data-id="${p.id}">Undo elimination</button>`
      : `<button class="btn ${lethal(p) ? 'accent' : 'danger'} block" data-c="crimson" data-act="eliminate" data-id="${p.id}">${p.id === store.playerId ? 'I concede / I\'m dead' : `Eliminate ${esc(p.name)}`}</button>`}</div>`;
}

function sheetMenu() {
  const s = S();
  const host = s.hostId === store.playerId;
  const playing = s.status === 'playing';
  const idleLeft = s.idleMinutes * 60000 - (now() - s.lastActivity);
  return `
    <div class="spread"><h3>Session <span class="mono">${esc(s.code)}</span></h3><button class="icon-btn" data-act="closeSheet">${icon.x}</button></div>
    <p class="label" style="margin:4px 0 14px">auto-closes after ${s.idleMinutes} min idle · ${dur(Math.max(0, idleLeft))} left</p>
    <div class="stack">
      <button class="btn block" data-act="sheet" data-kind="invite">Show QR / invite</button>
      ${playing ? `<button class="btn block" data-act="undo">Undo my last change</button>
        <button class="btn block" data-act="sheet" data-kind="log">Game log</button>
        <button class="btn block" data-act="sheet" data-kind="end">End game…</button>` : ''}
      <button class="btn block" data-act="go" data-to="#/stats">Stats & history</button>
      <button class="btn ghost block" data-act="leave">Leave on this phone</button>
      ${host ? `<button class="btn danger block" data-act="closeSession">Close session for everyone</button>` : ''}
    </div>`;
}

function sheetInvite() {
  const s = S();
  return `<div class="spread"><h3>Invite</h3><button class="icon-btn" data-act="closeSheet">${icon.x}</button></div>
    <div class="qr-card"><div class="qr">${qrSvg(joinUrl(s.code))}</div><div class="code-big">${esc(s.code)}</div>
    <div class="url-small">${esc(joinUrl(s.code))}</div>
    ${s.status === 'playing' ? '<p class="label">mid-game: people can rejoin an existing seat</p>' : ''}</div>`;
}

function describe(e, names) {
  const n = (id) => `<span class="who-tag" data-c="${byId(id)?.color || ''}">${esc(names(id))}</span>`;
  if (e.kind === 'adjust') {
    const what = e.field === 'life' ? 'life' : e.field === 'poison' ? 'poison' : `cmdr dmg from ${n(e.source)}`;
    const src = e.field === 'life' && e.source && e.source !== e.by ? ` ← ${n(e.source)}` : '';
    return { text: `${n(e.target)} ${what}${src}${e.by !== e.target ? ` <span style="color:var(--faint)">by ${esc(names(e.by))}</span>` : ''}`, d: e.field === 'cmdr' ? -e.delta : e.delta, poison: e.field === 'poison' };
  }
  if (e.kind === 'eliminate') return { text: `${n(e.target)} eliminated ☠` };
  if (e.kind === 'revive') return { text: `${n(e.target)} back in the game` };
  if (e.kind === 'monarch') return { text: `${n(e.target)} ${e.on ? 'became' : 'is no longer'} monarch ♛` };
  if (e.kind === 'start') return { text: `game started · ${n(e.target)} goes first` };
  return { text: e.kind };
}

function sheetLog() {
  const g = S().game;
  if (!g) return null;
  const names = (id) => byId(id)?.name || '?';
  const rows = [...g.log].reverse().slice(0, 120).map((e) => {
    const x = describe(e, names);
    const d = x.d === undefined ? '' : `<span class="d ${(x.poison ? -x.d : x.d) < 0 ? 'neg' : 'pos'}">${signed(x.d)}</span>`;
    return `<div class="log-row"><span class="t">T${e.turn ?? ''} ${clock(e.t - g.startedAt)}</span><span>${x.text}</span>${d}</div>`;
  }).join('');
  return `<div class="spread"><h3>Game log</h3><button class="icon-btn" data-act="closeSheet">${icon.x}</button></div>
    <div class="log" style="margin-top:10px">${rows || '<div class="empty">nothing yet</div>'}</div>`;
}

function sheetEnd() {
  const left = seats().filter((p) => !isOut(p));
  return `<div class="spread"><h3>End game</h3><button class="icon-btn" data-act="closeSheet">${icon.x}</button></div>
    <p class="label" style="margin:6px 0 12px">who won?</p>
    <div class="stack">${left.map((p) => `<button class="btn block" data-c="${p.color}" data-act="endGame" data-id="${p.id}" style="justify-content:flex-start"><span class="pip"></span>${esc(p.name)}<span style="color:var(--muted);font-weight:400">${esc(p.commander || '')}</span></button>`).join('')}
    <button class="btn ghost block" data-act="endGame" data-id="">Draw / no winner</button></div>`;
}

function sheetProfile() {
  const p = me();
  const taken = S().players.filter((q) => q.id !== p.id).map((q) => q.color);
  ls.set('lc.profile', { ...ls.get('lc.profile', {}), name: p.name, commander: p.commander, color: p.color });
  return `<div class="spread"><h3>Your seat</h3><button class="icon-btn" data-act="closeSheet">${icon.x}</button></div>
    <form class="stack" data-form="profile" style="margin-top:12px">${profileFields(taken)}<button class="btn primary block" type="submit">Save</button></form>`;
}

function sheetStart() {
  return `<div class="spread"><h3>Who goes first?</h3><button class="icon-btn" data-act="closeSheet">${icon.x}</button></div>
    <div class="stack" style="margin-top:12px">
      <button class="btn primary block" data-act="start" data-id="">🎲 Random</button>
      ${seats().map((p) => `<button class="btn block" data-c="${p.color}" data-act="start" data-id="${p.id}" style="justify-content:flex-start"><span class="pip"></span>${esc(p.name)}</button>`).join('')}
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
  const W = 340, H = 170, P = { l: 26, r: 8, t: 10, b: 20 };
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
    return `<path d="${d}" fill="none" stroke="var(--${p.color})" stroke-width="2" stroke-linejoin="round" opacity="${p.id === g.winnerId ? 1 : 0.75}"/>`;
  }).join('');
  const ticks = [minY, Math.round((minY + maxY) / 2), maxY];
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Life totals over time">
    ${ticks.map((v) => `<line class="axis" x1="${P.l}" x2="${W - P.r}" y1="${Y(v)}" y2="${Y(v)}" stroke-dasharray="${v === 0 ? '' : '2 4'}"/><text x="${P.l - 6}" y="${Y(v) + 3}" text-anchor="end">${v}</text>`).join('')}
    <text x="${P.l}" y="${H - 4}">0:00</text><text x="${W - P.r}" y="${H - 4}" text-anchor="end">${clock(sum.end)}</text>
    ${lines}</svg>
    <div class="legend" style="margin-top:8px">${g.players.map((p) => `<span data-c="${p.color}"><span class="pip"></span>${esc(p.name)}</span>`).join('')}</div>`;
}

function summaryBody(g) {
  const sum = summarize(g);
  const winner = g.players.find((p) => p.id === g.winnerId);
  const ranked = [...g.players].sort((a, b) => (a.place || 99) - (b.place || 99) || b.finalLife - a.finalLife);
  const turnsDone = g.turns.filter((t) => t.end);
  const avgTurn = turnsDone.length ? turnsDone.reduce((a, t) => a + t.end - t.start, 0) / turnsDone.length : 0;
  return `
    <div class="winner" data-c="${winner?.color || 'amber'}">
      <div class="label">${winner ? 'winner' : 'game over'}</div>
      <h2>${winner ? esc(winner.name) : 'Draw'}</h2>
      <div style="color:var(--muted)">${esc(winner?.commander || '')}</div>
    </div>
    <div class="kpis">
      <div class="kpi"><span class="label">duration</span><b class="num">${dur(sum.end)}</b></div>
      <div class="kpi"><span class="label">turns</span><b class="num">${g.turns.length}</b></div>
      <div class="kpi"><span class="label">avg turn</span><b class="num">${clock(avgTurn)}</b></div>
    </div>
    <div class="card"><div class="spread" style="margin-bottom:8px"><span class="label">life over time</span></div>${lifeChart(g, sum)}</div>
    <div class="card">
      <table class="t"><thead><tr><th>#</th><th>player</th><th class="r">life</th><th class="r">dealt</th><th class="r">KOs</th><th class="r">turn</th></tr></thead><tbody>
      ${ranked.map((p) => { const tt = sum.turnTime[p.id]; return `<tr data-c="${p.color}"><td class="place">${p.place || '–'}</td>
        <td><div class="row" style="gap:8px"><span class="pip"></span><div style="min-width:0"><div>${esc(p.name)}</div><div style="color:var(--faint);font-size:12px">${esc(p.commander || '')}</div></div></div></td>
        <td class="r">${p.finalLife}</td><td class="r">${sum.dealt[p.id] || 0}</td><td class="r">${sum.kos[p.id] || 0}</td><td class="r mono" style="font-size:12px">${tt ? clock(tt.ms / tt.n) : '–'}</td></tr>`; }).join('')}
      </tbody></table>
      <p class="label" style="margin:10px 0 0">dealt = life you took from others from your phone, plus commander damage</p>
    </div>`;
}

function viewEnded() {
  const s = S();
  const g = { ...s.game, startingLife: s.settings.startingLife, players: s.players.map((p) => ({ ...p, finalLife: p.life })) };
  const host = s.hostId === store.playerId;
  return `<div class="page stack">
    <div class="spread"><span class="label">session ${esc(s.code)}</span><button class="icon-btn" data-act="sheet" data-kind="menu">${icon.menu}</button></div>
    ${summaryBody(g)}
    <button class="btn primary block" data-act="sheet" data-kind="start" style="min-height:56px">Rematch · same seats</button>
    <button class="btn block" data-act="backToLobby">Back to lobby (change seats)</button>
    ${host ? '<button class="btn danger block" data-act="closeSession">Close session</button>' : ''}
  </div>`;
}

function viewGameRecord() {
  const g = store.gameRecord;
  return `<div class="page stack">
    <div class="spread"><button class="icon-btn" data-act="go" data-to="#/stats">${icon.back}</button><span class="label">${g ? new Date(g.endedAt).toLocaleString() : 'loading…'}</span><span style="width:40px"></span></div>
    ${g ? summaryBody(g) : ''}
  </div>`;
}

function viewStats() {
  const st = store.stats;
  const head = `<div class="spread"><button class="icon-btn" data-act="back">${icon.back}</button><span class="label">stats & history</span><a class="btn sm ghost" href="/api/games" download>Export</a></div>`;
  if (!st) return `<div class="page stack">${head}<div class="empty mono">loading…</div></div>`;
  if (!st.games) return `<div class="page stack">${head}<div class="card empty">No finished games yet.<br>Play one and the numbers show up here.</div></div>`;
  return `<div class="page stack">${head}
    <div class="kpis">
      <div class="kpi"><span class="label">games</span><b class="num">${st.games}</b></div>
      <div class="kpi"><span class="label">avg length</span><b class="num">${dur(st.avgDurationMs)}</b></div>
      <div class="kpi"><span class="label">avg turns</span><b class="num">${Math.round(st.avgTurns)}</b></div>
    </div>
    <div class="card"><h2 class="h" style="margin-bottom:8px">Players</h2>
      <table class="t"><thead><tr><th>player</th><th class="r">W/G</th><th class="r">win%</th><th class="r">dealt</th><th class="r">KOs</th><th class="r">turn</th></tr></thead><tbody>
      ${st.players.map((p) => `<tr><td><div>${esc(p.name)}</div><div style="color:var(--faint);font-size:12px">${esc(p.favorite)}</div></td><td class="r">${p.wins}/${p.games}</td><td class="r">${pct(p.winRate)}</td><td class="r">${p.damage}</td><td class="r">${p.kos}</td><td class="r mono" style="font-size:12px">${p.avgTurnMs ? clock(p.avgTurnMs) : '–'}</td></tr>`).join('')}
      </tbody></table></div>
    ${st.commanders.length ? `<div class="card"><h2 class="h" style="margin-bottom:8px">Commanders</h2>
      <table class="t"><thead><tr><th>commander</th><th class="r">games</th><th class="r">wins</th><th class="r">win%</th></tr></thead><tbody>
      ${st.commanders.map((c) => `<tr><td>${esc(c.commander)}</td><td class="r">${c.games}</td><td class="r">${c.wins}</td><td class="r">${pct(c.wins / c.games)}</td></tr>`).join('')}
      </tbody></table></div>` : ''}
    <div class="card"><h2 class="h">Recent games</h2>
      ${st.recent.map((g) => `<button class="game-row" data-act="go" data-to="#/g/${g.id}">
        <div><div>${g.winner ? `♛ ${esc(g.winner)}` : 'Draw'}</div><div class="row" style="gap:5px;margin-top:6px">${g.players.map((p) => `<span class="pip" data-c="${p.color}" title="${esc(p.name)}"></span>`).join('')}<span style="color:var(--faint);font-size:12px;margin-left:4px">${g.players.map((p) => esc(p.name)).join(' · ')}</span></div></div>
        <div style="text-align:right" class="mono"><div style="font-size:13px">${dur(g.durationMs)} · T${g.turns}</div><div style="color:var(--faint);font-size:11px;margin-top:6px">${new Date(g.endedAt).toLocaleDateString()}</div></div>
      </button>`).join('')}
    </div>
  </div>`;
}

// ---------- events ----------

const actions = {
  go: (d) => go(d.to),
  back: () => (history.length > 1 ? history.back() : go('#/')),
  home: () => go('#/'),
  resume: (d) => go(`#/s/${d.code}`),
  closeSheet: () => { store.sheet = null; renderSheet(); },
  sheet: (d) => { if (d.kind === 'player' && !d.id) return; openSheet(d.kind, d.id); },
  pickColor: (d, el) => {
    const form = el.closest('form');
    form.querySelectorAll('.swatch').forEach((s) => s.classList.toggle('on', s === el));
    form.querySelector('[name=color]').value = d.color;
  },
  claim: (d) => {
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
  pass: () => { buzz(15); send({ type: 'passTurn' }); },
  setActive: (d) => { store.sheet = null; send({ type: 'setActive', target: d.id }); },
  monarch: (d) => send({ type: 'monarch', target: d.id }),
  eliminate: (d) => { store.sheet = null; send({ type: 'eliminate', target: d.id }); },
  revive: (d) => send({ type: 'revive', target: d.id }),
  undo: () => { store.sheet = null; send({ type: 'undo' }); },
  endGame: (d) => { store.sheet = null; send({ type: 'end', winnerId: d.id || undefined }); },
  backToLobby: () => send({ type: 'backToLobby' }),
  leave: () => {
    if (!confirm('Leave this session on this phone? You can rejoin your seat later.')) return;
    ls.del(`lc.player.${store.code}`);
    ls.del('lc.last');
    disconnect();
    store.code = null;
    go('#/');
  },
  closeSession: () => { if (confirm('Close the session for everyone? A running game is saved as abandoned.')) { ls.del('lc.last'); send({ type: 'close' }); } },
};

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled) return;
  actions[el.dataset.act]?.(el.dataset, el);
});

const forms = {
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
    const body = Object.fromEntries(new FormData(f));
    ls.set('lc.profile', body);
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
