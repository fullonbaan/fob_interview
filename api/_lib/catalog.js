// api/_lib/catalog.js — SERVER-SIDE source of truth for prices and bundle contents.
// The browser never decides what a customer is charged or what they unlock.
// ⚠ If you change a price in index.html (GUIDES), change it here too —
//   the server always charges THIS price.

const TECH = ['dev', 'adm', 'std', 'ion', 'bod', 'ext', 'os'];
const FUNC = ['fin', 'scm', 'mfg', 'pln', 'wms'];
const ALL  = TECH.concat(FUNC);

// Individual ebooks. `file` is the object key of the MASTER pdf in the private R2 bucket.
const EBOOKS = {
  dev: { name: 'Infor LN Development Interview Guide',    track: 'Technical'  },
  adm: { name: 'Infor LN Administration Interview Guide', track: 'Technical'  },
  bod: { name: 'Infor BOD Interview Guide',               track: 'Technical'  },
  ion: { name: 'Infor ION Interview Guide',               track: 'Technical'  },
  ext: { name: 'Infor LN Extensions Interview Guide',     track: 'Technical'  },
  os:  { name: 'Infor OS Administration Interview Guide', track: 'Technical'  },
  std: { name: 'Infor LN Studio Interview Guide',         track: 'Technical'  },
  fin: { name: 'Infor LN Finance Interview Guide',        track: 'Functional' },
  scm: { name: 'Infor LN SCM Interview Guide',            track: 'Functional' },
  mfg: { name: 'Infor LN Manufacturing Interview Guide',  track: 'Functional' },
  pln: { name: 'Infor LN Planning Interview Guide',       track: 'Functional' },
  wms: { name: 'Infor LN WMS Interview Guide',            track: 'Functional' }
};
Object.keys(EBOOKS).forEach(k => { EBOOKS[k].key = k; EBOOKS[k].file = 'ebooks/' + k + '.pdf'; });

const IND_PRICE = { INR: 699, USD: 10, EUR: 10 };

// Everything that can be bought, what it costs, and which ebooks it unlocks.
const PRODUCTS = {};
ALL.forEach(k => { PRODUCTS[k] = { name: EBOOKS[k].name, prices: IND_PRICE, unlocks: [k] }; });
PRODUCTS.combo_tech = { name: 'Combo Technical — All 7 Tech Guides',  prices: { INR: 2999, USD: 39, EUR: 35 }, unlocks: TECH };
PRODUCTS.combo_func = { name: 'Combo Functional — All 5 Func Guides', prices: { INR: 1999, USD: 29, EUR: 25 }, unlocks: FUNC };
PRODUCTS.combo_all  = { name: 'Full Academy — All 12 Guides',         prices: { INR: 3999, USD: 49, EUR: 40 }, unlocks: ALL };

const CURRENCIES = ['INR', 'USD', 'EUR'];

function getProduct(key) {
  return Object.prototype.hasOwnProperty.call(PRODUCTS, key) ? PRODUCTS[key] : null;
}
function priceMinor(key, currency) {
  const p = getProduct(key);
  if (!p || CURRENCIES.indexOf(currency) < 0) return null;
  const major = p.prices[currency];
  return major == null ? null : Math.round(major * 100);
}
function isEbook(k) { return Object.prototype.hasOwnProperty.call(EBOOKS, k); }

module.exports = { EBOOKS, PRODUCTS, CURRENCIES, ALL, TECH, FUNC, getProduct, priceMinor, isEbook };
