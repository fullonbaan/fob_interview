// api/checkout.js — server-side Razorpay checkout.
//   POST /api/checkout?action=order   → creates a Razorpay Order at the CATALOG price
//   POST /api/checkout?action=verify  → verifies the payment signature, unlocks the ebooks,
//                                       registers the order + GST invoice number, sends emails
//   POST /api/checkout?action=event   → {type:'failed'|'abandon', orderRef}: alert to the admin only
// Env: RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET (+ storage / email / session env, see SETUP)
const H = require('./_lib/http');
const C = require('./_lib/crypto');
const catalog = require('./_lib/catalog');
const rzp = require('./_lib/razorpay');
const settle = require('./_lib/settle');
const pay = require('./_lib/payrecords');

const clip = (v, n) => String(v == null ? '' : v).slice(0, n || 250);

async function createOrder(req, res) {
  const b = await H.readJson(req);
  const productKey = String(b.product || '');
  const currency = String(b.currency || 'INR').toUpperCase();
  const product = catalog.getProduct(productKey);
  const amount = catalog.priceMinor(productKey, currency);
  const email = C.normEmail(b.customer && b.customer.email);
  if (!product || amount == null) return H.send(res, 400, { error: 'Unknown product or currency.' });
  if (!C.isEmail(email)) return H.send(res, 400, { error: 'A valid email is required.' });

  // Server-controlled notes first (these drive fulfilment), then billing notes from the form.
  const notes = {
    product_key: productKey,
    cust_email: email,
    cust_name: clip(b.customer.name, 120),
    order_ref: 'FOB' + Date.now() + String(require('crypto').randomInt(100, 1000))   // server-made, unique
  };
  const extra = b.notes && typeof b.notes === 'object' ? b.notes : {};
  Object.keys(extra).forEach(k => {
    if (Object.keys(notes).length >= 15 || notes[k] !== undefined) return;
    const v = extra[k]; if (v === '' || v == null) return;
    notes[clip(k, 40)] = clip(v, 250);
  });

  const order = await rzp.createOrder({
    amount, currency,
    receipt: notes.order_ref,
    notes,
    payment_capture: 1
  });
  // Register line ("initiated") written by the server — the browser never touches the register.
  try {
    await pay.recordInitiated({ orderRef: notes.order_ref || order.receipt, rzpOrderId: order.id, productKey, currency,
      billing: Object.assign({}, b.billing || {}, { name: b.customer.name, email, mobile: b.customer.mobile }) });
  } catch (e) { console.error('register (initiated) failed', e.message); }
  return H.send(res, 200, {
    orderId: order.id, orderRef: notes.order_ref, amount: order.amount, currency: order.currency,
    keyId: process.env.RAZORPAY_KEY_ID, productName: product.name
  });
}

async function verify(req, res) {
  const b = await H.readJson(req);
  const orderId = String(b.razorpay_order_id || ''), paymentId = String(b.razorpay_payment_id || ''), sig = String(b.razorpay_signature || '');
  if (!orderId || !paymentId || !sig) return H.send(res, 400, { error: 'Missing payment fields.' });
  if (!rzp.verifyCheckoutSignature(orderId, paymentId, sig)) {
    console.warn('checkout verify: BAD SIGNATURE', orderId, paymentId, H.clientIp(req));
    return H.send(res, 400, { error: 'Payment signature could not be verified.' });
  }
  // Never trust the browser beyond the signature — load the truth from Razorpay.
  let order = await rzp.fetchOrder(orderId);
  let payment = await rzp.fetchPayment(paymentId);
  if (payment.order_id !== orderId) return H.send(res, 400, { error: 'Payment does not belong to this order.' });
  if (payment.status === 'authorized') {
    payment = await rzp.capturePayment(paymentId, order.amount, order.currency);
    order = await rzp.fetchOrder(orderId);
  }
  if (payment.status !== 'captured') return H.send(res, 409, { error: 'Payment is ' + payment.status + ', not captured yet. Your access will be emailed as soon as it completes.' });

  const s = await settle.settle(order, payment, H.siteUrl(req), 'verify');
  const r = s.fulfil;
  return H.send(res, 200, {
    ok: true,
    email: r.member.email,
    code: r.code || null,                // shown once on the thank-you screen for brand-new members
    returning: !r.code,
    invoice: s.invoice,                  // server-assigned GST invoice (number, amounts, billing) for the PDF
    unlocked: (catalog.getProduct(order.notes.product_key) || { unlocks: [] }).unlocks,
    membersUrl: '/members'
  });
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return H.send(res, 405, { error: 'Method not allowed.' });
  if (H.isCrossSite(req)) return H.send(res, 403, { error: 'Cross-site request blocked.' });
  const action = H.getQuery(req).action;
  try {
    if (action === 'order') return await createOrder(req, res);
    if (action === 'verify') return await verify(req, res);
    if (action === 'event') {
      const b = await H.readJson(req);
      const type = b.type === 'failed' ? 'failed' : b.type === 'abandon' ? 'abandon' : null;
      if (type) { try { await settle.alertAdmin(String(b.orderRef || ''), type); } catch (e) { console.error('alert failed', e.message); } }
      return H.send(res, 200, { ok: true });
    }
    return H.send(res, 404, { error: 'Unknown action.' });
  } catch (e) {
    console.error('checkout error', action, e);
    return H.send(res, 500, { error: 'Server error — if you were charged, your access will still be emailed. Contact support@fullonbaan.com.' });
  }
};
