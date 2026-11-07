/** Detector 1: Amazon product pages (amazon.co.uk and the other storefronts). */
import type { DetectorHit, PageContext, PurchaseType } from "./types";
import { clean, parsePrice, textLines, textOf } from "./text";

const AMAZON_HOST = /(^|\.)amazon\.(co\.uk|com|de|fr|it|es|nl|se|pl|ie|ca|com\.au|in|co\.jp|com\.mx|com\.br)$/i;
const ASIN_IN_PATH = /\/(?:dp|gp\/product|gp\/aw\/d)\/([A-Z0-9]{10})(?:[/?]|$)/i;

export function isAmazon(url: URL): boolean {
  return AMAZON_HOST.test(url.hostname);
}

const first = (doc: Document, selectors: string[]): Element | null => {
  for (const s of selectors) {
    const el = doc.querySelector(s);
    if (el && textOf(el)) return el;
  }
  return null;
};

/** "Visit the SodaStream Store" / "Brand: SodaStream" → "SodaStream" */
function brandFrom(doc: Document): string | null {
  const byline = textOf(doc.querySelector("#bylineInfo"));
  const m = byline.match(/^Visit the (.+?) Store$/i) ?? byline.match(/^Brand:\s*(.+)$/i);
  if (m) return clean(m[1]);
  const row = doc.querySelector("#productOverview_feature_div tr.po-brand td:last-child, tr.po-brand td.a-span9");
  return textOf(row) || byline || null;
}

/** "Dispatched from and sold by Amazon." → "Amazon"; seller link text wins when present. */
function sellerFrom(doc: Document): string | null {
  const link = textOf(doc.querySelector("#sellerProfileTriggerId"));
  if (link) return link;
  const tabular = first(doc, [
    '#merchantInfoFeature_feature_div .offer-display-feature-text-message',
    '[offer-display-feature-name="desktop-merchant-info"] .offer-display-feature-text-message',
  ]);
  if (tabular) return textOf(tabular);
  const info = textOf(first(doc, ["#merchantInfo", "#merchant-info"]));
  const m = info.match(/sold by\s+(.+?)(?:\.\s|\.$| and |$)/i);
  return m ? clean(m[1]) : null;
}

export function amazonDetector({ url, doc }: PageContext): DetectorHit | null {
  if (!isAmazon(url)) return null;
  const title = textOf(doc.querySelector("#productTitle"));
  if (!title) return null; // search, basket, checkout, account pages etc.

  const asin = url.pathname.match(ASIN_IN_PATH)?.[1]?.toUpperCase()
    ?? (doc.querySelector("input#ASIN, input[name='ASIN']")?.getAttribute("value") || null);

  const priceEl = first(doc, [
    "#corePrice_feature_div .a-price .a-offscreen",
    "#corePriceDisplay_desktop_feature_div .a-price .a-offscreen",
    "#apex_desktop .a-price .a-offscreen",
    "#priceblock_ourprice",
    "#priceblock_dealprice",
    "#price_inside_buybox",
    "#centerCol .a-price .a-offscreen",
  ]);

  const signals: PurchaseType[] = ["product"];
  if (doc.querySelector("#snsAccordionRowMiddle, #sns-base-price, [data-csa-c-content-id*='subscribe-and-save']")) {
    signals.push("subscription");
  }

  const bullets = textLines(doc.querySelector("#feature-bullets"), false);
  const roots = ["#centerCol", "#rightCol", "#feature-bullets", "#productDescription"]
    .map((s) => doc.querySelector(s))
    .filter((e): e is Element => !!e);

  return {
    item: {
      name: title,
      brand: brandFrom(doc),
      price: parsePrice(textOf(priceEl)),
      seller: sellerFrom(doc),
      url: asin ? `${url.origin}/dp/${asin}` : url.origin + url.pathname,
      id: asin,
    },
    signals,
    textRoots: roots,
    snippets: [title, ...bullets],
  };
}
