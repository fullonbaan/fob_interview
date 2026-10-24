// api/invoice-counter.js — ADMIN-ONLY GST invoice counter (Bearer ADMIN_API_TOKEN).
// Paid orders get their number automatically on the server (/api/checkout); this endpoint is
// only for the #admin panel (manual entries and the "Renumber" migration).
//   GET              → next number, e.g. { invoiceNo: "FOB0000042", counter: 42 }  (increments)
//   POST {counter:N} → set the counter (Renumber migration)
const { requireAdmin } = require('./_lib/auth');
const H = require('./_lib/http');
const pay = require('./_lib/payrecords');

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
  if (!(await requireAdmin(req, res))) return;
  try {
    if (req.method === 'GET') {
      const invoiceNo = await pay.nextInvoiceNo();
      return H.send(res, 200, { invoiceNo, counter: Number(invoiceNo.slice(pay.INV_PREFIX.length)) });
    }
    if (req.method === 'POST') {
      const b = await H.readJson(req);
      const n = parseInt(b.counter, 10);
      if (!Number.isFinite(n) || n < 0) return H.send(res, 400, { error: 'Invalid counter value' });
      for (let i = 0; i < 6; i++) {
        const g = await pay.ghGet(pay.FILE_COUNTER);
        if (await pay.ghPut(pay.FILE_COUNTER, { counter: n }, g.sha, 'inv-counter: set ' + n)) {
          return H.send(res, 200, { counter: n, invoiceNo: pay.INV_PREFIX + String(n).padStart(pay.INV_PAD, '0') });
        }
      }
      return H.send(res, 409, { error: 'Counter busy — retry' });
    }
    return H.send(res, 405, { error: 'Method not allowed.' });
  } catch (e) {
    console.error('invoice-counter error', e);
    return H.send(res, 500, { error: e.message });
  }
};
