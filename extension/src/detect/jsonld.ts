/** Detector 2: schema.org Product + Offer in JSON-LD, which most UK retailers publish. */
import type { DetectorHit, PageContext, PurchaseType } from "./types";
import { canonicalUrl, clean, parsePrice } from "./text";

type Json = Record<string, unknown>;

const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : v == null ? [] : [v]);

function hasType(node: Json, type: string): boolean {
  return asArray(node["@type"]).some((t) => typeof t === "string" && t.replace(/^https?:\/\/schema\.org\//, "") === type);
}

/** Every object in the JSON-LD blocks, flattening arrays, @graph and nested values. */
function* walk(v: unknown, depth = 0): Generator<Json> {
  if (depth > 8) return;
  for (const x of asArray(v)) {
    if (!isObj(x)) continue;
    yield x;
    for (const child of Object.values(x)) if (typeof child === "object") yield* walk(child, depth + 1);
  }
}

export function jsonLdNodes(doc: Document): Json[] {
  const out: Json[] = [];
  for (const s of Array.from(doc.querySelectorAll('script[type="application/ld+json"]'))) {
    try {
      out.push(...walk(JSON.parse(s.textContent ?? "")));
    } catch {
      // Malformed JSON-LD is common; skip that block.
    }
  }
  return out;
}

const nameOf = (v: unknown): string | null => {
  for (const x of asArray(v)) {
    if (typeof x === "string" && clean(x)) return clean(x);
    if (isObj(x) && typeof x.name === "string" && clean(x.name)) return clean(x.name);
  }
  return null;
};

interface OfferInfo { price: number | null; seller: string | null; recurring: boolean }

function offerInfo(offers: unknown): OfferInfo {
  const list = asArray(offers).filter(isObj);
  // AggregateOffer: use lowPrice/price, then its nested offers.
  for (const o of list) {
    const specs = asArray(o.priceSpecification).filter(isObj);
    const spec = specs.find((s) => s.price != null) ?? specs[0];
    const price = parsePrice(o.price) ?? parsePrice(spec?.price) ?? parsePrice(o.lowPrice);
    const recurring = specs.some((s) =>
      /^(MON|ANN|WEE)$/i.test(String(s.unitCode ?? "")) || s.billingDuration != null || s.billingIncrement != null);
    if (price !== null) return { price, seller: nameOf(o.seller) ?? nameOf(o.offeredBy), recurring };
    if (o.offers) {
      const inner = offerInfo(o.offers);
      if (inner.price !== null) return inner;
    }
  }
  return { price: null, seller: null, recurring: false };
}

export function jsonLdDetector({ url, doc }: PageContext): DetectorHit | null {
  const product = jsonLdNodes(doc).find((n) => (hasType(n, "Product") || hasType(n, "ProductGroup")) && nameOf(n.name));
  if (!product) return null;

  const offer = offerInfo(product.offers ?? (product.hasVariant ? asArray(product.hasVariant).filter(isObj).map((v) => v.offers) : null));
  const brand = nameOf(product.brand) ?? nameOf(product.manufacturer);
  const idField = ["sku", "gtin13", "gtin12", "gtin14", "gtin8", "gtin", "mpn", "productID"].find((k) => product[k] != null);
  const signals: PurchaseType[] = ["product"];
  if (offer.recurring) signals.push("subscription");

  let itemUrl = canonicalUrl(doc, url);
  if (typeof product.url === "string") {
    try {
      const u = new URL(product.url, url);
      if (u.hostname === url.hostname) itemUrl = u.toString();
    } catch {
      /* keep canonical */
    }
  }

  return {
    item: {
      name: nameOf(product.name),
      brand,
      price: offer.price,
      seller: offer.seller,
      url: itemUrl,
      id: idField ? String(product[idField]) : null,
    },
    signals,
  };
}
