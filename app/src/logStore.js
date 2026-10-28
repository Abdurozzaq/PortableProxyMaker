const db = require('./db');
const bus = require('./events');
const config = require('./config');

const SUMMARY_COLS = `id, ts, proxy_id, proxy_name, proxy_port, client_ip, kind, method, host, url,
  status, duration_ms, req_body_size, res_body_size, req_content_type, res_content_type,
  bytes_up, bytes_down, error, active`;

const insertStmt = db.prepare(`
  INSERT INTO logs (ts, proxy_id, proxy_name, proxy_port, client_ip, kind, method, host, url, status,
    duration_ms, req_headers, req_body, req_body_encoding, req_body_size, req_body_truncated,
    res_headers, res_body, res_body_encoding, res_body_size, res_body_truncated,
    req_content_type, res_content_type, bytes_up, bytes_down, error, active)
  VALUES ($ts, $proxy_id, $proxy_name, $proxy_port, $client_ip, $kind, $method, $host, $url, $status,
    $duration_ms, $req_headers, $req_body, $req_body_encoding, $req_body_size, $req_body_truncated,
    $res_headers, $res_body, $res_body_encoding, $res_body_size, $res_body_truncated,
    $req_content_type, $res_content_type, $bytes_up, $bytes_down, $error, $active)
`);

const DEFAULTS = {
  proxy_id: null, proxy_name: null, proxy_port: null, client_ip: null, method: null, host: null,
  url: null, status: null, duration_ms: null, req_headers: null, req_body: null,
  req_body_encoding: null, req_body_size: 0, req_body_truncated: 0, res_headers: null,
  res_body: null, res_body_encoding: null, res_body_size: 0, res_body_truncated: 0,
  req_content_type: null, res_content_type: null, bytes_up: 0, bytes_down: 0, error: null, active: 0,
};

function serialize(entry) {
  const row = { ...DEFAULTS, ...entry };
  if (Array.isArray(row.req_headers)) row.req_headers = JSON.stringify(row.req_headers);
  if (Array.isArray(row.res_headers)) row.res_headers = JSON.stringify(row.res_headers);
  row.req_body_truncated = row.req_body_truncated ? 1 : 0;
  row.res_body_truncated = row.res_body_truncated ? 1 : 0;
  row.active = row.active ? 1 : 0;
  return row;
}

const getSummaryStmt = db.prepare(`SELECT ${SUMMARY_COLS} FROM logs WHERE id = ?`);

function insert(entry) {
  const row = serialize(entry);
  const prefixed = {};
  for (const [k, v] of Object.entries(row)) prefixed['$' + k] = v === undefined ? null : v;
  const { lastInsertRowid } = insertStmt.run(prefixed);
  const id = Number(lastInsertRowid);
  bus.emit('log', getSummaryStmt.get(id));
  return id;
}

const UPDATABLE = new Set(['status', 'duration_ms', 'bytes_up', 'bytes_down', 'error', 'active']);

function update(id, fields) {
  const keys = Object.keys(fields).filter((k) => UPDATABLE.has(k));
  if (!keys.length) return;
  const params = {};
  for (const k of keys) params['$' + k] = typeof fields[k] === 'boolean' ? (fields[k] ? 1 : 0) : fields[k];
  params.$id = id;
  db.prepare(`UPDATE logs SET ${keys.map((k) => `${k} = $${k}`).join(', ')} WHERE id = $id`).run(params);
  bus.emit('log-update', getSummaryStmt.get(id));
}

function list({ proxyId, method, status, kind, q, beforeId, limit = 100 }) {
  const where = [];
  const params = {};
  if (proxyId) { where.push('proxy_id = $proxyId'); params.$proxyId = proxyId; }
  if (method) { where.push('method = $method'); params.$method = method.toUpperCase(); }
  if (kind) { where.push('kind = $kind'); params.$kind = kind; }
  if (status) {
    if (status === 'error') where.push('(error IS NOT NULL OR status >= 500 OR status IS NULL)');
    else if (/^[1-5]xx$/.test(status)) {
      where.push('status >= $smin AND status < $smax');
      params.$smin = Number(status[0]) * 100;
      params.$smax = Number(status[0]) * 100 + 100;
    } else if (/^\d{3}$/.test(status)) { where.push('status = $status'); params.$status = Number(status); }
  }
  if (q) {
    where.push('(url LIKE $q OR host LIKE $q OR client_ip LIKE $q OR error LIKE $q)');
    params.$q = `%${q}%`;
  }
  if (beforeId) { where.push('id < $beforeId'); params.$beforeId = Number(beforeId); }
  params.$limit = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const sql = `SELECT ${SUMMARY_COLS} FROM logs ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY id DESC LIMIT $limit`;
  return db.prepare(sql).all(params);
}

