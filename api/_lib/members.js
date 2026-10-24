// api/_lib/members.js — member records, entitlements and order fulfilment.
// Storage layout in the private R2 bucket:
//   ebooks/<key>.pdf                 master PDFs (you upload these)
//   members/<sha256(email)>.json     one record per customer (code hash, entitlements, download log)
//   orders/<razorpay_order_id>.json  fulfilment audit trail
//   stamped/<emailHash>/<key>-<v>.pdf personalised (watermarked) copies, generated on first download
const r2 = require('./r2');
const C = require('./crypto');
const catalog = require('./catalog');
const mail = require('./email');

const memberKey = (email) => 'members/' + C.emailHash(email) + '.json';

async function getMember(email) {
  const o = await r2.getJson(memberKey(email));
  return o ? o.data : null;
}

// Optimistic-concurrency update. mutator(rec|null) → rec to save, or null for "no change".
async function updateMember(email, mutator) {
  const key = memberKey(email);
  for (let attempt = 0; attempt < 6; attempt++) {
    const cur = await r2.getJson(key);
    const rec = cur ? cur.data : null;
    const next = await mutator(rec ? JSON.parse(JSON.stringify(rec)) : null);
    if (!next) return rec;
    next.updatedAt = new Date().toISOString();
    let ok = await r2.putJson(key, next, cur ? { ifMatch: r2.quoteEtag(cur.etag) } : { ifNoneMatch: '*' });
    if (!ok && cur) {
      // R2 can answer 412 to If-Match even when nothing changed. If the object's
      // version is still the one we read, nobody else wrote — safe to save.
      const now = await r2.headObject(key);
      if (now && r2.sameEtag(now.etag, cur.etag)) {
        console.warn('R2 If-Match 412 on unchanged object; writing unconditionally', key);
        ok = await r2.putJson(key, next);
      }
    }
    if (ok) return next;
    await new Promise(r => setTimeout(r, 120 + Math.random() * 250));
  }
  throw new Error('Could not save member record (too much contention) — please retry.');
}

function blankMember(email, name) {
  return {
    v: 1, email: C.normEmail(email), emailHash: C.emailHash(email), name: name || '',
    createdAt: new Date().toISOString(), status: 'active',
    codeHash: null, codeIssuedAt: null, sessionVersion: 1,
    failed: { count: 0, lockedUntil: 0 }, lastResendAt: 0,
    entitlements: {}, orders: [], downloads: {}, log: []
  };
}

// Grant ebooks to an email. Idempotent per orderId. Issues an access code for new members.
// Returns { member, code (plaintext, only if newly issued), added: [keys], duplicate: bool }
async function grant(opts) {
  const email = C.normEmail(opts.email);
  if (!C.isEmail(email)) throw new Error('Invalid email: ' + opts.email);
  const guides = (opts.guides || []).filter(catalog.isEbook);
  if (!guides.length) throw new Error('Nothing to grant.');
  const orderId = opts.orderId || ('manual_' + Date.now());

  let issued = null, issuedHash = null, added = [], duplicate = false;
  const member = await updateMember(email, async (rec) => {
    added = []; duplicate = false;
    rec = rec || blankMember(email, opts.name);
    if (rec.orders.some(o => o.id === orderId)) { duplicate = true; return null; }
    if (!rec.name && opts.name) rec.name = opts.name;
    if (!rec.codeHash || opts.forceNewCode) {
      if (!issued) { issued = C.newAccessCode(); issuedHash = await C.hashCode(issued); }
      rec.codeHash = issuedHash; rec.codeIssuedAt = new Date().toISOString();
      rec.sessionVersion = (rec.sessionVersion || 1) + (opts.forceNewCode ? 1 : 0);
    } else { issued = null; }
    guides.forEach(g => {
      if (!rec.entitlements[g]) added.push(g);
      rec.entitlements[g] = rec.entitlements[g] || { grantedAt: new Date().toISOString(), orderId, source: opts.source || 'payment' };
    });
    rec.orders.push({
      id: orderId, product: opts.product || null, paymentId: opts.paymentId || null,
      amount: opts.amount || null, currency: opts.currency || null,
      source: opts.source || 'payment', note: opts.note || undefined, at: new Date().toISOString()
    });
    return rec;
  });
  return { member, code: duplicate ? null : issued, added, duplicate };
}

// Called by checkout-verify AND the webhook — safe to run twice for the same order.
async function fulfilOrder(order, payment, siteUrl, via) {
  const notes = order.notes || {};
  const productKey = notes.product_key;
  const product = catalog.getProduct(productKey);
  if (!product) throw new Error('Order ' + order.id + ' has unknown product_key ' + productKey);
  // Amount on the order was set by OUR server from the catalog — still double-check.
  const expected = catalog.priceMinor(productKey, order.currency);
  if (expected == null || Number(order.amount) !== expected) {
    throw new Error('Amount mismatch on ' + order.id + ': ' + order.amount + ' vs ' + expected);
  }
  const paidOk = order.status === 'paid' || (payment && payment.status === 'captured' && payment.order_id === order.id);
  if (!paidOk) throw new Error('Order ' + order.id + ' is not paid (status ' + order.status + ').');

  const email = notes.cust_email || (payment && payment.email);
  const res = await grant({
    email, name: notes.cust_name || '', guides: product.unlocks, product: productKey,
    orderId: order.id, paymentId: payment ? payment.id : null,
    amount: order.amount, currency: order.currency, source: 'razorpay:' + via
  });

  if (!res.duplicate) {
    await r2.putJson('orders/' + order.id + '.json', {
      orderId: order.id, receipt: order.receipt, product: productKey, email: C.normEmail(email),
      paymentId: payment ? payment.id : null, amount: order.amount, currency: order.currency,
      unlocked: product.unlocks, fulfilledVia: via, at: new Date().toISOString()
    });
    try {
      await mail.purchaseEmail({
        email: C.normEmail(email), name: res.member.name, code: res.code, orderRef: notes.order_ref || order.receipt,
        guideNames: product.unlocks.map(k => catalog.EBOOKS[k].name), siteUrl
      });
    } catch (e) { console.error('purchase email failed', e); }
  }
  return res;
}

function publicLibrary(rec) {
  return {
    email: rec.email, name: rec.name,
    owned: Object.keys(rec.entitlements || {}).filter(catalog.isEbook),
    downloads: rec.downloads || {},
    limit: downloadLimit()
  };
}
function downloadLimit() { return Number(process.env.DOWNLOAD_LIMIT_PER_GUIDE || 25); }

module.exports = { getMember, updateMember, grant, fulfilOrder, publicLibrary, downloadLimit, memberKey };
