# Members Library — setup & operations guide

How buyers of the interview ebooks get a private, members-only library at
**https://interview.fullonbaan.com/members**, and how to set it up.

---

## 1. How it works

```
 Customer picks guide ──► /api/checkout?action=order
                          (server creates Razorpay ORDER at the catalogue price,
                           stores product_key + email in the order notes)
          │
          ▼
 Razorpay checkout ──paid──► /api/checkout?action=verify      (browser, instantly)
                    └──────► /api/razorpay-webhook             (Razorpay server, safety net)
                               │  both: verify HMAC signature → re-read order from Razorpay
                               │        → check amount & status → unlock ebooks (idempotent)
                               ▼
                       Member record in private R2 bucket
                       + access code (stored only as a scrypt hash)
                       + email with code  ──► customer
          │
          ▼
 /members  ── email + access code ──► HttpOnly session cookie (7 days)
          ── library shows ONLY the purchased guides (bundles unlock their contents)
          ── Read / Download ──► /api/member?action=file
                                   checks session + entitlement + download cap
                                   → creates a personal watermarked copy (first time)
                                   → 302 to a signed link valid for 5 minutes
```

**Returning customers** keep one code for life. A new purchase just adds guides to the same
library; the email says "sign in with your existing code". Lost code → "Email me a new one".

---

## 2. Where to keep the ebooks: a private Cloudflare R2 bucket

| Option | Verdict |
|---|---|
| Inside this repo / Vercel `public` files | ❌ Anything deployed is publicly downloadable by URL. The repo is also **public** on GitHub. |
| Google Drive / Dropbox share links | ❌ Links are forwardable forever, no per-buyer control. |
| Public GitHub repo / CDN | ❌ Same problem. |
| **Cloudflare R2 private bucket + signed links** | ✅ **Recommended.** No public URL exists. The server checks who is asking, then issues a link that expires in 5 minutes. S3-compatible, 10 GB free, **no download (egress) fees**. |
| AWS S3 private bucket | ✅ Also fine (same design), but you pay per GB downloaded. |

### Bucket layout — each guide is a folder, every PDF in it is part of that guide

```
fob-interview-ebooks/                    (PRIVATE — public access OFF)
├── ebooks/
│   ├── dev/                             ← Development guide = everything in this folder
│   │   ├── 01 - Core 4GL & Sessions.pdf     shown as "Core 4GL & Sessions"
│   │   ├── 02 - Advanced Scenarios.pdf      shown as "Advanced Scenarios"
│   │   ├── 03 - DAL & Scripts.pdf
│   │   └── _draft-next-edition.pdf          "_" prefix = hidden draft
│   ├── fin/
│   │   ├── 01 - GL, AP & AR.pdf
│   │   └── 02 - Tax & Period Close.pdf
│   ├── adm/  bod/  ion/  ext/  os/  std/  scm/  mfg/  pln/  wms/
│   └── dev.pdf, fin.pdf …               ← old single-file location, still works
├── members/  orders/  stamped/          (automatic — don't touch)
```

Folder names are the guide codes: `dev adm bod ion ext os std fin scm mfg pln wms`.

**Rules (no code ever needed):**
- Every `.pdf` in a guide's folder shows up in the library of everyone who owns that guide, straight away (including past buyers and bundle buyers).
- **Title shown = file name** without `.pdf`. A leading number such as `01 - `, `2_` or `03) ` sets the order and is hidden from customers.
- Names starting with `_` are hidden (drafts).
- **Replace** an ebook by uploading a file with the same name. Every buyer gets the new edition on their next open (their personal watermarked copy is rebuilt automatically).
- **Delete** a file to remove it from libraries. Copies already downloaded are unaffected.
- The open/download limit (`DOWNLOAD_LIMIT_PER_GUIDE`, default 25) now applies **per ebook**.

### Two ways to add ebooks
1. **From `/members-admin` → Ebook library → "+ Upload PDF(s)"** next to the guide (multiple files at once, progress shown, warns before replacing). Needs the one-time CORS rule below.
2. **Cloudflare dashboard** → R2 → bucket → Objects → open `ebooks/` → open/create the guide folder → Upload.

### Thumbnails (automatic)
- Every ebook shows a cover thumbnail made from **page 1 of the PDF**.
- They are created **automatically whenever you open `/members-admin`** (and right after an upload). The status line says
  "Creating thumbnails 3/12…" then "✔ All ebooks have thumbnails". Leave the tab open until it finishes.
