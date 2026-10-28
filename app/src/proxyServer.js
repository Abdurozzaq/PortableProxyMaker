// A single forward proxy listening on one port. Handles plain HTTP proxying, CONNECT
// tunnels, optional HTTPS interception (MITM) and websocket upgrades, and records
// every exchange in the traffic log.
const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');
const crypto = require('crypto');
const config = require('./config');
const bus = require('./events');
const logStore = require('./logStore');
const mitm = require('./mitm');
const { stripHopByHop, pairs, BodyRecorder, encodeBody, cleanIp } = require('./capture');

const PROXY_AGENT = 'PortableProxyMaker';
const AUTH_REALM = `Basic realm="${PROXY_AGENT}"`;
const HIDDEN_HEADERS = new Set(['proxy-authorization']);

function parseHostPort(value, defaultPort) {
  const m = /^\[?([^\]\s]+?)\]?(?::(\d{1,5}))?$/.exec(String(value || ''));
  if (!m) return null;
  const port = m[2] ? Number(m[2]) : defaultPort;
  if (!port || port > 65535) return null;
  return { hostname: m[1], port };
}

function hostLabel(hostname, port, defaultPort) {
  const h = hostname.includes(':') ? `[${hostname}]` : hostname;
  return port === defaultPort ? h : `${h}:${port}`;
}

function visibleHeaders(rawHeaders) {
  return pairs(rawHeaders).map(([k, v]) => (HIDDEN_HEADERS.has(k.toLowerCase()) ? [k, '[hidden]'] : [k, v]));
}

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

// Pipes two sockets together, counting bytes in each direction.
function bridge(client, upstream, { onProgress, onClose }) {
  let up = 0;
  let down = 0;
  let closed = false;
  client.on('data', (c) => { up += c.length; });
  upstream.on('data', (c) => { down += c.length; });
  client.pipe(upstream);
  upstream.pipe(client);
  const timer = onProgress ? setInterval(() => onProgress(up, down), 5000) : null;
  const close = (err) => {
    if (closed) return;
    closed = true;
    if (timer) clearInterval(timer);
    client.destroy();
    upstream.destroy();
    onClose(up, down, err);
  };
  client.on('error', close);
  upstream.on('error', close);
  client.on('close', () => close());
  upstream.on('close', () => close());
}

class ProxyInstance {
  constructor(def) {
    this.def = def;
    this.server = null;
    this.inner = null;
    this.status = 'stopped';
    this.error = null;
    this.sockets = new Set();
  }

  get activeConnections() {
    return this.sockets.size;
  }

  runtime() {
    return { status: this.status, error: this.error, activeConnections: this.activeConnections };
  }

  setStatus(status, error = null) {
    this.status = status;
    this.error = error;
    bus.emit('proxy-status', { id: this.def.id, ...this.runtime() });
  }

  start() {
    if (this.server) return Promise.resolve(true);
    const server = http.createServer();
    server.on('request', (req, res) => this.onRequest(req, res));
    server.on('connect', (req, socket, head) => this.onConnect(req, socket, head));
    server.on('upgrade', (req, socket, head) => this.onPlainUpgrade(req, socket, head));
    server.on('connection', (socket) => this.track(socket));
    server.on('clientError', (err, socket) => {
      if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      else socket.destroy();
    });
    server.requestTimeout = 0;

    // Receives decrypted (or plain) connections that arrived through CONNECT.
    const inner = http.createServer();
    inner.on('request', (req, res) => this.onInnerRequest(req, res));
    inner.on('upgrade', (req, socket, head) => this.onInnerUpgrade(req, socket, head));
    inner.on('clientError', (err, socket) => socket.destroy());
    inner.requestTimeout = 0;

    return new Promise((resolve) => {
      server.once('error', (err) => {
        this.server = null;
        this.inner = null;
        const msg = err.code === 'EADDRINUSE'
          ? `Port ${this.def.port} is already in use by another process`
          : err.code === 'EADDRNOTAVAIL' ? `Address not available: ${err.message}` : err.message;
        this.setStatus('error', msg);
        resolve(false);
      });
      server.listen(this.def.port, config.proxyBindHost, () => {
        server.removeAllListeners('error');
        server.on('error', (err) => this.setStatus('error', err.message));
        this.server = server;
        this.inner = inner;
        this.setStatus('running');
        resolve(true);
      });
    });
  }

