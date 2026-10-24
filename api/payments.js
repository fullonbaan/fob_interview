// api/payments.js — ADMIN-ONLY access to the order register used by the #admin panel.
// Every call needs  Authorization: Bearer <ADMIN_API_TOKEN>.  No cross-site (CORS) access.
// Customer checkouts never call this: the server records orders itself in /api/checkout.
// Storage: private repo fullonbaan/fob_pay_store_ln_intv : payments/interview_payments.json
//   GET                         → { records, sha }
//   PUT { records, sha, message } → { sha }   (409 if someone saved in between — reload and retry)
const { requireAdmin } = require('./_lib/auth');
const H = require('./_lib/http');
const pay = require('./_lib/payrecords');

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
  if (!(await requireAdmin(req, res))) return;
  try {
    if (req.method === 'GET') {
      const r = await pay.readRecords();
      return H.send(res, 200, { records: r.records, sha: r.sha });
    }
    if (req.method === 'PUT') {
      const b = await H.readJson(req);
      if (!Array.isArray(b.records)) return H.send(res, 400, { error: '`records` array is required.' });
      const ok = await pay.ghPut(pay.FILE_RECORDS, b.records, b.sha || null, String(b.message || 'intpay: admin update').slice(0, 120));
      if (!ok) return H.send(res, 409, { error: 'The register changed since you loaded it — refresh and try again.' });
      const fresh = await pay.readRecords();
      return H.send(res, 200, { sha: fresh.sha });
    }
    return H.send(res, 405, { error: 'Method not allowed.' });
  } catch (e) {
    console.error('payments api error', e);
    return H.send(res, 500, { error: e.message });
  }
};
