// api/razorpay-webhook.js — safety net. Razorpay calls this server-to-server when an order
// is paid, so customers get access even if they closed the browser before the thank-you page.
// Dashboard → Settings → Webhooks → URL https://interview.fullonbaan.com/api/razorpay-webhook
// Events: order.paid  (optionally payment.captured).  Secret → env RAZORPAY_WEBHOOK_SECRET.
const H = require('./_lib/http');
const rzp = require('./_lib/razorpay');
const settle = require('./_lib/settle');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return H.send(res, 405, { error: 'Method not allowed.' });
  let raw;
  try {
    // Signature is over the exact raw bytes, so read the stream (do not touch req.body).
    raw = await H.readRaw(req, 512 * 1024);
  } catch (e) { return H.send(res, 400, { error: 'Bad body' }); }

  const sig = req.headers['x-razorpay-signature'];
  let valid = false;
  try { valid = rzp.verifyWebhookSignature(raw.toString('utf8'), sig); } catch (e) { console.error(e.message); }
  if (!valid) { console.warn('webhook: invalid signature from', H.clientIp(req)); return H.send(res, 400, { error: 'Invalid signature' }); }

  let evt; try { evt = JSON.parse(raw.toString('utf8')); } catch (e) { return H.send(res, 400, { error: 'Bad JSON' }); }
  try {
    const p = evt.payload || {};
    const payment = p.payment && p.payment.entity;
    let orderId = (p.order && p.order.entity && p.order.entity.id) || (payment && payment.order_id);
    if ((evt.event === 'order.paid' || evt.event === 'payment.captured') && orderId) {
      const order = await rzp.fetchOrder(orderId);               // re-read from Razorpay
      if (!order.notes || !order.notes.product_key) return H.send(res, 200, { ignored: 'not a members order' });
      const s = await settle.settle(order, payment, H.siteUrl(req), 'webhook');
      return H.send(res, 200, { ok: true, duplicate: s.fulfil.duplicate, invoice: s.record ? s.record.invoiceNo : null });
    }
    return H.send(res, 200, { ignored: evt.event });
  } catch (e) {
    console.error('webhook fulfilment error', e);
    return H.send(res, 500, { error: 'retry' });                  // Razorpay retries on non-2xx
  }
};
