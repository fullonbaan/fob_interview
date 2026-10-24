// api/_lib/http.js — small request/response helpers shared by the API functions.

function send(res, status, obj, extraHeaders) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (extraHeaders) Object.keys(extraHeaders).forEach(h => res.setHeader(h, extraHeaders[h]));
  res.end(JSON.stringify(obj));
}

function readRaw(req, limit) {
  limit = limit || 64 * 1024;
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', c => { size += c.length; if (size > limit) { reject(new Error('Body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Vercel pre-parses JSON into req.body when accessed; fall back to the raw stream.
async function readJson(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch (e) { return {}; } }
  const raw = await readRaw(req);
  if (!raw.length) return {};
  try { return JSON.parse(raw.toString('utf8')); } catch (e) { return {}; }
}

function parseCookies(req) {
  const out = {};
  String(req.headers.cookie || '').split(';').forEach(p => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}

function clientIp(req) {
  return String(req.headers['x-real-ip'] || req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
}

// Block cross-site use of state-changing / file endpoints (CSRF defence in depth).
function isCrossSite(req) {
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') return true;
  const origin = req.headers.origin;
  if (origin) {
    try { return new URL(origin).host !== req.headers.host; } catch (e) { return true; }
  }
  return false;
}

function getQuery(req) {
  if (req.query) return req.query;
  const u = new URL(req.url, 'http://x');
  const q = {}; u.searchParams.forEach((v, k) => { q[k] = v; });
  return q;
}

function siteUrl(req) {
  if (process.env.SITE_URL) return process.env.SITE_URL.replace(/\/+$/, '');
  return 'https://' + (req.headers['x-forwarded-host'] || req.headers.host || 'interview.fullonbaan.com');
}

module.exports = { send, readRaw, readJson, parseCookies, clientIp, isCrossSite, getQuery, siteUrl };
