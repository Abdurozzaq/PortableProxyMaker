const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const env = process.env;

function int(name, def) {
  const v = parseInt(env[name], 10);
  return Number.isFinite(v) ? v : def;
}

function bool(name, def) {
  if (env[name] === undefined || env[name] === '') return def;
  return ['1', 'true', 'yes', 'on'].includes(String(env[name]).toLowerCase());
}

const DATA_DIR = path.resolve(env.DATA_DIR || path.join(__dirname, '..', '..', 'data'));
fs.mkdirSync(DATA_DIR, { recursive: true });

// Secrets that are generated once and persisted in the data volume so they
// survive container restarts.
function persistedSecret(file, generate) {
  const p = path.join(DATA_DIR, file);
  if (fs.existsSync(p)) return { value: fs.readFileSync(p, 'utf8').trim(), generated: false };
  const value = generate();
  fs.writeFileSync(p, value + '\n', { mode: 0o600 });
  return { value, generated: true };
}

const adminPassword = env.ADMIN_PASSWORD
  ? { value: env.ADMIN_PASSWORD, generated: false }
  : persistedSecret('admin_password.txt', () => crypto.randomBytes(9).toString('base64url'));

const sessionSecret = env.SESSION_SECRET
  ? { value: env.SESSION_SECRET }
  : persistedSecret('session_secret.txt', () => crypto.randomBytes(32).toString('hex'));

const config = {
  dataDir: DATA_DIR,
  dbFile: path.join(DATA_DIR, 'proxymaker.db'),
  caDir: path.join(DATA_DIR, 'ca'),

  panelHost: env.PANEL_HOST || '0.0.0.0',
  panelPort: int('PANEL_PORT', 8080),
  adminUser: env.ADMIN_USER || 'admin',
  adminPassword: adminPassword.value,
  adminPasswordGenerated: adminPassword.generated,
  sessionSecret: sessionSecret.value,
  sessionTtlHours: int('SESSION_TTL_HOURS', 24),

  // Address shown in the panel when building proxy URLs (your server's public IP/domain).
  publicHost: env.PUBLIC_HOST || '',

  proxyBindHost: env.PROXY_BIND_HOST || '0.0.0.0',
  portMin: int('PROXY_PORT_MIN', 20000),
  portMax: int('PROXY_PORT_MAX', 29999),

  upstreamTimeoutMs: int('UPSTREAM_TIMEOUT_MS', 60000),
  mitmVerifyUpstream: bool('MITM_VERIFY_UPSTREAM', true),

  captureMaxBody: int('CAPTURE_MAX_BODY', 512 * 1024),
  logMaxRows: int('LOG_MAX_ROWS', 50000),
  logRetentionHours: int('LOG_RETENTION_HOURS', 72),
};

if (config.portMin > config.portMax) {
  throw new Error('PROXY_PORT_MIN must be <= PROXY_PORT_MAX');
}

module.exports = config;
