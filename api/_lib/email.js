// api/_lib/email.js — sends member emails from the SERVER through EmailJS's REST API.
// Env: EMAILJS_SERVICE_ID, EMAILJS_PUBLIC_KEY, EMAILJS_PRIVATE_KEY, EMAILJS_MEMBER_TEMPLATE
// The EmailJS template needs only: To = {{to_email}}, Subject = {{subject}}, Body = {{{html_body}}}
const fs = require('fs');

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function sendMail(to, subject, html, text) {
  if (process.env.FOB_EMAIL_LOG) {           // offline testing
    fs.appendFileSync(process.env.FOB_EMAIL_LOG, JSON.stringify({ to, subject, text }) + '\n');
    return true;
  }
  const svc = process.env.EMAILJS_SERVICE_ID, pub = process.env.EMAILJS_PUBLIC_KEY,
        priv = process.env.EMAILJS_PRIVATE_KEY, tpl = process.env.EMAILJS_MEMBER_TEMPLATE;
  if (!svc || !pub || !priv || !tpl) { console.error('EmailJS env not configured — email to', to, 'not sent'); return false; }
  const r = await fetch('https://api.emailjs.com/api/v1.0/email/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      service_id: svc, template_id: tpl, user_id: pub, accessToken: priv,
      template_params: { to_email: to, subject, html_body: html, text_body: text, reply_to: 'support@fullonbaan.com' }
    })
  });
  if (!r.ok) { console.error('EmailJS send failed', r.status, (await r.text()).slice(0, 200)); return false; }
  return true;
}

// Send with one of your existing EmailJS templates (e.g. FOB_Razorpay_Success) from the SERVER.
async function sendTemplate(templateId, params) {
  if (process.env.FOB_EMAIL_LOG) {
    fs.appendFileSync(process.env.FOB_EMAIL_LOG, JSON.stringify({ to: params.to_email, subject: params.subject, template: templateId }) + '\n');
    return true;
  }
  const svc = process.env.EMAILJS_SERVICE_ID, pub = process.env.EMAILJS_PUBLIC_KEY, priv = process.env.EMAILJS_PRIVATE_KEY;
  if (!svc || !pub || !priv) { console.error('EmailJS env not configured — template', templateId, 'not sent'); return false; }
  const r = await fetch('https://api.emailjs.com/api/v1.0/email/send', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ service_id: svc, template_id: templateId, user_id: pub, accessToken: priv, template_params: params })
  });
  if (!r.ok) { console.error('EmailJS template send failed', templateId, r.status, (await r.text()).slice(0, 200)); return false; }
  return true;
}

function shell(title, inner) {
  return '<div style="background:#F9F6F1;padding:28px 12px;font-family:Arial,Helvetica,sans-serif;">' +
    '<div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #E8E2D9;border-radius:12px;overflow:hidden;">' +
    '<div style="background:#1A160F;padding:20px 28px;"><span style="color:#E2B96A;font-family:Georgia,serif;font-size:20px;font-weight:bold;">FullOnBaan</span>' +
    '<span style="color:#C9943E;font-size:12px;letter-spacing:2px;margin-left:8px;">MEMBERS</span></div>' +
    '<div style="padding:28px;color:#1A160F;font-size:15px;line-height:1.6;"><h2 style="font-family:Georgia,serif;margin:0 0 14px;font-size:21px;">' + esc(title) + '</h2>' + inner + '</div>' +
    '<div style="padding:16px 28px;background:#F9F6F1;color:#8C8070;font-size:12px;line-height:1.5;">Your access is personal to you. Downloads are watermarked with your name and email and are logged. ' +
    'Need help? Reply to this email or write to support@fullonbaan.com.<br>&copy; FullOnBaan Consulting Services, Bangalore</div></div></div>';
}
function codeBox(code) {
  return '<div style="margin:18px 0;padding:16px;border:1px dashed #A8782A;border-radius:10px;background:#FFFDF8;text-align:center;">' +
    '<div style="font-size:11px;letter-spacing:2px;color:#8C8070;">YOUR ACCESS CODE</div>' +
    '<div style="font-family:Consolas,Menlo,monospace;font-size:26px;font-weight:bold;letter-spacing:3px;color:#7B3210;margin-top:6px;">' + esc(code) + '</div></div>';
}
function button(url, label) {
  return '<p style="margin:22px 0;"><a href="' + esc(url) + '" style="background:#A8782A;color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:bold;display:inline-block;">' + esc(label) + '</a></p>';
}
function list(names) { return '<ul style="padding-left:18px;margin:8px 0;">' + names.map(n => '<li>' + esc(n) + '</li>').join('') + '</ul>'; }

// After a purchase. `code` is present only when a new code was issued.
function purchaseEmail(o) {
  const loginUrl = o.siteUrl + '/members';
  const subject = o.code ? 'Your FullOnBaan access code — download your interview guides'
                         : 'New guides added to your FullOnBaan library';
  const html = shell(o.code ? 'Welcome, ' + (o.name || 'there') + '!' : 'Your library has been updated',
    '<p>Thank you for your purchase' + (o.orderRef ? ' (order <b>' + esc(o.orderRef) + '</b>)' : '') + '. These guides are now in your library:</p>' +
    list(o.guideNames) +
    (o.code
      ? '<p>Sign in to the Members Area with your email <b>' + esc(o.email) + '</b> and this code:</p>' + codeBox(o.code)
      : '<p>Sign in with your email <b>' + esc(o.email) + '</b> and your existing access code. Forgot it? Use “Email me a new code” on the sign-in page.</p>') +
    button(loginUrl, 'Open my library') +
    '<p style="color:#524B3E;font-size:13px;">Keep this code private. Anyone with it can see your library.</p>');
  const text = subject + '\n\nGuides: ' + o.guideNames.join(', ') + '\n' + (o.code ? 'Access code: ' + o.code + '\n' : '') + 'Sign in: ' + loginUrl;
  return sendMail(o.email, subject, html, text);
}

function newCodeEmail(o) {
  const loginUrl = o.siteUrl + '/members';
  const subject = 'Your new FullOnBaan access code';
  const html = shell('Here is your new access code',
    '<p>A new access code was requested for <b>' + esc(o.email) + '</b>. Your previous code no longer works.</p>' +
    codeBox(o.code) + button(loginUrl, 'Sign in') +
    '<p style="color:#524B3E;font-size:13px;">Didn’t ask for this? You can ignore this email, but your old code has been replaced. Contact support@fullonbaan.com if this keeps happening.</p>');
  return sendMail(o.email, subject, html, subject + '\n\nAccess code: ' + o.code + '\nSign in: ' + loginUrl);
}

module.exports = { sendMail, sendTemplate, purchaseEmail, newCodeEmail, esc };
