// api/_lib/settle.js — everything that must happen exactly once when an order is paid:
//   1. unlock the ebooks (members library)            — idempotent per order
//   2. register line → "submitted" + GST invoice number — guarded by a lock so that verify and
//      the webhook arriving together can never assign two invoice numbers
//   3. invoice email to the customer + order alert to you (only by whoever assigned the number)
const r2 = require('./r2');
const members = require('./members');
const pay = require('./payrecords');
const mail = require('./email');

const ADMIN_EMAIL = () => process.env.ADMIN_ALERT_EMAIL || 'fullonbaan@gmail.com';
const TPL_OK = () => process.env.EMAILJS_TEMPLATE_PAYMENT || 'FOB_Razorpay_Success';
const TPL_FAIL = () => process.env.EMAILJS_TEMPLATE_FAILURE || 'FOB_Razorpay_Failure';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function findRecord(orderRef) {
  return (await pay.readRecords()).records.find(r => r.orderId === orderRef) || null;
}

async function ensureInvoice(order, payment, siteUrl) {
  const notes = order.notes || {};
  const orderRef = notes.order_ref || order.receipt || order.id;
  let rec = await findRecord(orderRef);
  if (rec && rec.status === 'submitted' && rec.invoiceNo) return rec;

  const lockKey = 'locks/invoice-' + order.id + '.txt';
  let mine = await r2.putObject(lockKey, String(Date.now()), 'text/plain', { ifNoneMatch: '*' });
  if (!mine) {
    // Someone else is on it — wait for their result; take over only if their lock is stale.
    for (let i = 0; i < 10; i++) {
      await sleep(1000);
      rec = await findRecord(orderRef);
      if (rec && rec.status === 'submitted' && rec.invoiceNo) return rec;
    }
    const l = await r2.getObject(lockKey);
    const age = l ? Date.now() - Number(l.body.toString()) : Infinity;
    if (age < 90000) return null;
    await r2.putObject(lockKey, String(Date.now()), 'text/plain');
    mine = true;
  }
  const res = await pay.recordPaid(order, payment);
  if (res.fresh) await paymentEmails(res.record, siteUrl);
  return res.record;
}

async function paymentEmails(rec, siteUrl) {
  const amt = pay.fmtMoney(rec.totalAmt, rec.currency) +
    (rec.currency === 'INR' ? ' (Base: ' + pay.fmtMoney(rec.baseAmt, 'INR') + ' + GST ' + pay.fmtMoney(rec.gstAmt, 'INR') + ')' : ' (no GST)');
  const common = {
    order_ref: rec.orderId, utr_number: rec.paymentId, guide: rec.guide, cust_name: rec.name, cust_email: rec.email,
    cust_mobile: rec.mobile ? '+91 ' + rec.mobile : '(not provided)'
  };
  try {
    await mail.sendTemplate(TPL_OK(), Object.assign({}, common, {
      to_email: ADMIN_EMAIL(), subject: 'New Order — ' + rec.guide, status: 'PAYMENT CONFIRMED — RAZORPAY',
      amount: amt, message: 'Invoice No: ' + rec.invoiceNo + '. Payment ID: ' + rec.paymentId
    }));
    await mail.sendTemplate(TPL_OK(), Object.assign({}, common, {
      to_email: rec.email, subject: 'Your FullonBaan Tax Invoice — ' + rec.invoiceNo, status: 'PAYMENT CONFIRMED',
      amount: pay.fmtMoney(rec.totalAmt, rec.currency),
      message: 'Thank you! Your payment (ID: ' + rec.paymentId + ') was successful. Invoice No: ' + rec.invoiceNo +
        '. Your access code has been emailed separately - sign in at ' + siteUrl + '/members to read and download your guides. ' +
        'Download your GST invoice from the confirmation page or contact us at support@fullonbaan.com.'
    }));
  } catch (e) { console.error('payment emails failed', e); }
}

// Unlock + register + emails. Safe to call any number of times for the same order.
async function settle(order, payment, siteUrl, via) {
  const f = await members.fulfilOrder(order, payment, siteUrl, via);
  let rec = null;
  try { rec = await ensureInvoice(order, payment, siteUrl); }
  catch (e) { console.error('ORDER PAID BUT REGISTER/INVOICE FAILED', order.id, e); }
  return { fulfil: f, record: rec, invoice: pay.invoiceView(rec) };
}

// Alerts you about a failed / abandoned checkout. Only for real orders our server created,
// only to YOUR address, at most once per order and type — so it can't be used to send spam.
async function alertAdmin(orderRef, type) {
  if (!/^[A-Za-z0-9_-]{6,40}$/.test(String(orderRef || ''))) return false;
  let send = null;
  await pay.upsertRecord(orderRef, (cur) => {
    if (!cur || cur.status !== 'initiated') return null;
    cur.alerts = cur.alerts || {};
    if (cur.alerts[type]) return null;
    cur.alerts[type] = new Date().toISOString();
    if (type === 'failed') { cur.status = 'failed'; cur.failedAt = new Date().toISOString(); }
    send = cur; return cur;
  }, 'intpay: ' + type + ' ' + orderRef);
  if (!send) return false;
  const base = {
    to_email: ADMIN_EMAIL(), order_ref: orderRef, guide: send.guide, amount: pay.fmtMoney(send.totalAmt, send.currency),
    cust_name: send.name, cust_email: send.email, cust_mobile: send.mobile ? '+91 ' + send.mobile : '(not provided)'
  };
  if (type === 'failed') {
    await mail.sendTemplate(TPL_FAIL(), Object.assign(base, { subject: 'Payment Failed — ' + send.guide, status: 'PAYMENT FAILED', message: 'Payment failed.' }));
  } else {
    await mail.sendTemplate(TPL_OK(), Object.assign(base, {
      subject: '⚠️ Checkout left open — ' + send.name, status: 'CHECKOUT ABANDONED', utr_number: '(none)',
      message: 'Customer opened Razorpay checkout but left the page without completing payment. Order Ref: ' + orderRef
    }));
  }
  return true;
}

module.exports = { settle, ensureInvoice, alertAdmin };
