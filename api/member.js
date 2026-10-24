// api/member.js — Members Area API (one function, several actions).
//   POST ?action=login   {email, code}     → sets an HttpOnly session cookie
//   POST ?action=logout
//   GET  ?action=me                          → the signed-in member's library
//   GET  ?action=file&g=dev&f=<ebook id>&mode=view|download → entitlement check → 302 to a 5-minute signed link
//   POST ?action=resend  {email}             → emails a fresh access code (always answers the same way)
const H = require('./_lib/http');
const C = require('./_lib/crypto');
const r2 = require('./_lib/r2');
const catalog = require('./_lib/catalog');
const members = require('./_lib/members');
const mail = require('./_lib/email');
const library = require('./_lib/library');
const crypto = require('crypto');

const COOKIE = 'fob_mem';
const SESSION_DAYS = 7;
const MAX_FAILS = 5, LOCK_MIN = 15;
const RESEND_GAP_MS = 2 * 60 * 1000;

function setCookie(res, value, maxAgeSec) {
  res.setHeader('Set-Cookie', COOKIE + '=' + value + '; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=' + maxAgeSec);
}

async function currentMember(req) {
  const tok = H.parseCookies(req)[COOKIE];
  const p = C.verifySession(tok);
  if (!p || !/^[a-f0-9]{64}$/.test(p.h)) return null;
  const o = await r2.getJson('members/' + p.h + '.json');
  if (!o) return null;
  const rec = o.data;
  if (rec.status !== 'active' || rec.sessionVersion !== p.v) return null;   // revoked / code reset
  return rec;
}

async function login(req, res) {
  const b = await H.readJson(req);
  const email = C.normEmail(b.email), code = String(b.code || '');
  const generic = { error: 'That email and access code don’t match. Check the code in your purchase email, or request a new one.' };
  if (!C.isEmail(email) || C.normCode(code).length < 8) return H.send(res, 400, generic);

  const rec = await members.getMember(email);
  if (rec && rec.failed && rec.failed.lockedUntil > Date.now()) {
    await C.verifyCode(code, null);
    return H.send(res, 429, { error: 'Too many attempts. Please wait ' + LOCK_MIN + ' minutes or request a new code.' });
  }
  const ok = await C.verifyCode(code, rec && rec.codeHash);
  if (!rec || !ok || rec.status !== 'active') {
    if (rec) {
      await members.updateMember(email, (m) => {
        if (!m) return null;
        m.failed = m.failed || { count: 0, lockedUntil: 0 };
        m.failed.count = (m.failed.count || 0) + 1;
        if (m.failed.count >= MAX_FAILS) { m.failed.lockedUntil = Date.now() + LOCK_MIN * 60000; m.failed.count = 0; }
        return m;
      });
    }
    return H.send(res, 401, generic);
  }
  const saved = await members.updateMember(email, (m) => {
    m.failed = { count: 0, lockedUntil: 0 };
    m.lastLoginAt = new Date().toISOString(); m.lastLoginIp = H.clientIp(req);
    return m;
  });
  const exp = Date.now() + SESSION_DAYS * 864e5;
  setCookie(res, C.signSession({ h: saved.emailHash, v: saved.sessionVersion, exp }), SESSION_DAYS * 86400);
  return H.send(res, 200, { ok: true, library: members.publicLibrary(saved) });
}

async function me(req, res) {
  const rec = await currentMember(req);
  if (!rec) return H.send(res, 401, { error: 'Not signed in.' });
  const lib = members.publicLibrary(rec);
  const shelf = await library.shelf();
  // Ebook lists only for guides this member owns (others just show the guide card).
  const files = {};
  lib.owned.forEach(g => {
    files[g] = (shelf[g] || []).map(f => ({ id: f.id, title: f.title, size: f.size, updated: f.updated, opens: (rec.downloads || {})[f.id] || 0 }));
  });
  const counts = {}; Object.keys(shelf).forEach(g => { counts[g] = shelf[g].length; });
  return H.send(res, 200, { library: lib, catalog: catalogView(counts), files });
}

function catalogView(counts) {
  const out = {};
  Object.keys(catalog.EBOOKS).forEach(k => { out[k] = { name: catalog.EBOOKS[k].name, track: catalog.EBOOKS[k].track, count: counts ? counts[k] || 0 : undefined }; });
  return out;
}