function get(id) {
  const row = db.prepare('SELECT * FROM logs WHERE id = ?').get(Number(id));
  if (!row) return null;
  row.req_headers = row.req_headers ? JSON.parse(row.req_headers) : [];
  row.res_headers = row.res_headers ? JSON.parse(row.res_headers) : [];
  return row;
}

function clear(proxyId) {
  if (proxyId) db.prepare('DELETE FROM logs WHERE proxy_id = ?').run(proxyId);
  else db.exec('DELETE FROM logs');
  bus.emit('logs-cleared', { proxyId: proxyId || null });
}

function stats() {
  const now = Date.now();
  const since24h = now - 24 * 3600 * 1000;
  const since60m = now - 60 * 60 * 1000;

  const totals = db.prepare(`
    SELECT COUNT(*) AS requests,
      SUM(CASE WHEN error IS NOT NULL OR status >= 500 THEN 1 ELSE 0 END) AS errors,
      COALESCE(SUM(bytes_up), 0) AS bytes_up,
      COALESCE(SUM(bytes_down), 0) AS bytes_down,
      CAST(AVG(duration_ms) AS INTEGER) AS avg_ms
    FROM logs WHERE ts >= ?`).get(since24h);

  const perMinute = db.prepare(`
    SELECT (ts / 60000) * 60000 AS minute, COUNT(*) AS count,
      SUM(CASE WHEN error IS NOT NULL OR status >= 500 THEN 1 ELSE 0 END) AS errors
    FROM logs WHERE ts >= ? GROUP BY minute ORDER BY minute`).all(since60m);

  const statusGroups = db.prepare(`
    SELECT CASE
      WHEN error IS NOT NULL AND status IS NULL THEN 'ERR'
      WHEN status IS NULL THEN 'ERR'
      ELSE CAST(status / 100 AS TEXT) || 'xx' END AS grp, COUNT(*) AS count
    FROM logs WHERE ts >= ? GROUP BY grp ORDER BY grp`).all(since24h);

  const topHosts = db.prepare(`
    SELECT host, COUNT(*) AS count, COALESCE(SUM(bytes_down), 0) AS bytes_down
    FROM logs WHERE ts >= ? AND host IS NOT NULL GROUP BY host ORDER BY count DESC LIMIT 8`).all(since24h);

  const perProxy = db.prepare(`
    SELECT proxy_id, COUNT(*) AS requests,
      SUM(CASE WHEN error IS NOT NULL OR status >= 500 THEN 1 ELSE 0 END) AS errors,
      COALESCE(SUM(bytes_up), 0) AS bytes_up, COALESCE(SUM(bytes_down), 0) AS bytes_down,
      MAX(ts) AS last_seen
    FROM logs WHERE ts >= ? GROUP BY proxy_id`).all(since24h);

  const recentErrors = db.prepare(`
    SELECT id, ts, proxy_name, method, host, url, status, error FROM logs
    WHERE error IS NOT NULL OR status >= 500 ORDER BY id DESC LIMIT 6`).all();

  return { totals, perMinute, statusGroups, topHosts, perProxy, recentErrors, now };
}

function prune() {
  const cutoff = Date.now() - config.logRetentionHours * 3600 * 1000;
  db.prepare('DELETE FROM logs WHERE ts < ? AND active = 0').run(cutoff);
  const row = db.prepare('SELECT MAX(id) AS maxId FROM logs').get();
  if (row && row.maxId) {
    db.prepare('DELETE FROM logs WHERE id <= ? AND active = 0').run(row.maxId - config.logMaxRows);
  }
}

setInterval(prune, 60 * 1000).unref();

module.exports = { insert, update, list, get, clear, stats, prune };
