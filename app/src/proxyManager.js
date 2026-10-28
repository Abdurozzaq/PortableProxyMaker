// Owns proxy definitions (stored in SQLite) and their running ProxyInstance.
const net = require('net');
const crypto = require('crypto');
const db = require('./db');
const config = require('./config');
const bus = require('./events');
const ProxyInstance = require('./proxyServer');

const instances = new Map();

const BOOL_FIELDS = ['mitm', 'capture_body', 'log_enabled', 'enabled'];

function rowToDef(row) {
  if (!row) return null;
  const def = { ...row, port_history: JSON.parse(row.port_history || '[]') };
  for (const f of BOOL_FIELDS) def[f] = !!row[f];
  return def;
}

function randomId() {
  return crypto.randomBytes(6).toString('hex');
}

function randomCredential(len) {
  const alphabet = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(len);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

function isPortFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, config.proxyBindHost, () => srv.close(() => resolve(true)));
  });
}

function usedPorts() {
  const used = new Set(db.prepare('SELECT port FROM proxies').all().map((r) => r.port));
  for (const r of db.prepare('SELECT port FROM banned_ports').all()) used.add(r.port);
  used.add(config.panelPort);
  return used;
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function pickPort(reserved = new Set()) {
  const used = usedPorts();
  const span = config.portMax - config.portMin + 1;
  for (let attempt = 0; attempt < 200; attempt++) {
    const port = config.portMin + crypto.randomInt(span);
    if (used.has(port) || reserved.has(port)) continue;
    if (await isPortFree(port)) return port;
  }
  throw new HttpError(409, 'No free port found in the configured range');
}

async function validatePort(port, ownId) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new HttpError(400, 'Invalid port');
  if (port === config.panelPort) throw new HttpError(409, 'That port is used by the panel');
  const owner = db.prepare('SELECT id, name FROM proxies WHERE port = ?').get(port);
  if (owner && owner.id !== ownId) throw new HttpError(409, `Port ${port} is already used by proxy "${owner.name}"`);
  const banned = db.prepare('SELECT port FROM banned_ports WHERE port = ?').get(port);
  if (banned) throw new HttpError(409, `Port ${port} is on the banned list`);
  if (!owner && !(await isPortFree(port))) throw new HttpError(409, `Port ${port} is in use on this server`);
}

function getDef(id) {
  return rowToDef(db.prepare('SELECT * FROM proxies WHERE id = ?').get(id));
}

function view(def) {
  const inst = instances.get(def.id);
  return {
    ...def,
    runtime: inst ? inst.runtime() : { status: 'stopped', error: null, activeConnections: 0 },
  };
}

function list() {
  return db.prepare('SELECT * FROM proxies ORDER BY created_at ASC').all().map(rowToDef).map(view);
}

function get(id) {
  const def = getDef(id);
  if (!def) throw new HttpError(404, 'Proxy not found');
  return view(def);
}

function emitChange(id) {
  const def = getDef(id);
  bus.emit('proxy-changed', def ? view(def) : { id, deleted: true });
}

async function startInstance(def) {
  let inst = instances.get(def.id);
  if (!inst) {
    inst = new ProxyInstance(def);
    instances.set(def.id, inst);
  }
  inst.def = def;
  return inst.start();
}

async function stopInstance(id) {
  const inst = instances.get(id);
  if (inst) {
    await inst.stop();
    instances.delete(id);
  }
}

function normalizeAuth(input, existing) {
  // auth: "none" | "random" | "custom"
  const mode = input.auth || (input.username ? 'custom' : existing ? 'keep' : 'random');
  if (mode === 'keep') return { username: existing.username, password: existing.password };
  if (mode === 'none') return { username: null, password: null };
  if (mode === 'random') return { username: 'u' + randomCredential(7), password: randomCredential(14) };
  const username = String(input.username || '').trim();
  const password = String(input.password || '');
  if (!username) throw new HttpError(400, 'Username is required for custom auth');
  if (username.includes(':')) throw new HttpError(400, 'Username must not contain ":"');
  return { username, password };
}

function cleanOutboundIp(value) {
  const ip = String(value || '').trim();
  if (!ip) return null;
  if (!net.isIP(ip)) throw new HttpError(400, 'Outbound IP must be a valid IPv4/IPv6 address');
  return ip;
}

async function create(input) {
  const count = Math.min(Math.max(parseInt(input.count, 10) || 1, 1), 50);
  const baseName = String(input.name || '').trim() || 'proxy';
  const created = [];
  const reserved = new Set();
  for (let i = 0; i < count; i++) {
    let port;
    if (count === 1 && input.port) {
      port = parseInt(input.port, 10);
      await validatePort(port, null);
    } else {
      port = await pickPort(reserved);
    }
    reserved.add(port);
    const auth = normalizeAuth(input, null);
    const now = Date.now();
    const def = {
      id: randomId(),
      name: count > 1 ? `${baseName}-${i + 1}` : baseName,
      port,
      username: auth.username,
      password: auth.password,
      mitm: input.mitm ? 1 : 0,
      capture_body: input.capture_body === false ? 0 : 1,
      log_enabled: input.log_enabled === false ? 0 : 1,
      enabled: input.enabled === false ? 0 : 1,
      outbound_ip: cleanOutboundIp(input.outbound_ip),
      note: input.note ? String(input.note).slice(0, 500) : null,
      port_history: '[]',
      created_at: now,
      updated_at: now,
    };
    db.prepare(`INSERT INTO proxies (id, name, port, username, password, mitm, capture_body, log_enabled,
      enabled, outbound_ip, note, port_history, created_at, updated_at)
      VALUES ($id, $name, $port, $username, $password, $mitm, $capture_body, $log_enabled, $enabled,
      $outbound_ip, $note, $port_history, $created_at, $updated_at)`).run(prefix(def));
    const full = getDef(def.id);
    if (full.enabled) await startInstance(full);
    created.push(view(full));
    emitChange(def.id);
  }
  return created;
}

