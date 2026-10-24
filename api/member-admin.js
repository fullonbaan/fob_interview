// api/member-admin.js — admin operations for the Members Area.
// Every call needs:  Authorization: Bearer <ADMIN_API_TOKEN>   (env var, 40+ random chars)
//   GET  ?action=list                    all members (summary)
//   GET  ?action=get&email=…             one member (full record minus secrets)
//   GET  ?action=files                   which master PDFs are present in the bucket
//   POST ?action=grant        {email, name, product | guides[], note, notify}
//   POST ?action=revoke       {email, guide}
//   POST ?action=reset-code   {email, notify}     → returns the new code so you can share it too
//   POST ?action=set-status   {email, status: 'active'|'disabled'}
//   POST ?action=reset-downloads {email, guide}
const H = require('./_lib/http');
const C = require('./_lib/crypto');
const r2 = require('./_lib/r2');
const catalog = require('./_lib/catalog');
const members = require('./_lib/members');
const mail = require('./_lib/email');

function authed(req) {
  const t = process.env.ADMIN_API_TOKEN;
  if (!t || t.length < 32) return false;
  const h = String(req.headers.authorization || '');
  return h.startsWith('Bearer ') && C.safeEqual(h.slice(7).trim(), t);
}
function strip(rec) {
  if (!rec) return null;
  const o = Object.assign({}, rec); delete o.codeHash; return o;
}
function summary(rec) {
  const dl = rec.downloads || {};
  return {
    email: rec.email, name: rec.name, status: rec.status, createdAt: rec.createdAt, lastLoginAt: rec.lastLoginAt || null,
    owned: Object.keys(rec.entitlements || {}), orders: (rec.orders || []).length,
    downloads: Object.keys(dl).reduce((s, k) => s + dl[k], 0)
  };
}

module.exports = async function handler(req, res) {
  if (!authed(req)) { await new Promise(r => setTimeout(r, 400)); return H.send(res, 401, { error: 'Unauthorized' }); }
  const q = H.getQuery(req), action = q.action;
  try {
    if (req.method === 'GET') {
      if (action === 'list') {
        const keys = (await r2.listKeys('members/')).filter(k => k.endsWith('.json'));
        const recs = [];
        for (let i = 0; i < keys.length; i += 10) {
          const batch = await Promise.all(keys.slice(i, i + 10).map(k => r2.getJson(k)));
          batch.forEach(o => { if (o) recs.push(summary(o.data)); });
        }
        recs.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
        return H.send(res, 200, { members: recs });
      }
      if (action === 'get') return H.send(res, 200, { member: strip(await members.getMember(q.email)) });
      if (action === 'files') {
        const files = await Promise.all(Object.keys(catalog.EBOOKS).map(async k => {
          const h = await r2.headObject(catalog.EBOOKS[k].file);
          return { key: k, name: catalog.EBOOKS[k].name, path: catalog.EBOOKS[k].file, present: !!h, size: h ? h.size : 0 };
        }));
        return H.send(res, 200, { files, products: Object.keys(catalog.PRODUCTS).map(k => ({ key: k, name: catalog.PRODUCTS[k].name, unlocks: catalog.PRODUCTS[k].unlocks })) });
      }
      return H.send(res, 404, { error: 'Unknown action' });
    }

    if (req.method !== 'POST') return H.send(res, 405, { error: 'Method not allowed' });
    const b = await H.readJson(req);
    const email = C.normEmail(b.email);
    if (!C.isEmail(email)) return H.send(res, 400, { error: 'Valid email required' });

    if (action === 'grant') {
      let guides = Array.isArray(b.guides) ? b.guides : [];
      const product = b.product ? catalog.getProduct(b.product) : null;
      if (product) guides = guides.concat(product.unlocks);
      guides = guides.filter(catalog.isEbook);
      if (!guides.length) return H.send(res, 400, { error: 'Choose a product or at least one guide' });
      const r = await members.grant({ email, name: b.name, guides, product: b.product || null, orderId: 'admin_' + Date.now(), source: 'admin', note: String(b.note || '').slice(0, 200) });
      if (b.notify !== false) {
        await mail.purchaseEmail({ email, name: r.member.name, code: r.code, orderRef: b.note || '', guideNames: guides.map(k => catalog.EBOOKS[k].name), siteUrl: H.siteUrl(req) });
      }
      return H.send(res, 200, { ok: true, code: r.code, added: r.added, member: summary(r.member) });
    }
    if (action === 'reset-code') {
      const code = C.newAccessCode(), hash = await C.hashCode(code);
      const m = await members.updateMember(email, (rec) => {
        if (!rec) return null;
        rec.codeHash = hash; rec.codeIssuedAt = new Date().toISOString();
        rec.sessionVersion = (rec.sessionVersion || 1) + 1; rec.failed = { count: 0, lockedUntil: 0 };
        return rec;
      });
      if (!m || m.codeHash !== hash) return H.send(res, 404, { error: 'No such member' });
      if (b.notify !== false) await mail.newCodeEmail({ email, code, siteUrl: H.siteUrl(req) });
      return H.send(res, 200, { ok: true, code });
    }
    const simple = {
      'revoke': (rec) => { if (!catalog.isEbook(b.guide)) return null; delete rec.entitlements[b.guide]; return rec; },
      'set-status': (rec) => { rec.status = b.status === 'disabled' ? 'disabled' : 'active'; if (rec.status === 'disabled') rec.sessionVersion++; return rec; },
      'reset-downloads': (rec) => { rec.downloads = rec.downloads || {}; if (b.guide) delete rec.downloads[b.guide]; else rec.downloads = {}; return rec; }
    };
    if (simple[action]) {
      const m = await members.updateMember(email, (rec) => rec ? simple[action](rec) : null);
      if (!m) return H.send(res, 404, { error: 'No such member' });
      return H.send(res, 200, { ok: true, member: summary(m) });
    }
    return H.send(res, 404, { error: 'Unknown action' });
  } catch (e) {
    console.error('member-admin error', action, e);
    return H.send(res, 500, { error: e.message });
  }
};
