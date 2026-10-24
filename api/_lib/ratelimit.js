// api/_lib/ratelimit.js — simple fixed-window limits stored in the private R2 bucket.
// One tiny object per (rule, visitor) that is overwritten each window, so nothing piles up.
// If storage is unreachable the request is ALLOWED (never block a real sale because of a limiter).
const crypto = require('crypto');
const r2 = require('./r2');

// allow('order', ip, 10, 3600) → true while this ip has made < 10 calls in the current hour
async function allow(rule, who, limit, windowSec) {
  const id = crypto.createHash('sha256').update(rule + '|' + String(who || 'unknown')).digest('hex').slice(0, 24);
  const key = 'ratelimit/' + rule + '/' + id + '.json';
  const win = Math.floor(Date.now() / 1000 / windowSec);
  try {
    const cur = await r2.getJson(key);
    const st = cur && cur.data && cur.data.w === win ? cur.data : { w: win, c: 0 };
    if (st.c >= limit) return false;
    st.c += 1;
    await r2.putJson(key, st);
    return true;
  } catch (e) {
    console.warn('ratelimit unavailable (allowing):', e.message);
    return true;
  }
}

module.exports = { allow };
