/**
 * Detector 3: subscription or contract wording, for pages without an adapter or JSON-LD
 * (gym joins, streaming sign-ups, broadband/mobile deals). Also supplies the wording
 * signals added to every detection.
 */
import type { DetectorHit, PageContext, PurchaseType } from "./types";
import { canonicalUrl, clean, meta, textLines, textOf } from "./text";

const MONEY = String.raw`£\s?(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?)`;
const PERIOD = String.raw`(?:\s*(?:\/|per|a|an|each|every)\s*(?:calendar\s+)?(?:month|mo|mth)\b|\s*(?:pcm|p\/m)\b)`;

/** "£24.99 a month", "£29.99/month", "£5.99 per month", "£12 pcm" */
export const RECURRING_PRICE = new RegExp(MONEY + PERIOD, "i");

const SUBSCRIPTION = [
  RECURRING_PRICE,
  /\bmonthly (?:membership|subscription|plan|fee|payment)s?\b/i,
  /\bsubscri(?:be|ption)\b/i,
  /\bauto[- ]?renew/i,
  /\brenews? automatically\b/i,
  /\bcancel (?:at )?any ?time\b/i,
  /\bfree trial\b/i,
  /\b(?:join|joining) fee\b/i,
  /\bmembership\b/i,
  /\bbilled (?:monthly|annually|every)\b/i,
];

const CONTRACT = [
  /\b\d{1,2}[- ]month (?:minimum )?(?:contract|term|plan|agreement)\b/i,
  /\bminimum (?:contract )?term\b/i,
  /\bcontract (?:length|term|period)\b/i,
  /\bearly (?:termination|exit|cancellation) (?:fee|charge)s?\b/i,
  /\bexit fees?\b/i,
  /\bprice (?:rise|increase)s? (?:each|every) (?:april|year)\b/i,
  /\bannual price (?:rise|increase)\b/i,
  /\bcontract summary\b/i,
  /\bcooling[- ]off period\b/i,
];

/** Lines that say "subscribe" but are about newsletters, channels etc., not a purchase. */
export const NOISE = /\b(?:newsletter|mailing list|e-?mail updates|our channel|podcast|notifications|unsubscribe)\b/i;

/** Optional extras sold alongside a product ("add a care plan for £1.99 a month"). Not the item itself. */
const ADD_ON = /\b(?:care|protection|repair|breakdown) plans?\b|\b(?:insurance|extended warranty|cover from)\b/i;

export const ALL_WORDING = [...SUBSCRIPTION, ...CONTRACT];

/**
 * `ignoreAddOns`: on product pages, monthly prices for care plans or insurance
 * describe an optional extra, so they don't make the product a subscription.
 */
export function wordingSignals(
  lines: string[],
  { ignoreAddOns = false } = {},
): { signals: PurchaseType[]; subscriptionHits: number; contractHits: number } {
  const relevant = lines.filter((l) => !NOISE.test(l) && !(ignoreAddOns && ADD_ON.test(l)));
  const count = (patterns: RegExp[]) => patterns.filter((p) => relevant.some((l) => p.test(l))).length;
  const subscriptionHits = count(SUBSCRIPTION);
  const contractHits = count(CONTRACT);
  const hasRecurringPrice = relevant.some((l) => RECURRING_PRICE.test(l));
  const signals: PurchaseType[] = [];
  // One stray "subscribe" isn't enough: need a recurring price or two separate subscription cues.
  if (hasRecurringPrice || subscriptionHits >= 2) signals.push("subscription");
  if (contractHits >= 1) signals.push("contract");
  return { signals, subscriptionHits, contractHits };
}

function firstRecurringPrice(lines: string[]): number | null {
  for (const l of lines) {
    if (NOISE.test(l)) continue;
    const m = l.match(RECURRING_PRICE);
    if (m) return Number(m[1].replace(/,/g, ""));
  }
  return null;
}

/** Page title without the " | Site name" / " - Site name" suffix. */
function pageName(doc: Document, siteName: string | null): string | null {
  // An explicitly marked-up product/plan name beats the heading ("Review your order" on checkouts).
  const named = textOf(doc.querySelector(
    '[itemprop="name"], [class*="product-name" i], [class*="plan-name" i], [class*="product-title" i], [data-testid*="product-name" i]',
  ));
  if (named) return named;
  const og = meta(doc, "og:title");
  const h1 = textOf(doc.querySelector("main h1, h1"));
  const raw = og || h1 || clean(doc.title);
  if (!raw) return null;
  const parts = raw.split(/\s+[|–—-]\s+/);
  if (parts.length > 1 && siteName && parts.at(-1)!.toLowerCase().includes(siteName.toLowerCase())) parts.pop();
  return parts.join(" - ") || null;
}

/** Site/brand name: og:site_name, else the title suffix, else the domain's main label. */
function siteName(doc: Document, url: URL): string | null {
  const og = meta(doc, "og:site_name", "application-name");
  if (og) return og;
  const parts = clean(doc.title).split(/\s+[|–—-]\s+/);
  if (parts.length > 1) return parts.at(-1)!;
  const label = url.hostname.replace(/^www\./, "").split(".")[0];
  return label ? label[0].toUpperCase() + label.slice(1) : null;
}

export function wordingDetector({ url, doc }: PageContext): DetectorHit | null {
  const root = doc.querySelector("main") ?? doc.body;
  const lines = textLines(root);
  const { signals } = wordingSignals(lines);
  if (signals.length === 0) return null;

  const price = firstRecurringPrice(lines) ?? (Number(meta(doc, "product:price:amount", "og:price:amount")) || null);
  // Wording without any price is too weak to call a purchase (e.g. an article about subscriptions).
  if (price === null) return null;

  const brand = siteName(doc, url);
  return {
    item: { name: pageName(doc, brand), brand, price, seller: brand, url: canonicalUrl(doc, url), id: null },
    signals,
    textRoots: root ? [root] : [],
  };
}
