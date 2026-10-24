// api/_lib/stamp.js — per-buyer PDF watermark ("social DRM").
// Every page gets a small footer: "Licensed to <name> · <email> · <order> — personal use only".
// The PDF metadata also carries the buyer's identity. A leaked copy is traceable to the buyer.
const { PDFDocument, StandardFonts, rgb, degrees } = require('pdf-lib');

async function stampPdf(masterBuf, who) {
  const pdf = await PDFDocument.load(masterBuf, { ignoreEncryption: true, updateMetadata: false });
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const line = ('Licensed to ' + (who.name || '') + ' · ' + who.email + ' · ' + (who.orderId || '') +
               ' — Personal use only. Redistribution prohibited. © FullOnBaan')
               .replace(/[^\x20-\x7E -ÿ—]/g, '');   // WinAnsi-safe for Helvetica
  const diag = (who.email || '').replace(/[^\x20-\x7E]/g, '');
  pdf.getPages().forEach(page => {
    const { width, height } = page.getSize();
    let size = 6.5;
    while (size > 4 && font.widthOfTextAtSize(line, size) > width - 40) size -= 0.5;
    const w = font.widthOfTextAtSize(line, size);
    page.drawText(line, { x: Math.max(20, (width - w) / 2), y: 10, size, font, color: rgb(0.45, 0.42, 0.38), opacity: 0.85 });
    // Very faint diagonal mark — survives cropping of the footer.
    page.drawText(diag, { x: width * 0.18, y: height * 0.35, size: 34, font, color: rgb(0.66, 0.47, 0.16),
      opacity: 0.06, rotate: degrees(35) });
  });
  pdf.setSubject('Licensed to ' + who.email + ' (' + (who.orderId || '') + ')');
  pdf.setKeywords(['FullOnBaan', 'licensed:' + who.email, 'order:' + (who.orderId || '')]);
  pdf.setProducer('FullOnBaan Members');
  return Buffer.from(await pdf.save({ useObjectStreams: true }));
}

module.exports = { stampPdf };
