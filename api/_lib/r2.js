// api/_lib/r2.js — private object storage on Cloudflare R2 (S3-compatible).
// The bucket is PRIVATE: nothing in it has a public URL. The server reads/writes with
// secret keys, and hands customers short-lived signed links (default 5 minutes).
//
// Env: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET
// (FOB_LOCAL_STORE=/some/dir switches to a local folder — for offline testing only.)

const { AwsClient } = require('aws4fetch');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let _client = null;
function client() {
  if (_client) return _client;
  const need = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET'];
  const missing = need.filter(k => !process.env[k]);
  if (missing.length) throw new Error('Storage not configured — missing env: ' + missing.join(', '));
  _client = new AwsClient({
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    service: 's3',
    region: 'auto'
  });
  return _client;
}
function objUrl(key) {
  const enc = String(key).split('/').map(encodeURIComponent).join('/');
  return 'https://' + process.env.R2_ACCOUNT_ID + '.r2.cloudflarestorage.com/' + process.env.R2_BUCKET + '/' + enc;
}

// ── Local test backend ───────────────────────────────────────────────
const LOCAL = process.env.FOB_LOCAL_STORE;
function lp(key) { return path.join(LOCAL, key); }
function letag(buf) { return '"' + crypto.createHash('md5').update(buf).digest('hex') + '"'; }

// Returns { body:Buffer, etag } or null if missing.
async function getObject(key) {
  if (LOCAL) {
    if (!fs.existsSync(lp(key))) return null;
    const b = fs.readFileSync(lp(key)); return { body: b, etag: letag(b) };
  }
  const r = await client().fetch(objUrl(key), { method: 'GET' });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error('R2 GET ' + key + ' → ' + r.status);
  return { body: Buffer.from(await r.arrayBuffer()), etag: r.headers.get('etag') };
}

async function headObject(key) {
  if (LOCAL) {
    if (!fs.existsSync(lp(key))) return null;
    const b = fs.readFileSync(lp(key)); return { etag: letag(b), size: b.length };
  }
  const r = await client().fetch(objUrl(key), { method: 'HEAD' });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error('R2 HEAD ' + key + ' → ' + r.status);
  return { etag: r.headers.get('etag'), size: Number(r.headers.get('content-length') || 0) };
}

// cond: { ifMatch: etag } | { ifNoneMatch: '*' }. Returns true on success, false on precondition failure.
async function putObject(key, body, contentType, cond) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  if (LOCAL) {
    const exists = fs.existsSync(lp(key));
    if (cond && cond.ifNoneMatch === '*' && exists) return false;
    if (cond && cond.ifMatch && (!exists || letag(fs.readFileSync(lp(key))) !== cond.ifMatch)) return false;
    if (cond && cond.ifMatch && process.env.FOB_LOCAL_FAIL_IFMATCH) return false;   // test: mimic R2 412
    fs.mkdirSync(path.dirname(lp(key)), { recursive: true });
    fs.writeFileSync(lp(key), buf); return true;
  }
  const headers = { 'Content-Type': contentType || 'application/octet-stream' };
  if (cond && cond.ifMatch) headers['If-Match'] = cond.ifMatch;
  if (cond && cond.ifNoneMatch) headers['If-None-Match'] = cond.ifNoneMatch;
  const r = await client().fetch(objUrl(key), { method: 'PUT', headers, body: buf });
  if (r.status === 412) { console.warn('R2 PUT 412', key, JSON.stringify(cond)); return false; }
  if (!r.ok) throw new Error('R2 PUT ' + key + ' → ' + r.status + ' ' + (await r.text()).slice(0, 200));
  return true;
}

async function deleteObject(key) {
  if (LOCAL) { if (fs.existsSync(lp(key))) fs.unlinkSync(lp(key)); return; }
  const r = await client().fetch(objUrl(key), { method: 'DELETE' });
  if (!r.ok && r.status !== 404) throw new Error('R2 DELETE ' + key + ' → ' + r.status);
}

async function listKeys(prefix) {
  if (LOCAL) {
    const dir = lp(prefix); if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).map(f => prefix + f);
  }
  const keys = []; let token = null;
  do {
    const u = new URL('https://' + process.env.R2_ACCOUNT_ID + '.r2.cloudflarestorage.com/' + process.env.R2_BUCKET);
    u.searchParams.set('list-type', '2'); u.searchParams.set('prefix', prefix);
    if (token) u.searchParams.set('continuation-token', token);
    const r = await client().fetch(u.toString());
    if (!r.ok) throw new Error('R2 LIST → ' + r.status);
    const xml = await r.text();
    (xml.match(/<Key>([^<]+)<\/Key>/g) || []).forEach(m => keys.push(m.slice(5, -6).replace(/&amp;/g, '&')));
    const t = xml.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/);
    token = (/<IsTruncated>true<\/IsTruncated>/.test(xml) && t) ? t[1] : null;
  } while (token);
  return keys;
}

async function getJson(key) {
  const o = await getObject(key);
  if (!o) return null;
  return { data: JSON.parse(o.body.toString('utf8')), etag: o.etag };
}
function putJson(key, data, cond) {
  return putObject(key, JSON.stringify(data, null, 2), 'application/json', cond);
}

// Short-lived signed GET link. disposition: 'inline' (view in browser) or 'attachment' (download).
async function signedUrl(key, opts) {
  opts = opts || {};
  const ttl = Math.max(30, Math.min(3600, opts.ttl || 300));
  if (LOCAL) return 'file://' + lp(key) + '?ttl=' + ttl + '&disp=' + (opts.disposition || 'inline');
  const u = new URL(objUrl(key));
  u.searchParams.set('X-Amz-Expires', String(ttl));
  if (opts.filename) {
    const fn = String(opts.filename).replace(/[^A-Za-z0-9._ -]/g, '_');
    u.searchParams.set('response-content-disposition', (opts.disposition || 'inline') + '; filename="' + fn + '"');
  }
  u.searchParams.set('response-content-type', 'application/pdf');
  u.searchParams.set('response-cache-control', 'private, no-store');
  const signed = await client().sign(new Request(u.toString(), { method: 'GET' }), { aws: { signQuery: true } });
  return signed.url;
}

function bareEtag(e) { return String(e || '').replace(/^W\//, '').replace(/"/g, '').trim(); }
function quoteEtag(e) { return '"' + bareEtag(e) + '"'; }
function sameEtag(a, b) { return !!bareEtag(a) && bareEtag(a) === bareEtag(b); }

module.exports = { bareEtag, quoteEtag, sameEtag, getObject, headObject, putObject, deleteObject, listKeys, getJson, putJson, signedUrl };
