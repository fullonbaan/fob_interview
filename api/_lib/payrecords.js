// api/_lib/payrecords.js — the order/payment register used by the #admin panel and GST invoices.
// Written ONLY by the server (never by a customer's browser).
// Storage (unchanged): private repo fullonbaan/fob_pay_store_ln_intv
//   payments/interview_payments.json   [ {orderId, status, name, email, …, invoiceNo, utr}, … ]
//   payments/invoice_counter.json      { "counter": N }   → invoice numbers FOB0000001…
// Env: GITHUB_PAT  (FOB_GH_LOCAL=/dir switches to local files — offline testing only)
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const catalog = require('./catalog');

const GH_OWNER = 'fullonbaan', GH_REPO = 'fob_pay_store_ln_intv';
const FILE_RECORDS = 'payments/interview_payments.json';
const FILE_COUNTER = 'payments/invoice_counter.json';
const INV_PREFIX = 'FOB', INV_PAD = 7;
const SELLER_STATE_CODE = '29';            // Karnataka
const GST_RATE = 0.18;

// ── GitHub contents API (with optimistic concurrency via sha) ─────────
async function ghGet(file) {
  if (process.env.FOB_GH_LOCAL) {
    const p = path.join(process.env.FOB_GH_LOCAL, file);
    if (!fs.existsSync(p)) return { data: null, sha: null };
    const raw = fs.readFileSync(p, 'utf8');
    return { data: raw.trim() ? JSON.parse(raw) : null, sha: crypto.createHash('md5').update(raw).digest('hex') };
  }
  const r = await fetch(`https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/contents/${file}`, { headers: ghHeaders() });
  if (r.status === 404) return { data: null, sha: null };
  if (!r.ok) throw new Error('GitHub GET ' + file + ' → ' + r.status);
  const j = await r.json();
  const raw = j.content ? Buffer.from(j.content.replace(/\n/g, ''), 'base64').toString('utf8') : '';
  return { data: raw.trim() ? JSON.parse(raw) : null, sha: j.sha || null };
}
// Returns true on success, false on a write conflict (someone else saved first).
async function ghPut(file, data, sha, message) {
  const body = JSON.stringify(data, null, 2);
  if (process.env.FOB_GH_LOCAL) {
    const p = path.join(process.env.FOB_GH_LOCAL, file);
    const cur = fs.existsSync(p) ? crypto.createHash('md5').update(fs.readFileSync(p, 'utf8')).digest('hex') : null;
    if (cur !== sha) return false;
    fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, body); return true;
  }
  const payload = { message, content: Buffer.from(body).toString('base64') };
  if (sha) payload.sha = sha;
  const r = await fetch(`https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/contents/${file}`,
    { method: 'PUT', headers: Object.assign({ 'Content-Type': 'application/json' }, ghHeaders()), body: JSON.stringify(payload) });
  if (r.status === 409 || r.status === 422) return false;
  if (!r.ok) throw new Error('GitHub PUT ' + file + ' → ' + r.status + ' ' + (await r.text()).slice(0, 160));
  return true;
}
function ghHeaders() {
  const pat = process.env.GITHUB_PAT;
  if (!pat) throw new Error('GITHUB_PAT not set');
  return { 'Authorization': 'token ' + pat.trim(), 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'fob-interview-server/2.0' };
}
async function retrying(fn) {
  for (let i = 0; i < 6; i++) {
    const out = await fn();
    if (out !== false) return out;
    await new Promise(r => setTimeout(r, 200 + Math.random() * 400));
  }
  throw new Error('GitHub store busy — please retry');
}

// ── Records ───────────────────────────────────────────────────────────
async function readRecords() { const g = await ghGet(FILE_RECORDS); return { records: Array.isArray(g.data) ? g.data : [], sha: g.sha }; }

// mutate(record|null) → new record object, or null for "no change". Returns the saved (or existing) record.
function upsertRecord(orderId, mutate, message) {
  return retrying(async () => {
    const { records, sha } = await readRecords();
    const i = records.findIndex(r => r.orderId === orderId);
    const cur = i >= 0 ? records[i] : null;
    const next = mutate(cur ? Object.assign({}, cur) : null);
    if (!next) return cur || null;
    if (i >= 0) records[i] = next; else records.push(next);
    const ok = await ghPut(FILE_RECORDS, records, sha, message || ('intpay: ' + next.status + ' ' + orderId));
    return ok ? next : false;
  });
}

function nextInvoiceNo() {
  return retrying(async () => {
    const g = await ghGet(FILE_COUNTER);
    const n = (Number(g.data && g.data.counter) || 0) + 1;
    const ok = await ghPut(FILE_COUNTER, { counter: n }, g.sha, 'inv-counter: ' + n);
    return ok ? INV_PREFIX + String(n).padStart(INV_PAD, '0') : false;
  });
}