- Rendering uses PDFium (Chrome's own PDF engine), so gradients and colours match the real cover.
- If you **replace a PDF**, its thumbnail is rebuilt the next time you open the admin page.
- **Custom cover:** click **Thumbnail** next to any ebook and pick an image (JPG/PNG). It's resized and used instead.
  (Replacing that PDF later will regenerate it from page 1 again.)
- Stored privately next to the ebook: `ebooks/<guide>/_thumbs/<pdf name>.jpg`. Moving, renaming or deleting an ebook carries its thumbnail along.
- Until a thumbnail exists, customers see a gold-on-black placeholder with the ebook title — never a broken image.

### One-time: allow the admin page to upload and make thumbnails (R2 CORS rule)
Cloudflare → R2 → `fob-interview-ebooks` → **Settings → CORS Policy** → JSON:

```json
[
  {
    "AllowedOrigins": ["https://interview.fullonbaan.com", "https://fob-interview.vercel.app"],
    "AllowedMethods": ["PUT", "GET", "HEAD"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

`PUT` lets the admin page upload; `GET` lets it read a PDF to draw its thumbnail. Both only work with a
short-lived signed link that the server gives to an authenticated admin, so nothing in the bucket becomes public.

### What customers see
- **Track filter:** All tracks / Technical / Functional.
- **Jump chips** for each guide they own (with ebook counts), which stay pinned while scrolling.
- **One section per guide** (cover, track, name, number of ebooks), with a grid of ebook cards:
  thumbnail, title, size, "Opened x of N", **Read online** and **Download**. Clicking the thumbnail also opens it.
- **"More interview guides"** at the bottom: the guides they don't own yet, linking to the shop.

## 3. One-time setup (≈ 30 minutes)

### Step 1 — URGENT: rotate the Razorpay key secret
The old live **key secret was written in a comment in `index.html`**, which is served publicly
and is in the history of the public GitHub repo. It is removed from the code now, but treat it
as compromised:

1. Razorpay Dashboard → **Account & Settings → API Keys → Regenerate Key** (Live mode).
2. Put the new **Key ID** in Vercel env `RAZORPAY_KEY_ID` **and** in `index.html` (`RZP_KEY_ID`, used only as a fallback).
3. Put the new **Key Secret** only in Vercel env `RAZORPAY_KEY_SECRET`. Never in any file.

### Step 2 — Create the R2 bucket
1. Cloudflare dashboard → **R2 Object Storage** → *Create bucket* → name `fob-interview-ebooks`, location *Automatic*.
2. Bucket → **Settings**: leave **Public access = Disabled**. Do **not** enable the r2.dev URL or a custom domain.
3. R2 overview → **Manage R2 API Tokens → Create API token**
   - Permissions: **Object Read & Write**
   - Specify bucket: **only `fob-interview-ebooks`**
   - Copy **Access Key ID**, **Secret Access Key**, and your **Account ID** (shown on the R2 overview page).
4. Upload the ebooks into `ebooks/<guide>/` folders (or later from `/members-admin`). See the bucket layout above.

### Step 3 — EmailJS template for member emails (server-side sending)
1. EmailJS → **Account → Security**: tick **"Allow EmailJS API for non-browser applications"**.
   Copy the **Private Key** (Account → API keys).
2. **Email Templates → Create New Template**, name it `FOB_Member_Access`:
   - **To Email:** `{{to_email}}`
   - **Subject:** `{{subject}}`
   - **Reply To:** `{{reply_to}}`
   - **Content:** switch the editor to code/HTML mode and enter exactly: `{{{html_body}}}`
     (three braces = render the HTML we generate).
3. Note the template ID.

### Step 4 — Razorpay webhook (so access is granted even if the buyer closes the tab)
Razorpay Dashboard → **Account & Settings → Webhooks → Add New Webhook**
- URL: `https://interview.fullonbaan.com/api/razorpay-webhook`
- Secret: generate one (see Step 5) → also save it as `RAZORPAY_WEBHOOK_SECRET`
- Active events: **order.paid** (you may also tick payment.captured)

### Step 5 — Vercel environment variables
Project → **Settings → Environment Variables** (Production). Generate random secrets with:

```
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

| Variable | Value |
|---|---|
| `RAZORPAY_KEY_ID` | new live key id (`rzp_live_…`) |
| `RAZORPAY_KEY_SECRET` | new live key secret |
| `RAZORPAY_WEBHOOK_SECRET` | the webhook secret from Step 4 |
| `R2_ACCOUNT_ID` | Cloudflare account id |
| `R2_ACCESS_KEY_ID` | from the R2 API token |
| `R2_SECRET_ACCESS_KEY` | from the R2 API token |
| `R2_BUCKET` | `fob-interview-ebooks` |
| `EMAILJS_SERVICE_ID` | `service_2qtgzr5` |
| `EMAILJS_PUBLIC_KEY` | `3U-YZo2UCV_RG5Gjo` |
| `EMAILJS_PRIVATE_KEY` | from Step 3 |
| `EMAILJS_MEMBER_TEMPLATE` | `FOB_Member_Access` (or the ID EmailJS gave it) |
| `MEMBER_SESSION_SECRET` | random, 48 bytes (generated) |
| `ADMIN_API_TOKEN` | random, 48 bytes (generated) — your key to `/members-admin` |
| `SITE_URL` | `https://interview.fullonbaan.com` |
| *optional* `DOWNLOAD_LIMIT_PER_GUIDE` | default `25` opens per guide per buyer |
| *optional* `LINK_TTL_SECONDS` | default `300` (5-minute links) |
| *optional* `WATERMARK` | default `on`; set `off` to serve the master file |

Keep `GITHUB_PAT` as it is (used by the existing payments/invoice proxies).

### Step 6 — Deploy & test
1. Commit and push (Vercel installs `aws4fetch` and `pdf-lib` from `package.json`).
2. Open `https://interview.fullonbaan.com/members-admin`, paste `ADMIN_API_TOKEN`.
   The **Ebook library** table must show at least one ebook under every guide.
3. Grant yourself one guide (Grant access → your email) → you receive the code email →
   sign in at `/members` → Read online and Download → open the PDF and check the footer watermark.
4. Do one real ₹ purchase end to end (refund it from the Razorpay dashboard afterwards).
   The thank-you screen should show "Your library is ready" with the code.

---

## 4. Day-to-day operations — `/members-admin`

- **UPI / bank-transfer buyers** (no Razorpay signature to verify): *Grant access* → email, product
  or guides, note = UTR. The customer gets the code email automatically.
- **Customers who bought before this went live**: grant them the same way (one-time backfill from
  your payment records).
- **Lost code / suspicious sharing**: open the member → *Issue new code & email it* (also signs
  out every device), *Reset count*, *Revoke* a guide, or *Disable account*.
- **Refunds (7-day guarantee)**: refund in Razorpay, then *Revoke* the guides in admin.
- The access log shows when, what, from which IP/browser each guide was opened.

---

## 5. Security controls in this design

| Threat | Control |
|---|---|
| Guessing file URLs | No public URLs. Bucket is private; links are signed, expire in 5 min. |
| Faking a payment in the browser | Server verifies Razorpay HMAC signature **and** re-reads order + payment from Razorpay with the secret key. |
| Tampering with price / product | Price and bundle contents come only from `api/_lib/catalog.js`; order notes are written by the server. |
| Double fulfilment (verify + webhook) | Idempotent per order ID with conditional (ETag) writes. |
| Code guessing | ~10¹⁵ possible codes, 5 wrong tries → 15 min lock, constant-time checks, no "user exists" leak. |
| Stolen code database | Codes stored only as scrypt hashes. |
| Session theft via script / other sites | HttpOnly + Secure + SameSite cookie, HMAC-signed; cross-site requests rejected; session invalidated on code reset/disable. |
| Buyer shares files | Per-buyer watermark on every page + PDF metadata, per-guide open limit, access log. |
| Admin abuse | Separate 48-byte bearer token, kept in env; admin page stores it only in the current tab. |

**Honest limit:** no system can stop a paying buyer from re-sharing a PDF they downloaded. The
industry answer is deterrence + traceability (the watermark), which is what this does. Read-only
in-browser viewing with no download is possible later if you want it, but it frustrates genuine buyers.

**Optional hardening:** in Vercel → Firewall, add a rate-limit rule for `/api/member` (e.g. 30 requests/min per IP).

---

## 6. Existing issues found (outside the members feature) — please fix soon

1. **`/api/payments` is open to the internet.** Anyone can `GET` it and receive every customer's
   name, email, phone, address and GSTIN, or `PUT` to overwrite the records. It has no authentication.
2. **The admin password (`ADM_PW`) is in the page source** of `index.html`, so the "#admin" login
   protects nothing.
3. Fix for both: move payment-record writes to the server (the new `/api/checkout?action=verify`
   is the natural place) and require the `ADMIN_API_TOKEN` on `/api/payments` and `/api/invoice-counter`.
   This touches the invoice/admin panel, so it was left as a separate change.

---

## 7. Files added / changed

```
api/_lib/library.js     reads each guide's ebook folder live from the bucket (titles, order, drafts)
api/_lib/catalog.js     prices + bundle contents (server source of truth — keep in sync with GUIDES in index.html)
api/_lib/crypto.js      access codes, scrypt hashing, signed sessions
api/_lib/r2.js          private R2 storage + 5-minute signed links
api/_lib/razorpay.js    orders, payment fetch/capture, signature checks
api/_lib/members.js     member records, entitlements, fulfilment
api/_lib/stamp.js       per-buyer PDF watermark
api/_lib/email.js       code / purchase emails via EmailJS (server-side)
api/_lib/http.js        helpers
api/checkout.js         order + verify
api/razorpay-webhook.js webhook safety net
api/member.js           login, logout, library, file, resend code
api/member-admin.js     admin API
members.html            the Members Library page   (/members)
members-admin.html      admin console               (/members-admin)
index.html              server orders + verify, thank-you shows access code, "Member Login" links, secret comment removed
vercel.json             /members rewrites, security headers, function timeout
robots.txt              keeps /members, /members-admin, /api/ out of search
package.json            adds aws4fetch, pdf-lib
```

⚠ When you change a price in `index.html` → `GUIDES`, change it in `api/_lib/catalog.js` too.
The server always charges the catalogue price.