function prefix(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) out['$' + k] = v === undefined ? null : v;
  return out;
}

async function update(id, input) {
  const existing = getDef(id);
  if (!existing) throw new HttpError(404, 'Proxy not found');
  const next = { ...existing };
  if (input.name !== undefined) next.name = String(input.name).trim() || existing.name;
  if (input.note !== undefined) next.note = input.note ? String(input.note).slice(0, 500) : null;
  if (input.auth !== undefined || input.username !== undefined) Object.assign(next, normalizeAuth(input, existing));
  for (const f of ['mitm', 'capture_body', 'log_enabled']) if (input[f] !== undefined) next[f] = !!input[f];
  if (input.outbound_ip !== undefined) next.outbound_ip = cleanOutboundIp(input.outbound_ip);

  let portChanged = false;
  if (input.port !== undefined && input.port !== '' && Number(input.port) !== existing.port) {
    const port = parseInt(input.port, 10);
    await validatePort(port, id);
    next.port_history = [...existing.port_history, { port: existing.port, until: Date.now(), reason: 'manual change' }].slice(-20);
    next.port = port;
    portChanged = true;
  }
  save(next);
  const fresh = getDef(id);
  const inst = instances.get(id);
  if (inst) {
    if (portChanged || fresh.outbound_ip !== existing.outbound_ip) {
      await stopInstance(id);
      if (fresh.enabled) await startInstance(fresh);
    } else {
      inst.def = fresh; // auth/mitm/logging changes apply to new requests immediately
    }
  }
  emitChange(id);
  return view(fresh);
}

function save(def) {
  db.prepare(`UPDATE proxies SET name = $name, port = $port, username = $username, password = $password,
    mitm = $mitm, capture_body = $capture_body, log_enabled = $log_enabled, enabled = $enabled,
    outbound_ip = $outbound_ip, note = $note, port_history = $port_history, updated_at = $updated_at
    WHERE id = $id`).run(prefix({
    id: def.id,
    name: def.name,
    port: def.port,
    username: def.username,
    password: def.password,
    mitm: def.mitm ? 1 : 0,
    capture_body: def.capture_body ? 1 : 0,
    log_enabled: def.log_enabled ? 1 : 0,
    enabled: def.enabled ? 1 : 0,
    outbound_ip: def.outbound_ip,
    note: def.note,
    port_history: JSON.stringify(def.port_history || []),
    updated_at: Date.now(),
  }));
}

async function setEnabled(id, enabled) {
  const def = getDef(id);
  if (!def) throw new HttpError(404, 'Proxy not found');
  def.enabled = enabled;
  save(def);
  if (enabled) await startInstance(getDef(id));
  else await stopInstance(id);
  emitChange(id);
  return get(id);
}

// Move a proxy to a new port (e.g. because the old one got blacklisted).
async function rotate(id, { port, ban = true, reason } = {}) {
  const def = getDef(id);
  if (!def) throw new HttpError(404, 'Proxy not found');
  const oldPort = def.port;
  let newPort;
  if (port) {
    newPort = parseInt(port, 10);
    await validatePort(newPort, id);
    if (newPort === oldPort) throw new HttpError(400, 'New port is the same as the current port');
  } else {
    newPort = await pickPort(new Set([oldPort]));
  }
  await stopInstance(id);
  if (ban) {
    db.prepare('INSERT OR REPLACE INTO banned_ports (port, reason, banned_at) VALUES (?, ?, ?)')
      .run(oldPort, reason || `rotated from proxy "${def.name}"`, Date.now());
  }
  def.port_history = [...def.port_history, { port: oldPort, until: Date.now(), reason: ban ? 'rotated + banned' : 'rotated' }].slice(-20);
  def.port = newPort;
  save(def);
  const fresh = getDef(id);
  if (fresh.enabled) await startInstance(fresh);
  emitChange(id);
  return { proxy: view(fresh), oldPort, newPort };
}

async function remove(id) {
  const def = getDef(id);
  if (!def) throw new HttpError(404, 'Proxy not found');
  await stopInstance(id);
  db.prepare('DELETE FROM proxies WHERE id = ?').run(id);
  emitChange(id);
}

function bannedPorts() {
  return db.prepare('SELECT * FROM banned_ports ORDER BY banned_at DESC').all();
}

function unbanPort(port) {
  db.prepare('DELETE FROM banned_ports WHERE port = ?').run(Number(port));
}

function banPort(port, reason) {
  const p = parseInt(port, 10);
  if (!Number.isInteger(p) || p < 1 || p > 65535) throw new HttpError(400, 'Invalid port');
  db.prepare('INSERT OR REPLACE INTO banned_ports (port, reason, banned_at) VALUES (?, ?, ?)')
    .run(p, reason ? String(reason).slice(0, 200) : 'manual', Date.now());
}

async function startAll() {
  const defs = db.prepare('SELECT * FROM proxies WHERE enabled = 1').all().map(rowToDef);
  for (const def of defs) await startInstance(def);
  return defs.length;
}

async function stopAll() {
  await Promise.all([...instances.keys()].map((id) => stopInstance(id)));
}

module.exports = {
  HttpError, list, get, create, update, remove, setEnabled, rotate,
  bannedPorts, banPort, unbanPort, startAll, stopAll,
};