async function file(req, res) {
  const q = H.getQuery(req);
  const g = String(q.g || ''), mode = q.mode === 'download' ? 'download' : 'view';
  const back = (code) => { res.statusCode = 302; res.setHeader('Location', '/members?e=' + code); res.setHeader('Cache-Control', 'no-store'); res.end(); };
  if (H.isCrossSite(req)) return back('blocked');
  if (!catalog.isEbook(g)) return back('unknown');
  const rec = await currentMember(req);
  if (!rec) return back('login');
  if (!rec.entitlements || !rec.entitlements[g]) return back('forbidden');

  // Which ebook inside the guide. Old links without &f= get the guide's first ebook.
  let key = q.f ? library.keyForId(g, q.f) : null;
  if (!q.f) { const list = (await library.shelf())[g] || []; key = list.length ? list[0].key : null; }
  if (!key) return back(q.f ? 'unknown' : 'missing');
  const id = key.slice(library.ROOT.length);
  const master = await r2.headObject(key);
  if (!master) { console.error('EBOOK MISSING in bucket:', key); return back('missing'); }

  // Count + log the access (and enforce the per-ebook cap) before handing out a link.
  let capped = false;
  await members.updateMember(rec.email, (m) => {
    m.downloads = m.downloads || {};
    const n = m.downloads[id] || 0;
    if (n >= members.downloadLimit()) { capped = true; return null; }
    m.downloads[id] = n + 1;
    m.log = (m.log || []).concat([{ at: new Date().toISOString(), g, f: id, mode, ip: H.clientIp(req), ua: String(req.headers['user-agent'] || '').slice(0, 120) }]).slice(-80);
    return m;
  });
  if (capped) return back('limit');

  let serveKey = key;
  if (String(process.env.WATERMARK || 'on').toLowerCase() !== 'off') {
    const ver = String(master.etag || '').replace(/[^a-zA-Z0-9]/g, '').slice(0, 12) || 'v1';
    const fid = crypto.createHash('sha1').update(id).digest('hex').slice(0, 16);
    const personal = 'stamped/' + rec.emailHash + '/' + g + '/' + fid + '-' + ver + '.pdf';
    if (await r2.headObject(personal)) serveKey = personal;
    else {
      try {
        const src = await r2.getObject(key);
        const ent = rec.entitlements[g];
        const out = await require('./_lib/stamp').stampPdf(src.body, { name: rec.name, email: rec.email, orderId: ent.orderId });
        await r2.putObject(personal, out, 'application/pdf');
        serveKey = personal;
      } catch (e) {
        console.error('watermark failed for', key, '- serving master', e.message);
      }
    }
  }
  const title = library.parseKey(key).title;
  const fname = 'FullOnBaan - ' + title + '.pdf';
  const url = await r2.signedUrl(serveKey, { ttl: Number(process.env.LINK_TTL_SECONDS || 300), disposition: mode === 'download' ? 'attachment' : 'inline', filename: fname });
  res.statusCode = 302;
  res.setHeader('Location', url);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.end();
}

async function resend(req, res) {
  const b = await H.readJson(req);
  const email = C.normEmail(b.email);
  const generic = { ok: true, message: 'If that email has a FullOnBaan library, a new access code is on its way. Check your inbox (and spam) in a minute.' };
  if (!C.isEmail(email)) return H.send(res, 400, { error: 'Please enter a valid email.' });
  const rec = await members.getMember(email);
  if (!rec || rec.status !== 'active' || (Date.now() - (rec.lastResendAt || 0)) < RESEND_GAP_MS) return H.send(res, 200, generic);

  const code = C.newAccessCode(), hash = await C.hashCode(code);
  await members.updateMember(email, (m) => {
    m.codeHash = hash; m.codeIssuedAt = new Date().toISOString();
    m.sessionVersion = (m.sessionVersion || 1) + 1;      // signs out every other device
    m.lastResendAt = Date.now(); m.failed = { count: 0, lockedUntil: 0 };
    return m;
  });
  await mail.newCodeEmail({ email, code, siteUrl: H.siteUrl(req) });
  return H.send(res, 200, generic);
}

module.exports = async function handler(req, res) {
  const action = H.getQuery(req).action;
  try {
    if (req.method === 'GET' && action === 'me') return await me(req, res);
    if (req.method === 'GET' && action === 'file') return await file(req, res);
    if (req.method !== 'POST') return H.send(res, 405, { error: 'Method not allowed.' });
    if (H.isCrossSite(req)) return H.send(res, 403, { error: 'Cross-site request blocked.' });
    if (!/application\/json/.test(String(req.headers['content-type'] || ''))) return H.send(res, 415, { error: 'JSON required.' });
    if (action === 'login') return await login(req, res);
    if (action === 'resend') return await resend(req, res);
    if (action === 'logout') { setCookie(res, '', 0); return H.send(res, 200, { ok: true }); }
    return H.send(res, 404, { error: 'Unknown action.' });
  } catch (e) {
    console.error('member api error', action, e);
    return H.send(res, 500, { error: 'Something went wrong. Please try again in a moment.' });
  }
};
