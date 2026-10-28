// Panel login: stateless HMAC-signed session cookie + simple brute-force throttle.
const crypto = require('crypto');
const config = require('./config');

const COOKIE = 'ppm_session';
const failures = new Map(); // ip -> { count, until }
const MAX_FAILS = 5;
const LOCK_MS = 15 * 60 * 1000;

function sign(payload) {
  return crypto.createHmac('sha256', config.sessionSecret).update(payload).digest('base64url');
}

function issue() {
  const payload = Buffer.from(JSON.stringify({ u: config.adminUser, exp: Date.now() + config.sessionTtlHours * 3600 * 1000 })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

function verify(token) {
  if (!token || !token.includes('.')) return null;
  const [payload, sig] = token.split('.');
  const expected = sign(payload);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return data.exp > Date.now() ? data : null;
  } catch {
    return null;
  }
}

function readCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function login(req, res) {
  const ip = req.ip;
  const f = failures.get(ip);
  if (f && f.until > Date.now()) {
    return res.status(429).json({ error: 'Too many failed attempts. Try again later.' });
  }
  const { username, password } = req.body || {};
  const ok = safeEqual(username || '', config.adminUser) & safeEqual(password || '', config.adminPassword);
  if (!ok) {
    const lockExpired = f && f.until && f.until <= Date.now();
    const next = { count: (f && !lockExpired ? f.count : 0) + 1, until: 0 };
    if (next.count >= MAX_FAILS) next.until = Date.now() + LOCK_MS;
    failures.set(ip, next);
    return res.status(401).json({ error: 'Wrong username or password' });
  }
  failures.delete(ip);
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  res.setHeader('Set-Cookie', `${COOKIE}=${issue()}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${config.sessionTtlHours * 3600}${secure ? '; Secure' : ''}`);
  res.json({ ok: true, user: config.adminUser });
}

function logout(req, res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
  res.json({ ok: true });
}

function requireAuth(req, res, next) {
  const session = verify(readCookie(req, COOKIE));
  if (!session) return res.status(401).json({ error: 'Not logged in' });
  req.user = session.u;
  next();
}

module.exports = { login, logout, requireAuth };
