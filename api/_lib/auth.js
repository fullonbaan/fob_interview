// api/_lib/auth.js — one admin secret for every admin endpoint.
// Header:  Authorization: Bearer <ADMIN_API_TOKEN>   (Vercel env, 32+ random characters)
const C = require('./crypto');

function isAdmin(req) {
  const t = process.env.ADMIN_API_TOKEN;
  if (!t || t.length < 32) return false;
  const h = String(req.headers.authorization || '');
  return h.startsWith('Bearer ') && C.safeEqual(h.slice(7).trim(), t);
}

// Use at the top of a handler:  if (!(await requireAdmin(req, res))) return;
async function requireAdmin(req, res) {
  if (isAdmin(req)) return true;
  await new Promise(r => setTimeout(r, 400));            // slow down guessing
  res.statusCode = 401;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify({ error: 'Unauthorized' }));
  return false;
}

module.exports = { isAdmin, requireAdmin };
