const { DatabaseSync } = require('node:sqlite');
const config = require('./config');

const db = new DatabaseSync(config.dbFile);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;

  CREATE TABLE IF NOT EXISTS proxies (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    port          INTEGER NOT NULL UNIQUE,
    username      TEXT,
    password      TEXT,
    mitm          INTEGER NOT NULL DEFAULT 0,
    capture_body  INTEGER NOT NULL DEFAULT 1,
    log_enabled   INTEGER NOT NULL DEFAULT 1,
    enabled       INTEGER NOT NULL DEFAULT 1,
    outbound_ip   TEXT,
    note          TEXT,
    port_history  TEXT NOT NULL DEFAULT '[]',
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS banned_ports (
    port       INTEGER PRIMARY KEY,
    reason     TEXT,
    banned_at  INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS logs (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    ts                  INTEGER NOT NULL,
    proxy_id            TEXT,
    proxy_name          TEXT,
    proxy_port          INTEGER,
    client_ip           TEXT,
    kind                TEXT NOT NULL,          -- http | https | tunnel | ws
    method              TEXT,
    host                TEXT,
    url                 TEXT,
    status              INTEGER,
    duration_ms         INTEGER,
    req_headers         TEXT,
    req_body            TEXT,
    req_body_encoding   TEXT,                   -- utf8 | base64
    req_body_size       INTEGER DEFAULT 0,
    req_body_truncated  INTEGER DEFAULT 0,
    res_headers         TEXT,
    res_body            TEXT,
    res_body_encoding   TEXT,
    res_body_size       INTEGER DEFAULT 0,
    res_body_truncated  INTEGER DEFAULT 0,
    req_content_type    TEXT,
    res_content_type    TEXT,
    bytes_up            INTEGER DEFAULT 0,
    bytes_down          INTEGER DEFAULT 0,
    error               TEXT,
    active              INTEGER DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs(ts);
  CREATE INDEX IF NOT EXISTS idx_logs_proxy ON logs(proxy_id, id);
  CREATE INDEX IF NOT EXISTS idx_logs_status ON logs(status);
`);

// Tunnels still marked active from a previous run are closed now.
db.exec(`UPDATE logs SET active = 0 WHERE active = 1`);

module.exports = db;