// ── Money / GST (mirrors the page's calcGSTSplitFromInclusive) ─────────
const r2d = (x) => Math.round(x * 100) / 100;
function gstSplit(total, currency, buyerStateCode) {
  if (currency !== 'INR') return { base: total, cgst: 0, sgst: 0, igst: 0, gst: 0, total, taxType: 'NONE' };
  const base = r2d(total / (1 + GST_RATE)), gst = r2d(total - base);
  if (buyerStateCode && String(buyerStateCode) === SELLER_STATE_CODE) {
    const cgst = r2d(base * 0.09);
    return { base, cgst, sgst: r2d(gst - cgst), igst: 0, gst, total, taxType: 'CGST_SGST' };
  }
  return { base, cgst: 0, sgst: 0, igst: gst, gst, total, taxType: 'IGST' };
}
function fmtMoney(amt, cur) {
  const sym = { INR: '₹', USD: '$', EUR: '€' }[cur] || '';
  const d = cur === 'INR' ? 0 : 2;
  return sym + Number(amt).toLocaleString(cur === 'INR' ? 'en-IN' : 'en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}
function ddmmyyyy(d) {
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', day: '2-digit', month: '2-digit', year: 'numeric' }).formatToParts(d);
  const g = (t) => p.find(x => x.type === t).value;
  return g('day') + '/' + g('month') + '/' + g('year');
}

const BILL_FIELDS = ['name', 'email', 'mobile', 'billCompany', 'billLine1', 'billLine2', 'billCity', 'billPincode',
                     'billCountry', 'billStateCode', 'billStateName', 'gstin', 'gstLegalName'];
function cleanBilling(b) {
  const out = {};
  BILL_FIELDS.forEach(k => { out[k] = String((b && b[k]) == null ? '' : b[k]).replace(/[\u0000-\u001f<>]/g, ' ').trim().slice(0, 200); });
  out.email = out.email.toLowerCase();
  out.billCountry = out.billCountry || 'IN';
  out.gstin = out.gstin.toUpperCase();
  return out;
}

// Called when the server creates the Razorpay order: the "initiated" register line.
function recordInitiated(o) {
  const product = catalog.getProduct(o.productKey);
  const amount = product.prices[o.currency];
  const b = cleanBilling(o.billing);
  const split = gstSplit(amount, o.currency, b.billCountry === 'IN' ? b.billStateCode : '');
  const now = new Date();
  return upsertRecord(o.orderRef, (cur) => {
    if (cur && cur.status === 'submitted') return null;            // never downgrade a paid order
    if (cur && cur.rzpOrderId && cur.rzpOrderId !== o.rzpOrderId) return null;   // never overwrite another order
    return Object.assign(cur || {}, b, {
      orderId: o.orderRef, status: 'initiated', rzpOrderId: o.rzpOrderId,
      productKey: o.productKey, module: product.name, guide: product.name,
      amount, currency: o.currency,
      baseAmt: split.base, gstAmt: split.gst, totalAmt: split.total,
      cgstAmt: split.cgst, sgstAmt: split.sgst, igstAmt: split.igst, taxType: split.taxType,
      placeOfSupply: b.billStateName ? (b.billStateName + (b.billStateCode ? ' (' + b.billStateCode + ')' : '')) : '',
      invoiceNo: '', invNo: '', invDate: ddmmyyyy(now), dueDate: ddmmyyyy(new Date(now.getTime() + 15 * 864e5)),
      initiatedAt: (cur && cur.initiatedAt) || now.toISOString(), submittedAt: null, utr: null
    });
  });
}

// Called once per paid order (by whichever of verify/webhook fulfils it first).
// Assigns the invoice number, marks the line paid and sends the invoice + admin emails.
async function recordPaid(order, payment) {
  const notes = order.notes || {};
  const orderRef = notes.order_ref || order.receipt || order.id;
  const existing = (await readRecords()).records.find(r => r.orderId === orderRef);
  if (existing && existing.status === 'submitted' && existing.invoiceNo) return { record: existing, fresh: false };

  const invNo = await nextInvoiceNo();
  const productKey = notes.product_key;
  const product = catalog.getProduct(productKey);
  const amount = Number(order.amount) / 100;
  const now = new Date();
  const saved = await upsertRecord(orderRef, (cur) => {
    if (cur && cur.status === 'submitted' && cur.invoiceNo) return null;
    const base = cur || Object.assign(cleanBilling({ name: notes.cust_name, email: notes.cust_email }), { initiatedAt: now.toISOString() });
    const split = gstSplit(amount, order.currency, base.billCountry === 'IN' ? base.billStateCode : '');
    return Object.assign(base, {
      orderId: orderRef, status: 'submitted', rzpOrderId: order.id, paymentId: payment ? payment.id : '',
      utr: payment ? payment.id : '', productKey, module: product ? product.name : productKey, guide: product ? product.name : productKey,
      amount, currency: order.currency,
      baseAmt: split.base, gstAmt: split.gst, totalAmt: split.total,
      cgstAmt: split.cgst, sgstAmt: split.sgst, igstAmt: split.igst, taxType: split.taxType,
      invoiceNo: invNo, invNo, invDate: ddmmyyyy(now), dueDate: ddmmyyyy(new Date(now.getTime() + 15 * 864e5)),
      submittedAt: now.toISOString(), orderRef
    });
  }, 'intpay: submitted ' + orderRef + ' ' + invNo);
  const rec = saved || (await readRecords()).records.find(r => r.orderId === orderRef);
  return { record: rec, fresh: rec && rec.invoiceNo === invNo };
}

// Shape the page's GST-invoice PDF generator expects (window.downloadInvoice).
function invoiceView(rec) {
  if (!rec) return null;
  const keys = ['invNo', 'invDate', 'dueDate', 'name', 'email', 'mobile', 'guide', 'currency', 'baseAmt', 'gstAmt', 'totalAmt',
    'cgstAmt', 'sgstAmt', 'igstAmt', 'taxType', 'billCompany', 'billLine1', 'billLine2', 'billCity', 'billPincode',
    'billStateCode', 'billStateName', 'billCountry', 'gstin', 'gstLegalName', 'placeOfSupply', 'paymentId', 'orderRef'];
  const o = {}; keys.forEach(k => { o[k] = rec[k] == null ? '' : rec[k]; });
  o.invNo = rec.invoiceNo || rec.invNo; o.orderRef = rec.orderId;
  return o;
}

module.exports = { readRecords, upsertRecord, nextInvoiceNo, recordInitiated, recordPaid, invoiceView, gstSplit, fmtMoney, cleanBilling,
  ghGet, ghPut, FILE_RECORDS, FILE_COUNTER, INV_PREFIX, INV_PAD };
