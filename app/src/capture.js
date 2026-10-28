// Helpers for recording request/response bodies and headers for the traffic log.
const zlib = require('zlib');
const config = require('./config');

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'proxy-connection',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
]);

function stripHopByHop(headers) {
  const out = {};
  const extra = String(headers.connection || '').toLowerCase().split(',').map((s) => s.trim());
  for (const [k, v] of Object.entries(headers)) {
    if (HOP_BY_HOP.has(k) || extra.includes(k)) continue;
    out[k] = v;
  }
  return out;
}

// rawHeaders -> [[name, value], ...] preserving case, order and duplicates.
function pairs(rawHeaders) {
  const out = [];
  for (let i = 0; i < rawHeaders.length; i += 2) out.push([rawHeaders[i], rawHeaders[i + 1]]);
  return out;
}

// Wraps a stream and keeps the first `limit` bytes it emits.
class BodyRecorder {
  constructor(enabled) {
    this.enabled = enabled;
    this.limit = config.captureMaxBody;
    this.chunks = [];
    this.captured = 0;
    this.size = 0;
  }

  push(chunk) {
    this.size += chunk.length;
    if (!this.enabled || this.captured >= this.limit) return;
    const room = this.limit - this.captured;
    const piece = chunk.length > room ? chunk.subarray(0, room) : chunk;
    this.chunks.push(Buffer.from(piece));
    this.captured += piece.length;
  }

  get truncated() {
    return this.size > this.captured;
  }

  buffer() {
    return Buffer.concat(this.chunks);
  }
}

const TEXT_TYPES = /(^text\/)|json|xml|javascript|ecmascript|x-www-form-urlencoded|graphql|yaml|csv|html|css|svg|x-ndjson|event-stream/i;
const BINARY_TYPES = /^(image|audio|video|font)\/|octet-stream|protobuf|grpc|zip|pdf/i;

function decompress(buf, encoding) {
  const enc = String(encoding || '').toLowerCase().trim();
  if (!enc || enc === 'identity' || !buf.length) return buf;
  const opts = { finishFlush: zlib.constants.Z_SYNC_FLUSH };
  try {
    if (enc === 'gzip' || enc === 'x-gzip') return zlib.gunzipSync(buf, opts);
    if (enc === 'deflate') {
      try { return zlib.inflateSync(buf, opts); } catch { return zlib.inflateRawSync(buf, opts); }
    }
    if (enc === 'br') return zlib.brotliDecompressSync(buf, { finishFlush: zlib.constants.BROTLI_OPERATION_FLUSH });
    if (enc === 'zstd' && typeof zlib.zstdDecompressSync === 'function') return zlib.zstdDecompressSync(buf);
  } catch {
    /* fall through: keep the raw bytes */
  }
  return null;
}

function looksLikeText(buf) {
  const sample = buf.subarray(0, 512);
  let control = 0;
  for (const b of sample) {
    if (b === 0) return false;
    if (b < 9 || (b > 13 && b < 32)) control++;
  }
  return control / Math.max(sample.length, 1) < 0.05;
}

// Converts captured bytes into what we store: { body, encoding } where encoding is utf8|base64.
function encodeBody(recorder, contentType, contentEncoding) {
  if (!recorder.enabled || recorder.size === 0) return { body: null, encoding: null };
  let buf = recorder.buffer();
  const decoded = decompress(buf, contentEncoding);
  if (decoded) buf = decoded;
  const ct = contentType || '';
  let textual;
  if (TEXT_TYPES.test(ct)) textual = true;
  else if (BINARY_TYPES.test(ct) || decoded === null) textual = false;
  else textual = looksLikeText(buf);
  if (textual) return { body: buf.toString('utf8'), encoding: 'utf8' };
  return { body: buf.toString('base64'), encoding: 'base64' };
}

function cleanIp(ip) {
  return String(ip || '').replace(/^::ffff:/, '');
}

module.exports = { stripHopByHop, pairs, BodyRecorder, encodeBody, cleanIp };
