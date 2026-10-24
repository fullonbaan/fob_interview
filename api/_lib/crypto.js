// api/_lib/crypto.js — access codes, hashing, and signed session tokens.
const crypto = require('crypto');

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I/L
const CODE_LEN = 10;

function normEmail(e) { return String(e || '').trim().toLowerCase(); }
function isEmail(e) { return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e) && e.length <= 254; }
function emailHash(e) { return crypto.createHash('sha256').update(normEmail(e)).digest('hex'); }

function newAccessCode() {
  const bytes = crypto.randomBytes(CODE_LEN);
  let s = '';
  for (let i = 0; i < CODE_LEN; i++) s += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return 'FOB-' + s.slice(0, 5) + '-' + s.slice(5);
}
// Accepts "fob-abcde-fghjk", "ABCDE FGHJK", etc.
function normCode(c) {
  let s = String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (s.length === CODE_LEN + 3 && s.startsWith('FOB')) s = s.slice(3);
  return s;
}

function scrypt(pw, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(pw, salt, 32, { N: 16384, r: 8, p: 1 }, (err, key) => err ? reject(err) : resolve(key));
  });
}
async function hashCode(code) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(normCode(code), salt);
  return 'scrypt$' + salt.toString('base64') + '$' + key.toString('base64');
}
async function verifyCode(code, stored) {
  // Always do the expensive work so timing does not reveal whether the account exists.
  const parts = String(stored || '').split('$');
  const salt = parts.length === 3 ? Buffer.from(parts[1], 'base64') : crypto.randomBytes(16);
  const key = await scrypt(normCode(code), salt);
  if (parts.length !== 3) return false;
  const want = Buffer.from(parts[2], 'base64');
  return want.length === key.length && crypto.timingSafeEqual(want, key);
}

function b64u(buf) { return Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_'); }
function unb64u(s) { return Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64'); }

function sessionSecret() {
  const s = process.env.MEMBER_SESSION_SECRET;
  if (!s || s.length < 32) throw new Error('MEMBER_SESSION_SECRET is missing or shorter than 32 characters.');
  return s;
}
function signSession(payload) {
  const body = b64u(JSON.stringify(payload));
  const sig = b64u(crypto.createHmac('sha256', sessionSecret()).update(body).digest());
  return body + '.' + sig;
}
function verifySession(token) {
  if (!token || token.indexOf('.') < 0) return null;
  const [body, sig] = token.split('.');
  const want = b64u(crypto.createHmac('sha256', sessionSecret()).update(body).digest());
  const a = Buffer.from(sig || ''), b = Buffer.from(want);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let p; try { p = JSON.parse(unb64u(body).toString('utf8')); } catch (e) { return null; }
  if (!p || !p.exp || Date.now() > p.exp) return null;
  return p;
}

function safeEqual(a, b) {
  const x = crypto.createHash('sha256').update(String(a || '')).digest();
  const y = crypto.createHash('sha256').update(String(b || '')).digest();
  return crypto.timingSafeEqual(x, y) && String(a || '').length > 0;
}

module.exports = { normEmail, isEmail, emailHash, newAccessCode, normCode, hashCode, verifyCode, signSession, verifySession, safeEqual };
