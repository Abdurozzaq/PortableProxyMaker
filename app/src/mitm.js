// Local certificate authority used to decrypt HTTPS for proxies with MITM enabled.
// Clients must trust ca.crt (downloadable from the panel) for interception to work.
const fs = require('fs');
const path = require('path');
const net = require('net');
const tls = require('tls');
const crypto = require('crypto');
const forge = require('node-forge');
const config = require('./config');

const pki = forge.pki;
const CA_KEY = path.join(config.caDir, 'ca.key');
const CA_CERT = path.join(config.caDir, 'ca.crt');

let ca = null;
let leafKeyPem = null;
let leafPublicKey = null;
const contextCache = new Map();
const CACHE_LIMIT = 1000;

function rsaPair() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return { privateKey, publicKey };
}

function randomSerial() {
  // Positive serial: clear the top bit.
  const bytes = crypto.randomBytes(16);
  bytes[0] &= 0x7f;
  return bytes.toString('hex');
}

function createCA() {
  const { privateKey, publicKey } = rsaPair();
  const cert = pki.createCertificate();
  cert.publicKey = pki.publicKeyFromPem(publicKey);
  cert.serialNumber = randomSerial();
  cert.validity.notBefore = new Date(Date.now() - 24 * 3600 * 1000);
  cert.validity.notAfter = new Date(Date.now() + 10 * 365 * 24 * 3600 * 1000);
  const attrs = [
    { name: 'commonName', value: 'PortableProxyMaker Debug CA' },
    { name: 'organizationName', value: 'PortableProxyMaker' },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: 'basicConstraints', cA: true, critical: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true, digitalSignature: true, critical: true },
    { name: 'subjectKeyIdentifier' },
  ]);
  cert.sign(pki.privateKeyFromPem(privateKey), forge.md.sha256.create());
  fs.mkdirSync(config.caDir, { recursive: true });
  fs.writeFileSync(CA_KEY, privateKey, { mode: 0o600 });
  fs.writeFileSync(CA_CERT, pki.certificateToPem(cert));
}

function init() {
  if (!fs.existsSync(CA_KEY) || !fs.existsSync(CA_CERT)) createCA();
  ca = {
    key: pki.privateKeyFromPem(fs.readFileSync(CA_KEY, 'utf8')),
    cert: pki.certificateFromPem(fs.readFileSync(CA_CERT, 'utf8')),
  };
  // One key pair shared by every leaf certificate keeps per-host generation fast.
  const pair = rsaPair();
  leafKeyPem = pair.privateKey;
  leafPublicKey = pki.publicKeyFromPem(pair.publicKey);
}

function createLeafPem(host) {
  const cert = pki.createCertificate();
  cert.publicKey = leafPublicKey;
  cert.serialNumber = randomSerial();
  cert.validity.notBefore = new Date(Date.now() - 24 * 3600 * 1000);
  cert.validity.notAfter = new Date(Date.now() + 365 * 24 * 3600 * 1000);
  cert.setSubject([{ name: 'commonName', value: host.slice(0, 64) }]);
  cert.setIssuer(ca.cert.subject.attributes);
  const altName = net.isIP(host) ? { type: 7, ip: host } : { type: 2, value: host };
  cert.setExtensions([
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
    { name: 'extKeyUsage', serverAuth: true },
    { name: 'subjectAltName', altNames: [altName] },
    { name: 'authorityKeyIdentifier', keyIdentifier: ca.cert.generateSubjectKeyIdentifier().getBytes() },
  ]);
  cert.sign(ca.key, forge.md.sha256.create());
  return pki.certificateToPem(cert);
}

function secureContextFor(host) {
  if (!ca) init();
  const key = host.toLowerCase();
  let ctx = contextCache.get(key);
  if (!ctx) {
    ctx = tls.createSecureContext({ key: leafKeyPem, cert: createLeafPem(key) });
    if (contextCache.size >= CACHE_LIMIT) contextCache.delete(contextCache.keys().next().value);
    contextCache.set(key, ctx);
  }
  return ctx;
}

function caCertPem() {
  if (!ca) init();
  return fs.readFileSync(CA_CERT, 'utf8');
}

function caFingerprint() {
  const der = Buffer.from(forge.asn1.toDer(pki.certificateToAsn1(pki.certificateFromPem(caCertPem()))).getBytes(), 'binary');
  return crypto.createHash('sha256').update(der).digest('hex').toUpperCase().match(/.{2}/g).join(':');
}

module.exports = { init, secureContextFor, caCertPem, caFingerprint };
