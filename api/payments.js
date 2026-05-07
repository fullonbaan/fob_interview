// api/payments.js — Secure GitHub proxy for Interview payment records
// Reads/writes  fullonbaan/fob_pay_store_ln_intv : payments/interview_payments.json
// Vercel runtime: Node.js. The PAT is read from process.env.GITHUB_PAT
// and never reaches the browser.

const https = require('https');

const GH_OWNER = 'fullonbaan';
const GH_REPO  = 'fob_pay_store_ln_intv';
const GH_FILE  = 'payments/interview_payments.json';

function ghRequest(method, bodyObj) {
  return new Promise((resolve, reject) => {
    const pat = process.env.GITHUB_PAT;
    if (!pat) return reject(new Error('GITHUB_PAT environment variable is not set.'));

    const payload = bodyObj ? JSON.stringify(bodyObj) : null;
    const options = {
      hostname: 'api.github.com',
      path: `/repos/${GH_OWNER}/${GH_REPO}/contents/${GH_FILE}`,
      method,
      headers: {
        'Authorization': `token ${pat.trim()}`,
        'Accept':        'application/vnd.github.v3+json',
        'User-Agent':    'fob-interview-payments-proxy/1.0',
        'Content-Type':  'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {})
      }
    };

    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, body });
      });
    });

    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    // ── GET: read payment records ─────────────────────────────────────────
    if (req.method === 'GET') {
      const result = await ghRequest('GET');

      // File not yet created — return empty list
      if (result.status === 404) {
        return res.status(200).json({ records: [], sha: null });
      }

      if (result.status !== 200) {
        console.error('GitHub GET error', result.status, result.body.slice(0, 200));
        return res.status(502).json({ error: `GitHub returned ${result.status}: ${result.body.slice(0, 100)}` });
      }

      let ghData;
      try {
        ghData = JSON.parse(result.body);
      } catch (e) {
        return res.status(502).json({ error: 'Invalid JSON from GitHub: ' + e.message });
      }

      if (!ghData.content) {
        return res.status(200).json({ records: [], sha: ghData.sha || null });
      }

      let records;
      try {
        const decoded = Buffer.from(ghData.content.replace(/\n/g, ''), 'base64').toString('utf8');
        records = decoded.trim() ? JSON.parse(decoded) : [];
      } catch (e) {
        return res.status(502).json({ error: 'Failed to decode payment records: ' + e.message });
      }

      return res.status(200).json({ records, sha: ghData.sha });
    }

    // ── PUT: upsert records (caller passes the merged array + sha) ────────
    if (req.method === 'PUT') {
      const { records, sha, message } = req.body || {};

      if (!Array.isArray(records)) {
        return res.status(400).json({ error: '`records` array is required.' });
      }

      const content = Buffer.from(JSON.stringify(records, null, 2)).toString('base64');
      const body    = { message: message || 'intpay: update', content };
      if (sha) body.sha = sha;

      const result = await ghRequest('PUT', body);

      if (result.status !== 200 && result.status !== 201) {
        console.error('GitHub PUT error', result.status, result.body.slice(0, 200));
        return res.status(502).json({ error: `GitHub write returned ${result.status}: ${result.body.slice(0, 100)}` });
      }

      let data;
      try {
        data = JSON.parse(result.body);
      } catch (e) {
        return res.status(502).json({ error: 'Invalid JSON from GitHub write response' });
      }

      return res.status(200).json({ sha: data.content && data.content.sha });
    }

    return res.status(405).json({ error: 'Method not allowed.' });

  } catch (e) {
    console.error('payments proxy error:', e);
    return res.status(500).json({ error: e.message });
  }
};
