// api/invoice-counter.js — Sequential GST invoice number generator
// GET            → atomically increments counter and returns next FOB#######
// POST {counter} → sets counter to a specific value (used by Renumber migration).
// Storage: fullonbaan/fob_pay_store_ln_intv : payments/invoice_counter.json
// Vercel runtime: Node.js. PAT is read from process.env.GITHUB_PAT.

const https = require('https');

const GH_OWNER = 'fullonbaan';
const GH_REPO  = 'fob_pay_store_ln_intv';
const GH_FILE  = 'payments/invoice_counter.json';
const PREFIX   = 'FOB';
const PAD      = 7;        // FOB + 7 digits → FOB0000001 .. FOB9999999

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
        'User-Agent':    'fob-interview-counter-proxy/1.0',
        'Content-Type':  'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {})
      }
    };

    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function fmt(n) { return PREFIX + String(n).padStart(PAD, '0'); }

async function readCounter() {
  const r = await ghRequest('GET');
  if (r.status === 404) return { current: 0, sha: null };
  if (r.status !== 200) throw new Error('GitHub GET ' + r.status);
  const ghData = JSON.parse(r.body);
  let current = 0;
  if (ghData.content) {
    const decoded = Buffer.from(ghData.content.replace(/\n/g, ''), 'base64').toString('utf8');
    try {
      const data = JSON.parse(decoded);
      current = Number(data.counter) || 0;
    } catch(e) { /* keep current = 0 */ }
  }
  return { current, sha: ghData.sha || null };
}

async function writeCounter(value, sha) {
  const content = Buffer.from(JSON.stringify({ counter: value }, null, 2)).toString('base64');
  const body = { message: `inv-counter: ${value}`, content };
  if (sha) body.sha = sha;
  const r = await ghRequest('PUT', body);
  if (r.status !== 200 && r.status !== 201) throw new Error('GitHub PUT ' + r.status);
  return value;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  // ── GET: atomically increment and return next invoice number ─────────
  if (req.method === 'GET') {
    try {
      const { current, sha } = await readCounter();
      const next = current + 1;
      await writeCounter(next, sha);
      return res.status(200).json({ invoiceNo: fmt(next), counter: next });
    } catch (e) {
      console.error('invoice-counter GET error:', e);
      // Never block a confirmed payment — return a timestamp fallback
      return res.status(200).json({ invoiceNo: PREFIX + Date.now(), fallback: true });
    }
  }

  // ── POST { counter: N }: set counter to a specific value (migration) ──
  if (req.method === 'POST') {
    try {
      const newCounter = parseInt(req.body && req.body.counter, 10);
      if (!Number.isFinite(newCounter) || newCounter < 0) {
        return res.status(400).json({ error: 'Invalid counter value' });
      }
      const { sha } = await readCounter();
      await writeCounter(newCounter, sha);
      return res.status(200).json({ counter: newCounter, invoiceNo: fmt(newCounter) });
    } catch (e) {
      console.error('invoice-counter POST error:', e);
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed.' });
};