  stop() {
    const server = this.server;
    this.server = null;
    this.inner = null;
    for (const s of this.sockets) s.destroy();
    this.sockets.clear();
    if (!server) {
      this.setStatus('stopped');
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      server.close(() => {
        this.setStatus('stopped');
        resolve();
      });
    });
  }

  track(socket) {
    this.sockets.add(socket);
    socket.on('close', () => this.sockets.delete(socket));
    socket.on('error', () => {});
  }

  // ---- logging -----------------------------------------------------------

  log(entry) {
    if (!this.def.log_enabled) return null;
    return logStore.insert({
      proxy_id: this.def.id,
      proxy_name: this.def.name,
      proxy_port: this.def.port,
      ...entry,
    });
  }

  logUpdate(id, fields) {
    if (id) logStore.update(id, fields);
  }

  // ---- auth --------------------------------------------------------------

  authFailure(req) {
    if (!this.def.username) return null;
    const header = req.headers['proxy-authorization'];
    if (!header) return 'Proxy authentication required';
    const [scheme, encoded] = header.split(' ');
    if (!scheme || scheme.toLowerCase() !== 'basic' || !encoded) return 'Unsupported proxy auth scheme';
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    const idx = decoded.indexOf(':');
    const user = idx >= 0 ? decoded.slice(0, idx) : decoded;
    const pass = idx >= 0 ? decoded.slice(idx + 1) : '';
    const ok = safeEqual(user, this.def.username) & safeEqual(pass, this.def.password || '');
    return ok ? null : 'Invalid proxy credentials';
  }

  logAuthFailure(req, kind, host, url, reason) {
    this.log({
      ts: Date.now(), client_ip: cleanIp(req.socket.remoteAddress), kind, method: req.method,
      host, url, status: 407, duration_ms: 0, req_headers: visibleHeaders(req.rawHeaders), error: reason,
    });
  }

  // ---- plain HTTP (absolute-URI requests) --------------------------------

  onRequest(req, res) {
    if (!/^https?:\/\//i.test(req.url)) return this.onDirectRequest(req, res);
    let target;
    try { target = new URL(req.url); } catch {
      res.writeHead(400, { 'content-type': 'text/plain' });
      return res.end('Bad request URL');
    }
    const port = Number(target.port) || (target.protocol === 'https:' ? 443 : 80);
    const reason = this.authFailure(req);
    if (reason) {
      this.logAuthFailure(req, 'http', hostLabel(target.hostname, port, 80), req.url, reason);
      res.writeHead(407, { 'proxy-authenticate': AUTH_REALM, 'content-type': 'text/plain' });
      return res.end(reason);
    }
    this.forward(req, res, {
      protocol: target.protocol,
      hostname: target.hostname.replace(/^\[|\]$/g, ''),
      port,
      path: target.pathname + target.search,
      servername: target.hostname,
    }, 'http', cleanIp(req.socket.remoteAddress));
  }

  // Requests aimed at the proxy port itself (not proxied). /__ppm/ping lets the
  // panel check from the user's own network whether this port is reachable.
  onDirectRequest(req, res) {
    if (req.url.startsWith('/__ppm/ping')) {
      res.writeHead(200, {
        'content-type': 'application/json',
        'access-control-allow-origin': '*',
        'cache-control': 'no-store',
      });
      return res.end(JSON.stringify({ ok: true, proxy: this.def.name, port: this.def.port, ts: Date.now() }));
    }
    res.writeHead(400, { 'content-type': 'text/plain' });
    res.end(`${PROXY_AGENT}: this port is an HTTP proxy. Configure it as a proxy in your client.\n`);
  }

  // ---- CONNECT -----------------------------------------------------------

  onConnect(req, socket, head) {
    const target = parseHostPort(req.url, 443);
    if (!target) return socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    const clientIp = cleanIp(socket.remoteAddress);
    const label = hostLabel(target.hostname, target.port, 443);
    const reason = this.authFailure(req);
    if (reason) {
      this.logAuthFailure(req, 'tunnel', label, req.url, reason);
      return socket.end(`HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: ${AUTH_REALM}\r\nContent-Length: 0\r\n\r\n`);
    }
    if (this.def.mitm && !(target.port === 80 && head.length)) {
      return this.intercept(req, socket, target, clientIp);
    }
    this.tunnel(req, socket, head, target, clientIp);
  }

  // Blind TCP tunnel: we only see host, timing and byte counts.
  tunnel(req, socket, head, { hostname, port }, clientIp) {
    const start = Date.now();
    const label = `${hostname}:${port}`;
    const reqHeaders = visibleHeaders(req.rawHeaders);
    const upstream = net.connect({ host: hostname, port, localAddress: this.def.outbound_ip || undefined });
    upstream.setTimeout(config.upstreamTimeoutMs, () => upstream.destroy(new Error('Upstream connect timeout')));

    const onFail = (err) => {
      if (socket.writable) socket.end(`HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n`);
      this.log({
        ts: start, client_ip: clientIp, kind: 'tunnel', method: 'CONNECT', host: label, url: label,
        status: 502, duration_ms: Date.now() - start, req_headers: reqHeaders, error: err.message,
      });
    };
    upstream.once('error', onFail);
    socket.once('close', () => { if (upstream.connecting) upstream.destroy(); });

    upstream.once('connect', () => {
      upstream.removeListener('error', onFail);
      upstream.setTimeout(0);
      socket.write(`HTTP/1.1 200 Connection Established\r\nProxy-Agent: ${PROXY_AGENT}\r\n\r\n`);
      if (head.length) upstream.write(head);
      const logId = this.log({
        ts: start, client_ip: clientIp, kind: 'tunnel', method: 'CONNECT', host: label, url: label,
        status: 200, duration_ms: 0, req_headers: reqHeaders, bytes_up: head.length, active: true,
      });
      bridge(socket, upstream, {
        onProgress: (up, down) => this.logUpdate(logId, { bytes_up: up + head.length, bytes_down: down, duration_ms: Date.now() - start }),
        onClose: (up, down, err) => this.logUpdate(logId, {
          active: false, bytes_up: up + head.length, bytes_down: down, duration_ms: Date.now() - start,
          error: err && !['ECONNRESET', 'EPIPE'].includes(err.code) ? err.message : null,
        }),
      });
    });
  }

  // MITM: terminate TLS with a certificate signed by our CA, then parse HTTP.
  intercept(req, socket, { hostname, port }, clientIp) {
    socket.write(`HTTP/1.1 200 Connection Established\r\nProxy-Agent: ${PROXY_AGENT}\r\n\r\n`);
    const meta = { hostname, port, clientIp };
    if (port === 80) {
      socket._ppm = { ...meta, secure: false };
      return this.inner.emit('connection', socket);
    }
    const start = Date.now();
    let secureCtx;
    try {
      secureCtx = mitm.secureContextFor(hostname);
    } catch (err) {
      socket.destroy();
      return this.log({ ts: start, client_ip: clientIp, kind: 'https', method: 'CONNECT', host: hostname, error: `Certificate generation failed: ${err.message}` });
    }
    const tlsSocket = new tls.TLSSocket(socket, {
      isServer: true,
      secureContext: secureCtx,
      ALPNProtocols: ['http/1.1'],
      SNICallback: (servername, cb) => {
        try { cb(null, mitm.secureContextFor(servername)); } catch (err) { cb(err); }
      },
    });
    // Clients that reject our certificate often just hang up without a TLS alert,
    // so a close before the handshake completed counts as a failure too.
    let secured = false;
    let failure = null;
    tlsSocket.once('secure', () => { secured = true; });
    tlsSocket.on('error', (err) => {
      if (!secured) failure = err.message;
      tlsSocket.destroy();
    });
    // The TLS socket takes over the raw socket's handle, so its close is the one that fires.
    tlsSocket.once('close', () => {
      this.sockets.delete(socket);
      socket.destroy();
      if (secured) return;
      this.log({
        ts: start, client_ip: clientIp, kind: 'https', method: 'CONNECT',
        host: hostLabel(hostname, port, 443), url: `${hostname}:${port}`,
        req_headers: visibleHeaders(req.rawHeaders), duration_ms: Date.now() - start,
        error: `TLS handshake with client failed — does the client trust the PortableProxyMaker CA?${failure ? ` (${failure})` : ' (client closed the connection)'}`,
      });
    });
    tlsSocket._ppm = { ...meta, secure: true };
    this.inner.emit('connection', tlsSocket);
  }

  onInnerRequest(req, res) {
    const m = req.socket._ppm;
    let path = req.url;
    if (/^https?:\/\//i.test(path)) {
      try { const u = new URL(path); path = u.pathname + u.search; } catch { /* keep as is */ }
    }
    this.forward(req, res, {
      protocol: m.secure ? 'https:' : 'http:',
      hostname: m.hostname,
      port: m.port,
      path,
      servername: req.socket.servername || m.hostname,
    }, m.secure ? 'https' : 'http', m.clientIp);
  }

  // ---- request/response forwarding with capture --------------------------

  forward(req, res, t, kind, clientIp) {
    const start = Date.now();
    const def = this.def;
    const secure = t.protocol === 'https:';
    const host = hostLabel(t.hostname, t.port, secure ? 443 : 80);
    const url = `${secure ? 'https' : 'http'}://${host}${t.path}`;
    const reqRec = new BodyRecorder(!!def.capture_body);
    const resRec = new BodyRecorder(!!def.capture_body);
    let upRes = null;
    let done = false;

    const finish = (error) => {
      if (done) return;
      done = true;
      const reqBody = encodeBody(reqRec, req.headers['content-type'], req.headers['content-encoding']);
      const resBody = upRes
        ? encodeBody(resRec, upRes.headers['content-type'], upRes.headers['content-encoding'])
        : { body: null, encoding: null };
      this.log({
        ts: start, client_ip: clientIp, kind, method: req.method, host, url,
        status: upRes ? upRes.statusCode : 502,
        duration_ms: Date.now() - start,
        req_headers: visibleHeaders(req.rawHeaders),
        req_body: reqBody.body, req_body_encoding: reqBody.encoding,
        req_body_size: reqRec.size, req_body_truncated: reqRec.truncated,
        res_headers: upRes ? pairs(upRes.rawHeaders) : [],
        res_body: resBody.body, res_body_encoding: resBody.encoding,
        res_body_size: resRec.size, res_body_truncated: resRec.truncated,
        req_content_type: req.headers['content-type'] || null,
        res_content_type: upRes ? upRes.headers['content-type'] || null : null,
        bytes_up: reqRec.size, bytes_down: resRec.size,
        error: error || null,
      });
    };

    const options = {
      hostname: t.hostname,
      port: t.port,
      method: req.method,
      path: t.path,
      headers: stripHopByHop(req.headers),
      timeout: config.upstreamTimeoutMs,
      localAddress: def.outbound_ip || undefined,
    };
    if (secure) {
      options.servername = net.isIP(t.servername) ? undefined : t.servername;
      options.rejectUnauthorized = config.mitmVerifyUpstream;
    }

    const upReq = (secure ? https : http).request(options, (response) => {
      upRes = response;
      res.writeHead(response.statusCode, response.statusMessage, stripHopByHop(response.headers));
      response.on('data', (c) => resRec.push(c));
      response.pipe(res);
      response.on('end', () => finish(null));
      response.on('error', (err) => finish(err.message));
      res.on('close', () => {
        if (!response.complete) {
          response.destroy();
          finish('Client closed the connection before the response completed');
        }
      });
    });

    upReq.on('timeout', () => upReq.destroy(new Error(`Upstream timeout after ${config.upstreamTimeoutMs} ms`)));
    upReq.on('error', (err) => {
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'text/plain', 'x-proxy-error': err.code || 'error' });
        res.end(`${PROXY_AGENT}: upstream error: ${err.message}\n`);
      } else {
        res.destroy();
      }
      finish(`${err.code ? err.code + ': ' : ''}${err.message}`);
    });

    res.on('close', () => {
      if (!upRes && !done) {
        upReq.destroy();
        finish('Client closed the connection before the upstream responded');
      }
    });

    req.on('data', (c) => reqRec.push(c));
    req.pipe(upReq);
  }

  // ---- websockets --------------------------------------------------------

  onPlainUpgrade(req, socket, head) {
    let target;
    try { target = new URL(req.url); } catch { return socket.destroy(); }
    const secure = target.protocol === 'https:' || target.protocol === 'wss:';
    const port = Number(target.port) || (secure ? 443 : 80);
    const reason = this.authFailure(req);
    if (reason) {
      this.logAuthFailure(req, 'ws', hostLabel(target.hostname, port, secure ? 443 : 80), req.url, reason);
      return socket.end(`HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: ${AUTH_REALM}\r\n\r\n`);
    }
    this.upgrade(req, socket, head, {
      secure, hostname: target.hostname.replace(/^\[|\]$/g, ''), port,
      path: target.pathname + target.search, servername: target.hostname,
    }, cleanIp(socket.remoteAddress));
  }

  onInnerUpgrade(req, socket, head) {
    const m = req.socket._ppm || socket._ppm;
    this.upgrade(req, socket, head, {
      secure: m.secure, hostname: m.hostname, port: m.port, path: req.url,
      servername: socket.servername || m.hostname,
    }, m.clientIp);
  }

  upgrade(req, socket, head, t, clientIp) {
    const start = Date.now();
    const host = hostLabel(t.hostname, t.port, t.secure ? 443 : 80);
    const url = `${t.secure ? 'wss' : 'ws'}://${host}${t.path}`;
    const base = { ts: start, client_ip: clientIp, kind: 'ws', method: req.method, host, url, req_headers: visibleHeaders(req.rawHeaders) };
    const connectOpts = { host: t.hostname, port: t.port, localAddress: this.def.outbound_ip || undefined };
    const upstream = t.secure
      ? tls.connect({
        ...connectOpts,
        servername: net.isIP(t.servername) ? undefined : t.servername,
        rejectUnauthorized: config.mitmVerifyUpstream,
        ALPNProtocols: ['http/1.1'],
      })
      : net.connect(connectOpts);

    const onFail = (err) => {
      socket.destroy();
      this.log({ ...base, status: 502, duration_ms: Date.now() - start, error: err.message });
    };
    upstream.once('error', onFail);

    upstream.once(t.secure ? 'secureConnect' : 'connect', () => {
      upstream.removeListener('error', onFail);
      let raw = `${req.method} ${t.path} HTTP/1.1\r\n`;
      for (const [k, v] of pairs(req.rawHeaders)) {
        if (!['proxy-authorization', 'proxy-connection'].includes(k.toLowerCase())) raw += `${k}: ${v}\r\n`;
      }
      upstream.write(raw + '\r\n');
      if (head.length) upstream.write(head);

      let logId = null;
      upstream.once('data', (chunk) => {
        const text = chunk.toString('latin1');
        const headEnd = text.indexOf('\r\n\r\n');
        const lines = text.slice(0, headEnd >= 0 ? headEnd : text.length).split('\r\n');
        const status = Number((/^HTTP\/\d\.\d (\d{3})/.exec(lines[0]) || [])[1]) || null;
        const resHeaders = lines.slice(1).map((l) => {
          const i = l.indexOf(':');
          return i > 0 ? [l.slice(0, i), l.slice(i + 1).trim()] : null;
        }).filter(Boolean);
        logId = this.log({ ...base, status, duration_ms: Date.now() - start, res_headers: resHeaders, active: status === 101 });
      });

      bridge(socket, upstream, {
        onProgress: (up, down) => this.logUpdate(logId, { bytes_up: up, bytes_down: down, duration_ms: Date.now() - start }),
        onClose: (up, down) => this.logUpdate(logId, { active: false, bytes_up: up, bytes_down: down, duration_ms: Date.now() - start }),
      });
    });
  }
}

module.exports = ProxyInstance;
