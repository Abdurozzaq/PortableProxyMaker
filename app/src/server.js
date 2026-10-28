const path = require('path');
const express = require('express');
const config = require('./config');
const bus = require('./events');
const auth = require('./auth');
const mitm = require('./mitm');
const logStore = require('./logStore');
const manager = require('./proxyManager');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 'loopback');
app.use(express.json({ limit: '256kb' }));

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---- public ---------------------------------------------------------------
app.post('/api/login', auth.login);
app.post('/api/logout', auth.logout);

// ---- authenticated --------------------------------------------------------
const api = express.Router();
api.use(auth.requireAuth);

api.get('/me', (req, res) => res.json({ user: req.user }));

api.get('/system', (req, res) => {
  res.json({
    publicHost: config.publicHost || req.hostname,
    portMin: config.portMin,
    portMax: config.portMax,
    panelPort: config.panelPort,
    captureMaxBody: config.captureMaxBody,
    logMaxRows: config.logMaxRows,
    logRetentionHours: config.logRetentionHours,
    mitmVerifyUpstream: config.mitmVerifyUpstream,
    caFingerprint: mitm.caFingerprint(),
  });
});

api.get('/proxies', (req, res) => res.json(manager.list()));
api.get('/proxies/:id', (req, res) => res.json(manager.get(req.params.id)));
api.post('/proxies', wrap(async (req, res) => res.status(201).json(await manager.create(req.body || {}))));
api.patch('/proxies/:id', wrap(async (req, res) => res.json(await manager.update(req.params.id, req.body || {}))));
api.delete('/proxies/:id', wrap(async (req, res) => {
  await manager.remove(req.params.id);
  res.json({ ok: true });
}));
api.post('/proxies/:id/start', wrap(async (req, res) => res.json(await manager.setEnabled(req.params.id, true))));
api.post('/proxies/:id/stop', wrap(async (req, res) => res.json(await manager.setEnabled(req.params.id, false))));
api.post('/proxies/:id/rotate', wrap(async (req, res) => res.json(await manager.rotate(req.params.id, req.body || {}))));

api.get('/banned-ports', (req, res) => res.json(manager.bannedPorts()));
api.post('/banned-ports', (req, res) => {
  manager.banPort(req.body?.port, req.body?.reason);
  res.json({ ok: true });
});
api.delete('/banned-ports/:port', (req, res) => {
  manager.unbanPort(req.params.port);
  res.json({ ok: true });
});

api.get('/logs', (req, res) => res.json(logStore.list(req.query)));
api.get('/logs/:id', (req, res) => {
  const row = logStore.get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Log entry not found' });
  res.json(row);
});
api.delete('/logs', (req, res) => {
  logStore.clear(req.query.proxyId);
  res.json({ ok: true });
});

api.get('/stats', (req, res) => res.json(logStore.stats()));

api.get('/ca.crt', (req, res) => {
  res.setHeader('Content-Type', 'application/x-x509-ca-cert');
  res.setHeader('Content-Disposition', 'attachment; filename="portable-proxy-maker-ca.crt"');
  res.send(mitm.caCertPem());
});

// Server-sent events: live traffic + proxy status for the panel.
api.get('/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');
  const send = (event) => (data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const handlers = {
    log: send('log'),
    'log-update': send('log-update'),
    'logs-cleared': send('logs-cleared'),
    'proxy-status': send('proxy-status'),
    'proxy-changed': send('proxy-changed'),
  };
  for (const [e, h] of Object.entries(handlers)) bus.on(e, h);
  const ping = setInterval(() => res.write(': ping\n\n'), 20000);
  req.on('close', () => {
    clearInterval(ping);
    for (const [e, h] of Object.entries(handlers)) bus.off(e, h);
  });
});

app.use('/api', api);
app.use(express.static(path.join(__dirname, '..', 'public'), { index: 'index.html' }));

app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: err.message || 'Internal error' });
});

async function main() {
  mitm.init();
  const started = await manager.startAll();
  app.listen(config.panelPort, config.panelHost, () => {
    console.log(`[ppm] panel listening on http://${config.panelHost}:${config.panelPort}`);
    console.log(`[ppm] proxy port range ${config.portMin}-${config.portMax}, ${started} proxy(s) started`);
    if (config.adminPasswordGenerated) {
      console.log(`[ppm] ADMIN_PASSWORD not set; generated one and saved it to ${config.dataDir}/admin_password.txt`);
      console.log(`[ppm] login: ${config.adminUser} / ${config.adminPassword}`);
    }
  });
}

async function shutdown(signal) {
  console.log(`[ppm] ${signal} received, stopping proxies`);
  await manager.stopAll();
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
