// api/_lib/razorpay.js — server-side Razorpay calls. The KEY SECRET lives only in
// process.env.RAZORPAY_KEY_SECRET and never reaches the browser.
const crypto = require('crypto');

function creds() {
  const id = process.env.RAZORPAY_KEY_ID, secret = process.env.RAZORPAY_KEY_SECRET;
  if (!id || !secret) throw new Error('RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET not set.');
  return { id, secret };
}

async function api(method, path, body) {
  if (process.env.FOB_RZP_MOCK) return require(process.env.FOB_RZP_MOCK)(method, path, body);
  const { id, secret } = creds();
  const r = await fetch('https://api.razorpay.com/v1' + path, {
    method,
    headers: {
      'Authorization': 'Basic ' + Buffer.from(id + ':' + secret).toString('base64'),
      'Content-Type': 'application/json'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch (e) { data = { raw: text }; }
  if (!r.ok) {
    const msg = (data && data.error && data.error.description) || text.slice(0, 200);
    const err = new Error('Razorpay ' + method + ' ' + path + ' → ' + r.status + ': ' + msg);
    err.status = r.status; throw err;
  }
  return data;
}

const createOrder  = (o)  => api('POST', '/orders', o);
const fetchOrder   = (id) => api('GET', '/orders/' + encodeURIComponent(id));
const fetchOrderPayments = (id) => api('GET', '/orders/' + encodeURIComponent(id) + '/payments');
const fetchPayment = (id) => api('GET', '/payments/' + encodeURIComponent(id));
const capturePayment = (id, amount, currency) => api('POST', '/payments/' + encodeURIComponent(id) + '/capture', { amount, currency });

function hmacHex(secret, data) { return crypto.createHmac('sha256', secret).update(data).digest('hex'); }
function eqHex(a, b) {
  const x = Buffer.from(String(a || ''), 'utf8'), y = Buffer.from(String(b || ''), 'utf8');
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

// Checkout handler signature: HMAC_SHA256(order_id + "|" + payment_id, key_secret)
function verifyCheckoutSignature(orderId, paymentId, signature) {
  return eqHex(hmacHex(creds().secret, orderId + '|' + paymentId), signature);
}
// Webhook signature: HMAC_SHA256(raw_body, webhook_secret)
function verifyWebhookSignature(rawBody, signature) {
  const s = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!s) throw new Error('RAZORPAY_WEBHOOK_SECRET not set.');
  return eqHex(hmacHex(s, rawBody), signature);
}

module.exports = { createOrder, fetchOrder, fetchOrderPayments, fetchPayment, capturePayment, verifyCheckoutSignature, verifyWebhookSignature };
