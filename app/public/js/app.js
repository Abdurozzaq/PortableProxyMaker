/* PortableProxyMaker panel — vanilla JS, no build step. */
(() => {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const ACCENTS = ['yellow', 'pink', 'blue', 'lime', 'orange', 'purple', 'cyan'];
  const MAX_ROWS = 1000;

  const state = {
    page: 'dashboard',
    system: null,
    proxies: [],
    proxyStats: {},
    logs: [],
    live: true,
    filters: { proxyId: '', method: '', status: '', kind: '', q: '' },
    selectedId: null,
    selected: null,
    drawerTab: 'overview',
    bodyMode: {},
    es: null,
  };

  // ---------------------------------------------------------------- utils

  function esc(v) {
    return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function fmtBytes(n) {
    n = Number(n) || 0;
    if (n < 1024) return `${n} B`;
    const u = ['KB', 'MB', 'GB', 'TB'];
    let i = -1;
    do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
    return `${n.toFixed(n >= 100 ? 0 : 1)} ${u[i]}`;
  }

  function fmtMs(ms) {
    if (ms == null) return '—';
    if (ms < 1000) return `${ms} ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)} s`;
    return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
  }

  function fmtNum(n) {
    return Number(n || 0).toLocaleString();
  }

  function fmtTime(ts) {
    const d = new Date(ts);
    return d.toLocaleTimeString([], { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0');
  }

  function fmtDateTime(ts) {
    return new Date(ts).toLocaleString([], { hour12: false });
  }

  function ago(ts) {
    if (!ts) return 'never';
    const s = Math.round((Date.now() - ts) / 1000);
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    return `${Math.floor(s / 86400)}d ago`;
  }

  function accentFor(id) {
    let h = 0;
    for (const c of String(id)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    return ACCENTS[h % ACCENTS.length];
  }

  function methodBadge(m) {
    return `<span class="m m-${esc(m || '')}">${esc(m || '?')}</span>`;
  }

  function statusBadge(row) {
    if (row.status == null) return `<span class="s s-err">ERR</span>`;
    const cls = row.error && row.status >= 500 ? 'err' : String(row.status)[0];
    return `<span class="s s-${cls}">${row.status}</span>`;
  }

  function splitUrl(row) {
    if (row.kind === 'tunnel') return { host: row.host, path: '(encrypted tunnel)' };
    try {
      const u = new URL(row.url);
      return { host: row.host || u.host, path: u.pathname + u.search };
    } catch {
      return { host: row.host || '', path: row.url || '' };
    }
  }

  function toast(msg, type = 'ok') {
    const el = document.createElement('div');
    el.className = `toast ${type === 'err' ? 'err' : type === 'info' ? 'info' : ''}`;
    el.textContent = msg;
    $('#toasts').appendChild(el);
    setTimeout(() => el.remove(), type === 'err' ? 6000 : 3000);
  }

  async function copy(text, label = 'Copied') {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    toast(label);
  }

  async function api(path, opts = {}) {
    const res = await fetch(`api/${path}`, {
      method: opts.method || 'GET',
      headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      credentials: 'same-origin',
    });
    if (res.status === 401 && path !== 'login') {
      showLogin();
      throw new Error('Session expired');
    }
    const data = res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text();
    if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
    return data;
  }

  function debounce(fn, ms) {
    let t;
    return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  }

  function throttle(fn, ms) {
    let last = 0;
    let timer = null;
    return () => {
      const wait = ms - (Date.now() - last);
      if (wait <= 0) { last = Date.now(); fn(); } else if (!timer) {
        timer = setTimeout(() => { timer = null; last = Date.now(); fn(); }, wait);
      }
    };
  }

  function proxyUrl(p, withAuth = true) {
    const host = state.system?.publicHost || location.hostname;
    const auth = withAuth && p.username ? `${encodeURIComponent(p.username)}:${encodeURIComponent(p.password || '')}@` : '';
    return `http://${auth}${host}:${p.port}`;
  }

  // ---------------------------------------------------------------- theme

  function initTheme() {
    let saved = null;
    try { saved = localStorage.getItem('ppm-theme'); } catch { /* storage blocked */ }
    if (saved) document.documentElement.dataset.theme = saved;
    $('#theme-toggle').addEventListener('click', () => {
      const current = document.documentElement.dataset.theme
        || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
      const next = current === 'dark' ? 'light' : 'dark';
      document.documentElement.dataset.theme = next;
      try { localStorage.setItem('ppm-theme', next); } catch { /* ignore */ }
    });
  }

  // ---------------------------------------------------------------- auth

  function showLogin() {
    $('#app-view').hidden = true;
    $('#login-view').hidden = false;
    if (state.es) { state.es.close(); state.es = null; }
  }

  async function showApp() {
    $('#login-view').hidden = true;
    $('#app-view').hidden = false;
    state.system = await api('system');
    await refreshProxies();
    connectEvents();
    const hash = location.hash.replace('#', '');
    go(['dashboard', 'proxies', 'traffic', 'settings'].includes(hash) ? hash : 'dashboard');
  }

  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const errEl = $('#login-error');
    errEl.hidden = true;
    try {
      await api('login', { method: 'POST', body: { username: fd.get('username'), password: fd.get('password') } });
      e.target.reset();
      await showApp();
    } catch (err) {
      errEl.textContent = err.message;
      errEl.hidden = false;
    }
  });

  $('#logout-btn').addEventListener('click', async () => {
    await api('logout', { method: 'POST' }).catch(() => {});
    showLogin();
  });

  // ---------------------------------------------------------------- nav

  function go(page) {
    state.page = page;
    location.hash = page;
    if (!$('#drawer').hidden) closeDrawer();
    $$('#nav .tab').forEach((t) => t.classList.toggle('active', t.dataset.page === page));
    $$('.page').forEach((p) => { p.hidden = p.id !== `page-${page}`; });
    if (page === 'dashboard') loadStats();
    if (page === 'proxies') { loadStats(); renderProxies(); }
    if (page === 'traffic') { renderProxyFilter(); loadLogs(); }
    if (page === 'settings') renderSettings();
  }

  window.addEventListener('hashchange', () => {
    const page = location.hash.replace('#', '');
    if (page !== state.page && $(`#page-${page}`) && !$('#app-view').hidden) go(page);
  });

  $('#nav').addEventListener('click', (e) => {
    const b = e.target.closest('[data-page]');
    if (b) go(b.dataset.page);
  });

  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-goto]');
    if (!b) return;
    if (b.dataset.status !== undefined) { state.filters.status = b.dataset.status; $('#f-status').value = b.dataset.status; }
    if (b.dataset.proxy !== undefined) { state.filters.proxyId = b.dataset.proxy; }
    go(b.dataset.goto);
  });

  // ---------------------------------------------------------------- live events

  function connectEvents() {
    if (state.es) state.es.close();
    const es = new EventSource('api/events');
    state.es = es;
    const dot = $('#live-dot');
    es.onopen = () => dot.classList.add('on');
    es.onerror = () => {
      dot.classList.remove('on');
      // A 401 closes the stream for good; check whether we are still logged in.
      if (es.readyState === EventSource.CLOSED) api('me').then(() => setTimeout(connectEvents, 3000)).catch(() => {});
    };
    es.addEventListener('log', (e) => onLog(JSON.parse(e.data)));
    es.addEventListener('log-update', (e) => onLogUpdate(JSON.parse(e.data)));
    es.addEventListener('logs-cleared', () => { if (state.page === 'traffic') loadLogs(); scheduleStats(); });
    es.addEventListener('proxy-status', (e) => onProxyStatus(JSON.parse(e.data)));
    es.addEventListener('proxy-changed', (e) => onProxyChanged(JSON.parse(e.data)));
  }

  const scheduleStats = throttle(() => {
    if (state.page === 'dashboard' || state.page === 'proxies') loadStats();
  }, 3000);

  function matchesFilters(row) {
    const f = state.filters;
    if (f.proxyId && row.proxy_id !== f.proxyId) return false;
    if (f.method && row.method !== f.method) return false;
    if (f.kind && row.kind !== f.kind) return false;
    if (f.status) {
      if (f.status === 'error') {
        if (!(row.error || row.status == null || row.status >= 500)) return false;
      } else if (/^\dxx$/.test(f.status)) {
        if (row.status == null || Math.floor(row.status / 100) !== Number(f.status[0])) return false;
      }
    }
    if (f.q) {
      const q = f.q.toLowerCase();
      if (![row.url, row.host, row.client_ip, row.error].some((v) => v && String(v).toLowerCase().includes(q))) return false;
    }
    return true;
  }

  function onLog(row) {
    scheduleStats();
    if (!state.live || !matchesFilters(row)) return;
    state.logs.unshift(row);
    if (state.logs.length > MAX_ROWS) state.logs.length = MAX_ROWS;
    if (state.page === 'traffic') {
      const tbody = $('#traffic-body');
      tbody.insertAdjacentHTML('afterbegin', rowHtml(row, true));
      while (tbody.children.length > MAX_ROWS) tbody.lastElementChild.remove();
      $('#traffic-empty').hidden = true;
    }
  }

  function onLogUpdate(row) {
    const i = state.logs.findIndex((r) => r.id === row.id);
    if (i < 0) return;
    state.logs[i] = row;
    const tr = $(`#traffic-body tr[data-id="${row.id}"]`);
    if (tr) tr.outerHTML = rowHtml(row, false);
    if (state.selectedId === row.id && state.selected) {
      Object.assign(state.selected, row);
      if (state.drawerTab === 'overview') renderDrawer();
    }
  }

  function onProxyStatus(s) {
    const p = state.proxies.find((x) => x.id === s.id);
    if (!p) return;
    p.runtime = { ...p.runtime, ...s };
    if (state.page === 'proxies') renderProxies();
  }

  function onProxyChanged(p) {
    const i = state.proxies.findIndex((x) => x.id === p.id);
    if (p.deleted) { if (i >= 0) state.proxies.splice(i, 1); } else if (i >= 0) state.proxies[i] = p; else state.proxies.push(p);
    if (state.page === 'proxies') renderProxies();
    if (state.page === 'traffic') renderProxyFilter();
  }

  // ---------------------------------------------------------------- dashboard

  async function loadStats() {
    try {
      const s = await api('stats');
      state.proxyStats = Object.fromEntries(s.perProxy.map((p) => [p.proxy_id, p]));
      if (state.page === 'dashboard') renderDashboard(s);
      if (state.page === 'proxies') renderProxies();
    } catch (err) {
      if (err.message !== 'Session expired') toast(err.message, 'err');
    }
  }

  function renderDashboard(s) {
    const running = state.proxies.filter((p) => p.runtime?.status === 'running').length;
    const t = s.totals;
    const errRate = t.requests ? ((t.errors / t.requests) * 100).toFixed(1) : '0.0';
    $('#stat-grid').innerHTML = [
      { c: 'yellow', label: 'Proxies running', value: `${running}<span style="font-size:.5em">/${state.proxies.length}</span>`, sub: `${state.proxies.filter((p) => p.runtime?.status === 'error').length} with errors` },
      { c: 'blue', label: 'Requests', value: fmtNum(t.requests), sub: `avg ${fmtMs(t.avg_ms)}` },
      { c: 'pink', label: 'Errors', value: fmtNum(t.errors), sub: `${errRate}% error rate` },
      { c: 'lime', label: 'Upload ↑', value: fmtBytes(t.bytes_up), sub: 'client → upstream' },
      { c: 'orange', label: 'Download ↓', value: fmtBytes(t.bytes_down), sub: 'upstream → client' },
    ].map((x) => `<div class="card stat c-${x.c}"><div class="label">${x.label}</div><div class="value">${x.value}</div><div class="sub">${x.sub}</div></div>`).join('');

    // Requests per minute, last 60 minutes.
    const byMinute = new Map(s.perMinute.map((m) => [m.minute, m]));
    const nowMin = Math.floor(s.now / 60000) * 60000;
    const minutes = Array.from({ length: 60 }, (_, i) => nowMin - (59 - i) * 60000);
    const max = Math.max(1, ...s.perMinute.map((m) => m.count));
    $('#chart-rpm').innerHTML = minutes.map((m) => {
      const d = byMinute.get(m) || { count: 0, errors: 0 };
      const ok = d.count - d.errors;
      const tip = `${new Date(m).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })} · ${d.count} req${d.errors ? ` · ${d.errors} err` : ''}`;
      return `<div class="bar" data-tip="${esc(tip)}">${ok ? `<i style="height:${(ok / max) * 100}%"></i>` : ''}${d.errors ? `<i class="err" style="height:${(d.errors / max) * 100}%"></i>` : ''}</div>`;
    }).join('');

    const groupColor = { '1xx': 'blue', '2xx': 'lime', '3xx': 'cyan', '4xx': 'orange', '5xx': 'red', ERR: 'red' };
    const totalG = s.statusGroups.reduce((a, g) => a + g.count, 0) || 1;
    $('#status-groups').innerHTML = s.statusGroups.length
      ? s.statusGroups.map((g) => `<div class="hbar"><span>${esc(g.grp)}</span><div class="track"><div class="fill" style="width:${(g.count / totalG) * 100}%;background:var(--${groupColor[g.grp] || 'gray'})"></div></div><span class="n">${fmtNum(g.count)}</span></div>`).join('')
      : '<p class="muted">No requests yet.</p>';

    $('#top-hosts').innerHTML = s.topHosts.length
      ? s.topHosts.map((h) => `<li><span class="h" title="${esc(h.host)}">${esc(h.host)}</span><span class="c">${fmtNum(h.count)}</span></li>`).join('')
      : '<p class="muted">No hosts yet.</p>';

    $('#recent-errors').innerHTML = s.recentErrors.length
      ? s.recentErrors.map((r) => `<div class="err-row" data-log="${r.id}"><span class="mono small">${esc(ago(r.ts))}</span><span>${statusBadge(r)}</span><span class="u">${methodBadge(r.method)} ${esc(r.url || r.host)}</span>${r.error ? `<span class="e">${esc(r.error)}</span>` : ''}</div>`).join('')
      : '<p class="muted">No errors. Nice.</p>';
  }

  $('#recent-errors').addEventListener('click', (e) => {
    const r = e.target.closest('[data-log]');
    if (r) openDrawer(Number(r.dataset.log));
  });

  setInterval(() => { if (state.page === 'dashboard' && !document.hidden) loadStats(); }, 15000);

  // ---------------------------------------------------------------- proxies

  async function refreshProxies() {
    state.proxies = await api('proxies');
  }

  function renderProxies() {
    const q = $('#proxy-search').value.trim().toLowerCase();
    const list = state.proxies.filter((p) => !q || p.name.toLowerCase().includes(q) || String(p.port).includes(q));
    const grid = $('#proxy-grid');
    if (!state.proxies.length) {
      grid.innerHTML = `<div class="card empty-card"><div><div class="big">NO PROXIES YET</div><p class="muted">Create one, or a whole batch at once.</p><button class="btn btn-yellow" data-action="new">+ New proxy</button></div></div>`;
      return;
    }
    grid.innerHTML = list.map(proxyCardHtml).join('') || '<p class="muted">No proxy matches the search.</p>';
  }

  function proxyCardHtml(p) {
    const rt = p.runtime || {};
    const st = state.proxyStats[p.id] || {};
    const status = rt.status || 'stopped';
    const history = (p.port_history || []).slice(-4).reverse().map((h) => h.port).join(', ');
    const tags = [
      p.username ? '<span class="tag tag-blue">Auth</span>' : '<span class="tag tag-orange" title="Anyone can use this proxy">Open</span>',
      p.mitm ? '<span class="tag tag-purple" title="HTTPS is decrypted">MITM</span>' : '<span class="tag tag-off">MITM off</span>',
      p.log_enabled ? '<span class="tag tag-lime">Log</span>' : '<span class="tag tag-off">Log off</span>',
      p.log_enabled && p.capture_body ? '<span class="tag tag-cyan">Body</span>' : '<span class="tag tag-off">Body off</span>',
      p.outbound_ip ? `<span class="tag tag-yellow" title="Outbound IP">↗ ${esc(p.outbound_ip)}</span>` : '',
    ].join('');
    return `
      <article class="card proxy-card" data-id="${esc(p.id)}">
        <div class="pc-head" style="background:var(--${accentFor(p.id)})">
          <span class="pc-name" title="${esc(p.name)}">${esc(p.name)}</span>
          <span class="status-pill ${status}">${status}${status === 'running' && rt.activeConnections ? ` · ${rt.activeConnections}` : ''}</span>
        </div>
        <div class="pc-body">
          <div class="pc-port"><span class="p">${p.port}</span><span class="l">PORT</span></div>
          ${rt.error ? `<div class="pc-error">${esc(rt.error)}</div>` : ''}
          <div class="pc-url"><code>${esc(proxyUrl(p))}</code><button data-action="copy">Copy</button></div>
          <div class="pc-tags">${tags}</div>
          <div class="pc-stats">
            <div><b>${fmtNum(st.requests)}</b><span>Req 24h</span></div>
            <div><b>${fmtNum(st.errors)}</b><span>Errors</span></div>
            <div><b>${fmtBytes((st.bytes_up || 0) + (st.bytes_down || 0))}</b><span>Traffic</span></div>
            <div><b>${esc(st.last_seen ? ago(st.last_seen) : '—')}</b><span>Last</span></div>
          </div>
          ${history ? `<div class="pc-history">old ports: ${esc(history)}</div>` : ''}
          ${p.note ? `<div class="small muted">${esc(p.note)}</div>` : ''}
          <div class="pc-actions">
            ${p.enabled ? '<button class="btn btn-sm" data-action="stop">■ Stop</button>' : '<button class="btn btn-sm btn-lime" data-action="start">▶ Start</button>'}
            <button class="btn btn-sm btn-orange" data-action="rotate" title="Move to a new port">⟳ Rotate</button>
            <button class="btn btn-sm" data-action="ping" title="Check if this port is reachable from your network">Ping</button>
            <button class="btn btn-sm btn-blue" data-action="traffic">Traffic</button>
            <button class="btn btn-sm" data-action="edit">Edit</button>
            <button class="btn btn-sm btn-red" data-action="delete" title="Delete">✕</button>
          </div>
        </div>
      </article>`;
  }

  $('#proxy-search').addEventListener('input', debounce(renderProxies, 150));
  $('#new-proxy-btn').addEventListener('click', () => openProxyForm(null));

  $('#proxy-grid').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    if (action === 'new') return openProxyForm(null);
    const id = btn.closest('[data-id]').dataset.id;
    const p = state.proxies.find((x) => x.id === id);
    try {
      if (action === 'copy') return copy(proxyUrl(p), 'Proxy URL copied');
      if (action === 'start') { await api(`proxies/${id}/start`, { method: 'POST' }); toast(`${p.name} started`); }
      if (action === 'stop') { await api(`proxies/${id}/stop`, { method: 'POST' }); toast(`${p.name} stopped`, 'info'); }
      if (action === 'rotate') openRotateForm(p);
      if (action === 'edit') openProxyForm(p);
      if (action === 'ping') pingProxy(p, btn);
      if (action === 'traffic') {
        state.filters.proxyId = id;
        go('traffic');
      }
      if (action === 'delete') {
        if (!confirm(`Delete proxy "${p.name}" on port ${p.port}? Its logs are kept.`)) return;
        await api(`proxies/${id}`, { method: 'DELETE' });
        toast(`${p.name} deleted`, 'info');
      }
    } catch (err) {
      toast(err.message, 'err');
    }
  });

  // Hits the proxy port directly from this browser. Success means the port is
  // reachable from the user's network; a timeout hints at a block/blacklist.
  async function pingProxy(p, btn) {
    const host = state.system?.publicHost || location.hostname;
    if (location.protocol === 'https:') {
      return toast('Ping needs the panel opened over http:// (browsers block http requests from https pages)', 'err');
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6000);
    const started = performance.now();
    btn.disabled = true;
    btn.textContent = '…';
    try {
      const res = await fetch(`http://${host}:${p.port}/__ppm/ping?t=${Date.now()}`, { signal: ctrl.signal, cache: 'no-store' });
      const data = await res.json();
      if (!data.ok) throw new Error('unexpected reply');
      toast(`Port ${p.port} reachable from your network · ${Math.round(performance.now() - started)} ms`);
    } catch (err) {
      toast(`Port ${p.port} NOT reachable from your network (${err.name === 'AbortError' ? 'timeout' : err.message}). Firewall, ISP block or blacklist? Try Rotate.`, 'err');
    } finally {
      clearTimeout(timer);
      btn.disabled = false;
      btn.textContent = 'Ping';
    }
  }

  // ---------------------------------------------------------------- modal / forms

  function openModal(title, html, onMount) {
    $('#modal-title').textContent = title;
    $('#modal-body').innerHTML = html;
    $('#modal').hidden = false;
    onMount?.($('#modal-body'));
    setTimeout(() => $('#modal-body input:not([type=hidden]):not([type=radio]):not([type=checkbox])')?.focus(), 30);
  }

  function closeModal() {
    $('#modal').hidden = true;
    $('#modal-body').innerHTML = '';
  }

  $('#modal').addEventListener('click', (e) => {
    if (e.target.id === 'modal' || e.target.closest('[data-close]')) closeModal();
  });

  function switchHtml(name, label, hint, checked) {
    return `<label class="switch"><span><b>${label}</b><small>${hint}</small></span><input type="checkbox" name="${name}" ${checked ? 'checked' : ''}></label>`;
  }

  function openProxyForm(p) {
    const editing = !!p;
    const range = state.system ? `${state.system.portMin}–${state.system.portMax}` : '';
    const authMode = editing ? 'keep' : 'random';
    openModal(editing ? `Edit ${p.name}` : 'New proxy', `
      <form id="proxy-form">
        <div class="field-row">
          <label class="field"><span>Name</span><input name="name" value="${esc(p?.name || '')}" placeholder="e.g. scraper-sg"></label>
          ${editing
            ? `<label class="field"><span>Port</span><input name="port" type="number" min="1" max="65535" value="${p.port}"><small>Use Rotate to ban the old port.</small></label>`
            : `<label class="field"><span>How many</span><input name="count" type="number" min="1" max="50" value="1"><small>Bulk create with random ports.</small></label>`}
        </div>
        ${editing ? '' : `<label class="field" id="port-field"><span>Port</span><input name="port" type="number" min="1" max="65535" placeholder="Random from ${range}"><small>Leave blank for a random free port.</small></label>`}
        <div class="field">
          <span>Proxy authentication</span>
          <div class="seg">
            ${editing ? `<label><input type="radio" name="auth" value="keep" ${authMode === 'keep' ? 'checked' : ''}><span>Keep</span></label>` : ''}
            <label><input type="radio" name="auth" value="random" ${authMode === 'random' ? 'checked' : ''}><span>Random</span></label>
            <label><input type="radio" name="auth" value="custom"><span>Custom</span></label>
            <label><input type="radio" name="auth" value="none"><span>None</span></label>
          </div>
        </div>
        <div class="field-row" id="custom-auth" hidden>
          <label class="field"><span>Username</span><input name="username" value="${esc(p?.username || '')}" autocomplete="off"></label>
          <label class="field"><span>Password</span><input name="password" value="${esc(p?.password || '')}" autocomplete="off"></label>
        </div>
        <p class="note warn" id="open-warn" hidden>Without auth anyone who finds this port can use your server as an open proxy.</p>
        ${switchHtml('mitm', 'Decrypt HTTPS (MITM)', 'See HTTPS headers & bodies. Client must trust the CA from Settings.', p?.mitm)}
        ${switchHtml('log_enabled', 'Log traffic', 'Record requests in the Traffic view.', p ? p.log_enabled : true)}
        ${switchHtml('capture_body', 'Capture bodies', `Store request/response payloads (up to ${fmtBytes(state.system?.captureMaxBody)} each).`, p ? p.capture_body : true)}
        <label class="field"><span>Outbound IP (optional)</span><input name="outbound_ip" value="${esc(p?.outbound_ip || '')}" placeholder="Server IP to send traffic from"><small>Only if your server has several public IPs.</small></label>
        <label class="field"><span>Note</span><input name="note" value="${esc(p?.note || '')}" placeholder="What is this proxy for?"></label>
        <p class="form-error" id="proxy-form-error" hidden></p>
        <div class="modal-actions">
          <button type="button" class="btn" data-close>Cancel</button>
          <button type="submit" class="btn btn-yellow">${editing ? 'Save' : 'Create'}</button>
        </div>
      </form>`, (root) => {
      const form = $('#proxy-form', root);
      const sync = () => {
        const mode = form.auth.value;
        $('#custom-auth', root).hidden = mode !== 'custom';
        $('#open-warn', root).hidden = mode !== 'none';
        const count = Number(form.count?.value || 1);
        if ($('#port-field', root)) $('#port-field', root).hidden = count > 1;
      };
      form.addEventListener('change', sync);
      form.addEventListener('input', sync);
      sync();
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const fd = new FormData(form);
        const body = {
          name: fd.get('name'),
          auth: fd.get('auth'),
          mitm: form.mitm.checked,
          log_enabled: form.log_enabled.checked,
          capture_body: form.capture_body.checked,
          outbound_ip: fd.get('outbound_ip'),
          note: fd.get('note'),
        };
        if (body.auth === 'keep') delete body.auth;
        if (fd.get('auth') === 'custom') { body.username = fd.get('username'); body.password = fd.get('password'); }
        if (fd.get('port')) body.port = Number(fd.get('port'));
        if (!editing) body.count = Number(fd.get('count') || 1);
        const errEl = $('#proxy-form-error', root);
        errEl.hidden = true;
        try {
          if (editing) {
            await api(`proxies/${p.id}`, { method: 'PATCH', body });
            toast('Saved');
          } else {
            const created = await api('proxies', { method: 'POST', body });
            toast(created.length > 1 ? `${created.length} proxies created` : `Proxy on port ${created[0].port} created`);
          }
          closeModal();
          await refreshProxies();
          renderProxies();
        } catch (err) {
          errEl.textContent = err.message;
          errEl.hidden = false;
        }
      });
    });
  }

  function openRotateForm(p) {
    openModal(`Rotate ${p.name}`, `
      <form id="rotate-form">
        <p>Move <b>${esc(p.name)}</b> off port <b class="mono">${p.port}</b>. Credentials and settings stay the same; only the port changes.</p>
        <label class="field"><span>New port</span><input name="port" type="number" min="1" max="65535" placeholder="Random free port"></label>
        ${switchHtml('ban', `Ban port ${p.port}`, 'Never hand out this port again (use it when the port got blacklisted).', true)}
        <label class="field"><span>Reason</span><input name="reason" placeholder="e.g. blocked by target site"></label>
        <p class="form-error" id="rotate-error" hidden></p>
        <div class="modal-actions">
          <button type="button" class="btn" data-close>Cancel</button>
          <button type="submit" class="btn btn-orange">⟳ Rotate</button>
        </div>
      </form>`, (root) => {
      const form = $('#rotate-form', root);
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const body = { ban: form.ban.checked, reason: form.reason.value || undefined };
        if (form.port.value) body.port = Number(form.port.value);
        try {
          const r = await api(`proxies/${p.id}/rotate`, { method: 'POST', body });
          closeModal();
          await refreshProxies();
          renderProxies();
          toast(`${p.name}: ${r.oldPort} → ${r.newPort}`);
          copy(proxyUrl(r.proxy), `New proxy URL copied (port ${r.newPort})`);
        } catch (err) {
          $('#rotate-error', root).textContent = err.message;
          $('#rotate-error', root).hidden = false;
        }
      });
    });
  }

  // ---------------------------------------------------------------- traffic

  function renderProxyFilter() {
    const sel = $('#f-proxy');
    sel.innerHTML = '<option value="">All proxies</option>' + state.proxies
      .map((p) => `<option value="${esc(p.id)}">${esc(p.name)} :${p.port}</option>`).join('');
    sel.value = state.filters.proxyId;
    if (sel.value !== state.filters.proxyId) {
      // Filter points to a deleted proxy: keep it selectable.
      sel.insertAdjacentHTML('beforeend', `<option value="${esc(state.filters.proxyId)}">(deleted proxy)</option>`);
      sel.value = state.filters.proxyId;
    }
  }

  function filterQuery(extra = {}) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...state.filters, ...extra })) if (v) params.set(k, v);
    return params.toString();
  }

  async function loadLogs() {
    try {
      state.logs = await api(`logs?${filterQuery({ limit: 200 })}`);
      renderLogs();
    } catch (err) {
      if (err.message !== 'Session expired') toast(err.message, 'err');
    }
  }

  async function loadMore() {
    const last = state.logs[state.logs.length - 1];
    if (!last) return;
    const older = await api(`logs?${filterQuery({ limit: 200, beforeId: last.id })}`);
    if (!older.length) return toast('No older entries', 'info');
    state.logs.push(...older);
    $('#traffic-body').insertAdjacentHTML('beforeend', older.map((r) => rowHtml(r)).join(''));
  }

  function rowHtml(r, flash = false) {
    const { host, path } = splitUrl(r);
    const size = r.kind === 'tunnel' || r.kind === 'ws' ? (r.bytes_up || 0) + (r.bytes_down || 0) : r.res_body_size;
    const kindLabel = { http: 'HTTP', https: 'HTTPS', tunnel: 'TUNNEL', ws: 'WS' }[r.kind] || r.kind;
    return `<tr data-id="${r.id}" class="${state.selectedId === r.id ? 'selected' : ''} ${flash ? 'flash' : ''}">
      <td class="t">${fmtTime(r.ts)}</td>
      <td>${esc(r.proxy_name || '')} <span class="muted mono small">:${r.proxy_port ?? ''}</span></td>
      <td>${methodBadge(r.method)}</td>
      <td>${statusBadge(r)}${r.active ? '<span class="active-dot" title="Connection open"></span>' : ''}</td>
      <td class="host" title="${esc(host)}">${esc(host)}</td>
      <td class="path" title="${esc(r.error || path)}">${r.error ? `<span style="color:var(--red);font-weight:700">⚠ ${esc(r.error)}</span>` : esc(path)}</td>
      <td><span class="tag ${r.kind === 'https' ? 'tag-purple' : r.kind === 'tunnel' ? '' : r.kind === 'ws' ? 'tag-pink' : 'tag-cyan'}">${esc(kindLabel)}</span></td>
      <td class="num">${fmtBytes(size)}</td>
      <td class="num">${fmtMs(r.duration_ms)}</td>
    </tr>`;
  }

  function renderLogs() {
    $('#traffic-body').innerHTML = state.logs.map((r) => rowHtml(r)).join('');
    $('#traffic-empty').hidden = state.logs.length > 0;
  }

  const onFilterChange = () => {
    state.filters = {
      proxyId: $('#f-proxy').value,
      method: $('#f-method').value,
      status: $('#f-status').value,
      kind: $('#f-kind').value,
      q: $('#f-q').value.trim(),
    };
    loadLogs();
  };
  ['#f-proxy', '#f-method', '#f-status', '#f-kind'].forEach((s) => $(s).addEventListener('change', onFilterChange));
  $('#f-q').addEventListener('input', debounce(onFilterChange, 300));

  $('#live-toggle').addEventListener('click', () => {
    state.live = !state.live;
    $('#live-toggle').textContent = state.live ? '❚❚ Pause' : '▶ Resume';
    $('#live-toggle').classList.toggle('btn-lime', !state.live);
    if (state.live) loadLogs();
  });
  $('#refresh-logs').addEventListener('click', loadLogs);
  $('#load-more').addEventListener('click', () => loadMore().catch((err) => toast(err.message, 'err')));
  $('#clear-logs').addEventListener('click', async () => {
    const p = state.proxies.find((x) => x.id === state.filters.proxyId);
    if (!confirm(p ? `Delete all logs of "${p.name}"?` : 'Delete ALL traffic logs?')) return;
    await api(`logs${p ? `?proxyId=${encodeURIComponent(p.id)}` : ''}`, { method: 'DELETE' });
    toast('Logs cleared', 'info');
  });

  $('#traffic-body').addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-id]');
    if (tr) openDrawer(Number(tr.dataset.id));
  });

  // ---------------------------------------------------------------- drawer

  async function openDrawer(id) {
    state.selectedId = id;
    state.bodyMode = {};
    $$('#traffic-body tr.selected').forEach((t) => t.classList.remove('selected'));
    $(`#traffic-body tr[data-id="${id}"]`)?.classList.add('selected');
    try {
      state.selected = await api(`logs/${id}`);
    } catch (err) {
      return toast(err.message, 'err');
    }
    $('#drawer').hidden = false;
    setDrawerTab(state.drawerTab);
  }

  function closeDrawer() {
    $('#drawer').hidden = true;
    state.selectedId = null;
    state.selected = null;
    $$('#traffic-body tr.selected').forEach((t) => t.classList.remove('selected'));
  }

  function setDrawerTab(tab) {
    state.drawerTab = tab;
    $$('#drawer-tabs .subtab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    renderDrawer();
  }

  $('#drawer-tabs').addEventListener('click', (e) => {
    const b = e.target.closest('[data-tab]');
    if (b) setDrawerTab(b.dataset.tab);
  });
  $('#drawer-close').addEventListener('click', closeDrawer);
  $('#drawer').addEventListener('click', (e) => { if (e.target.id === 'drawer') closeDrawer(); });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!$('#modal').hidden) closeModal();
    else if (!$('#drawer').hidden) closeDrawer();
  });

  function headerValue(headers, name) {
    const h = (headers || []).find(([k]) => k.toLowerCase() === name);
    return h ? h[1] : null;
  }

  function headersTable(headers) {
    if (!headers || !headers.length) return '<p class="muted">No headers.</p>';
    return `<table class="headers-table">${headers.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join('')}</table>`;
  }

  function highlightJson(text) {
    return esc(text).replace(
      /(&quot;(?:\\.|[^&\\]|&(?!quot;))*?&quot;)(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g,
      (m, str, colon, bool, num) => {
        if (str) return colon ? `<span class="k">${str}</span>${colon}` : `<span class="str">${str}</span>`;
        if (bool) return `<span class="b">${bool}</span>`;
        if (num) return `<span class="n">${num}</span>`;
        return m;
      },
    );
  }

  function prettyBody(text, contentType) {
    const ct = (contentType || '').toLowerCase();
    const trimmed = text.trim();
    if (ct.includes('json') || /^[[{]/.test(trimmed)) {
      try { return { html: highlightJson(JSON.stringify(JSON.parse(trimmed), null, 2)), pretty: true }; } catch { /* not json */ }
      // NDJSON / JSON lines
      const lines = trimmed.split('\n');
      if (lines.length > 1) {
        try { return { html: highlightJson(lines.map((l) => JSON.stringify(JSON.parse(l), null, 2)).join('\n')), pretty: true }; } catch { /* no */ }
      }
    }
    if (ct.includes('x-www-form-urlencoded')) {
      try {
        const params = [...new URLSearchParams(trimmed)];
        return { html: params.map(([k, v]) => `<span class="k">${esc(k)}</span> = <span class="str">${esc(v)}</span>`).join('\n'), pretty: true };
      } catch { /* no */ }
    }
    return { html: esc(text), pretty: false };
  }

  function bodySection(side, r) {
    const body = r[`${side}_body`];
    const enc = r[`${side}_body_encoding`];
    const size = r[`${side}_body_size`];
    const truncated = r[`${side}_body_truncated`];
    const ct = r[`${side}_content_type`] || headerValue(r[`${side}_headers`], 'content-type') || '';
    const ce = headerValue(r[`${side}_headers`], 'content-encoding');
    const mode = state.bodyMode[side] || 'pretty';
    let content;
    if (!size) content = '<p class="muted">Empty body.</p>';
    else if (body == null) {
      content = r.kind === 'tunnel'
        ? '<p class="note">This is an encrypted CONNECT tunnel, so the payload is not visible. Turn on <b>MITM</b> for this proxy (and trust the CA on the client) to see HTTPS requests and bodies.</p>'
        : '<p class="note">Body capture is off for this proxy.</p>';
    } else if (enc === 'base64') {
      if (/^image\//i.test(ct) && !truncated) {
        content = `<img class="body-img" alt="response image" src="data:${esc(ct.split(';')[0])};base64,${body}">`;
      } else {
        content = `<p class="note">Binary content (${esc(ct || 'unknown type')}). Showing base64.</p><pre class="code">${esc(body.slice(0, 20000))}${body.length > 20000 ? '\n…' : ''}</pre>`;
      }
    } else {
      const pretty = prettyBody(body, ct);
      const html = mode === 'raw' || !pretty.pretty ? esc(body) : pretty.html;
      content = `<pre class="code">${html}</pre>`;
    }
    const canToggle = body != null && enc === 'utf8';
    return `<div class="section">
      <div class="section-head">
        <h4>${side === 'req' ? 'Request' : 'Response'} body <span class="muted mono small">${fmtBytes(size)}${ce ? ` · ${esc(ce)} (decoded)` : ''}</span></h4>
        <div class="row gap">
          ${canToggle ? `<button class="btn btn-sm" data-body-mode="${side}">${mode === 'raw' ? 'Pretty' : 'Raw'}</button>` : ''}
          ${body != null ? `<button class="btn btn-sm" data-copy-body="${side}">Copy</button>` : ''}
        </div>
      </div>
      ${truncated ? `<p class="note warn">Truncated: only the first ${fmtBytes(state.system?.captureMaxBody)} were captured.</p>` : ''}
      ${content}
    </div>`;
  }

  function renderDrawer() {
    const r = state.selected;
    if (!r) return;
    $('#drawer-title').innerHTML = `${methodBadge(r.method)} ${statusBadge(r)} <span class="u" title="${esc(r.url)}">${esc(r.url || r.host)}</span>`;
    const body = $('#drawer-body');
    if (state.drawerTab === 'overview') {
      const rows = [
        ['Time', fmtDateTime(r.ts)],
        ['Proxy', `${r.proxy_name || '?'} (port ${r.proxy_port})`],
        ['Client IP', r.client_ip],
        ['Type', { http: 'HTTP', https: 'HTTPS (decrypted via MITM)', tunnel: 'CONNECT tunnel (encrypted)', ws: 'WebSocket' }[r.kind] || r.kind],
        ['Method', r.method],
        ['URL', r.url],
        ['Host', r.host],
        ['Status', r.status ?? '—'],
        ['Duration', fmtMs(r.duration_ms) + (r.active ? ' (still open)' : '')],
        ['Request body', fmtBytes(r.req_body_size)],
        ['Response body', fmtBytes(r.res_body_size)],
        ['Bytes ↑ / ↓', `${fmtBytes(r.bytes_up)} / ${fmtBytes(r.bytes_down)}`],
        ['Req content-type', r.req_content_type || '—'],
        ['Res content-type', r.res_content_type || '—'],
      ];
      body.innerHTML = `
        ${r.error ? `<div class="section"><p class="note err"><b>Error:</b> ${esc(r.error)}</p></div>` : ''}
        ${r.kind === 'tunnel' ? '<div class="section"><p class="note">Encrypted tunnel: only host, timing and byte counts are visible. Enable <b>MITM</b> on the proxy to inspect HTTPS.</p></div>' : ''}
        <div class="section"><dl class="kv">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl></div>`;
    } else if (state.drawerTab === 'request') {
      body.innerHTML = `
        <div class="section">
          <div class="section-head"><h4>Request line</h4></div>
          <pre class="code">${esc(`${r.method} ${r.url}`)}</pre>
        </div>
        <div class="section">
          <div class="section-head"><h4>Request headers <span class="muted mono small">${r.req_headers.length}</span></h4><button class="btn btn-sm" data-copy-headers="req">Copy</button></div>
          ${headersTable(r.req_headers)}
        </div>
        ${r.kind === 'tunnel' && !r.req_body_size ? '' : bodySection('req', r)}`;
    } else {
      body.innerHTML = r.status == null && !r.res_headers.length
        ? `<p class="note err">No response received.${r.error ? ` ${esc(r.error)}` : ''}</p>`
        : `<div class="section">
            <div class="section-head"><h4>Response headers <span class="muted mono small">${r.res_headers.length}</span></h4><button class="btn btn-sm" data-copy-headers="res">Copy</button></div>
            ${headersTable(r.res_headers)}
          </div>
          ${bodySection('res', r)}`;
    }
  }

  $('#drawer-body').addEventListener('click', (e) => {
    const r = state.selected;
    const mode = e.target.closest('[data-body-mode]');
    if (mode) {
      const side = mode.dataset.bodyMode;
      state.bodyMode[side] = state.bodyMode[side] === 'raw' ? 'pretty' : 'raw';
      return renderDrawer();
    }
    const cb = e.target.closest('[data-copy-body]');
    if (cb) return copy(r[`${cb.dataset.copyBody}_body`] || '', 'Body copied');
    const ch = e.target.closest('[data-copy-headers]');
    if (ch) return copy(r[`${ch.dataset.copyHeaders}_headers`].map(([k, v]) => `${k}: ${v}`).join('\n'), 'Headers copied');
  });

  function shellQuote(s) {
    return `'${String(s).replace(/'/g, `'\\''`)}'`;
  }

  function toCurl(r) {
    const proxy = state.proxies.find((p) => p.id === r.proxy_id);
    const parts = ['curl'];
    if (proxy) parts.push('-x', shellQuote(proxyUrl(proxy)));
    if (r.kind === 'https') parts.push('--cacert', 'ca.crt');
    if (r.method && r.method !== 'GET') parts.push('-X', r.method);
    parts.push(shellQuote(r.url));
    const skip = new Set(['host', 'content-length', 'proxy-authorization', 'proxy-connection', 'connection', 'accept-encoding']);
    for (const [k, v] of r.req_headers || []) if (!skip.has(k.toLowerCase())) parts.push('-H', shellQuote(`${k}: ${v}`));
    if (headerValue(r.req_headers, 'accept-encoding')) parts.push('--compressed');
    if (r.req_body && r.req_body_encoding === 'utf8') parts.push('--data-raw', shellQuote(r.req_body));
    return parts.join(' \\\n  ');
  }

  $('#copy-curl').addEventListener('click', () => {
    if (!state.selected) return;
    if (state.selected.kind === 'tunnel') return toast('Tunnels have no request to replay', 'info');
    copy(toCurl(state.selected), 'cURL copied');
  });
  $('#copy-url').addEventListener('click', () => state.selected && copy(state.selected.url || state.selected.host, 'URL copied'));

  // ---------------------------------------------------------------- settings

  async function renderSettings() {
    const s = state.system;
    $('#ca-fp').textContent = `SHA-256: ${s.caFingerprint}`;
    $('#system-info').innerHTML = [
      ['Public host', s.publicHost],
      ['Panel port', s.panelPort],
      ['Proxy port range', `${s.portMin} – ${s.portMax}`],
      ['Max captured body', fmtBytes(s.captureMaxBody)],
      ['Log retention', `${s.logRetentionHours} h / ${fmtNum(s.logMaxRows)} rows`],
      ['Verify upstream TLS', s.mitmVerifyUpstream ? 'yes' : 'no'],
    ].map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');
    const p = state.proxies[0];
    const url = p ? proxyUrl(p) : `http://user:pass@${s.publicHost}:PORT`;
    $('#quick-test').textContent = [
      '# plain HTTP (fully visible)',
      `curl -x ${url} http://httpbin.org/get`,
      '',
      '# HTTPS through a MITM proxy',
      `curl --cacert ca.crt -x ${url} https://httpbin.org/anything -d '{"hello":"world"}' -H 'content-type: application/json'`,
      '',
      '# environment variables',
      `export HTTP_PROXY=${url}`,
      `export HTTPS_PROXY=${url}`,
    ].join('\n');
    await renderBanned();
  }

  async function renderBanned() {
    const list = await api('banned-ports');
    $('#banned-list').innerHTML = list.length
      ? list.map((b) => `<span class="banned-item" title="${esc(b.reason || '')} · ${esc(fmtDateTime(b.banned_at))}">${b.port}<button data-unban="${b.port}" title="Unban">✕</button></span>`).join('')
      : '<p class="muted">No banned ports.</p>';
  }

  $('#banned-list').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-unban]');
    if (!b) return;
    await api(`banned-ports/${b.dataset.unban}`, { method: 'DELETE' });
    toast(`Port ${b.dataset.unban} unbanned`, 'info');
    renderBanned();
  });

  $('#ban-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      await api('banned-ports', { method: 'POST', body: { port: Number(fd.get('port')), reason: fd.get('reason') } });
      e.target.reset();
      toast('Port banned');
      renderBanned();
    } catch (err) {
      toast(err.message, 'err');
    }
  });

  // ---------------------------------------------------------------- boot

  initTheme();
  api('me').then(showApp).catch(() => showLogin());
})();
