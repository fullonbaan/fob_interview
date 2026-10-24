// api/_lib/library.js — the ebook shelf is read LIVE from the private bucket.
// No code change is needed to add, replace or remove ebooks:
//
//   ebooks/<guide>/<any name>.pdf   → every PDF in the folder is part of that guide
//   ebooks/<guide>.pdf              → (older single-file layout, still supported)
//
// Title shown to customers = file name without ".pdf", with an optional ordering
// prefix removed:  "01 - Core 4GL Q&A.pdf"  →  "Core 4GL Q&A"   (sorted by the prefix)
// Files whose name starts with "_" or "." are hidden (drafts).
//
// Thumbnails:  ebooks/<guide>/_thumbs/<pdf file name>.jpg   (legacy: ebooks/_thumbs/<guide>.pdf.jpg)
// Generated automatically from page 1 by the admin page, or uploaded as a custom image.
const r2 = require('./r2');
const catalog = require('./catalog');

const ROOT = 'ebooks/';

function titleFromFile(name) {
  return String(name).replace(/\.pdf$/i, '')
    .replace(/^\s*\d{1,3}\s*[-_.):]+\s*/, '')     // "01 - " / "2_" / "03) "
    .replace(/_/g, ' ').replace(/\s+/g, ' ').trim() || 'Ebook';
}

// id = path relative to ebooks/  e.g. "dev/01 - Core 4GL.pdf"  or legacy "dev.pdf"
function parseKey(key) {
  if (!key.startsWith(ROOT) || !/\.pdf$/i.test(key)) return null;
  const rel = key.slice(ROOT.length);
  const parts = rel.split('/');
  if (parts.length === 1) {                                  // legacy ebooks/dev.pdf
    const g = parts[0].replace(/\.pdf$/i, '');
    if (!catalog.isEbook(g)) return null;
    return { guide: g, id: rel, file: parts[0], title: catalog.EBOOKS[g].name, legacy: true };
  }
  if (parts.length !== 2) return null;                       // no deeper folders
  const [g, file] = parts;
  if (!catalog.isEbook(g) || !file || /^[_.]/.test(file)) return null;
  return { guide: g, id: rel, file, title: titleFromFile(file), legacy: false };
}

function thumbKeyForId(id) {
  const i = id.lastIndexOf('/');
  return ROOT + (i >= 0 ? id.slice(0, i + 1) : '') + '_thumbs/' + id.slice(i + 1) + '.jpg';
}

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

// → { dev: [ {id, key, title, size, updated}, … ], fin: [...], … }  (every guide present, maybe empty)
async function shelf() {
  const objs = await r2.listObjects(ROOT);
  const byKey = {}; objs.forEach(o => { byKey[o.key] = o; });
  const out = {}; Object.keys(catalog.EBOOKS).forEach(g => { out[g] = []; });
  objs.forEach(o => {
    const p = parseKey(o.key);
    if (!p) return;
    const tk = thumbKeyForId(p.id), t = byKey[tk];
    out[p.guide].push({
      id: p.id, key: o.key, file: p.file, title: p.title, size: o.size, updated: o.lastModified, legacy: p.legacy,
      thumbKey: t ? tk : null,
      thumbStale: !t || (o.lastModified && t.lastModified && new Date(t.lastModified) < new Date(o.lastModified))
    });
  });
  Object.keys(out).forEach(g => out[g].sort((a, b) => (b.legacy - a.legacy) || collator.compare(a.file, b.file)));
  return out;
}

// Validate an id coming from a browser and resolve it to an object key (or null).
function keyForId(guide, id) {
  id = String(id || '');
  if (id.includes('..') || id.includes('\\') || id.startsWith('/')) return null;
  const p = parseKey(ROOT + id);
  return p && p.guide === guide ? ROOT + id : null;
}

// Clean an uploaded file name so it is safe as an object key and reads well as a title.
function safeFileName(name) {
  let n = String(name || '').split(/[\\/]/).pop().replace(/[^\w\s.,()&+'-]/g, ' ').replace(/\s+/g, ' ').trim();
  n = n.replace(/^\.+/, '').replace(/\.pdf$/i, '').trim() + '.pdf';
  return n.length > 4 ? n.slice(-140) : null;
}

module.exports = { ROOT, shelf, keyForId, thumbKeyForId, titleFromFile, safeFileName, parseKey };
