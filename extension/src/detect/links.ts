/** Finds terms-type links (T&Cs, returns, cancellation, contract summary…) anywhere on the page, footer included. */
import type { DetectedLink, LinkKind } from "./types";
import { clean } from "./text";

// Most specific first: "Subscription terms" is `subscription`, not `terms`.
const RULES: [LinkKind, RegExp][] = [
  ["contract_summary", /contract summary/],
  ["price_guide", /price guide|pricing guide|tariff|price list|(?:our|other|call) charges|price changes/],
  ["cancel", /cancel/],
  ["subscription", /(?:subscription|membership) (?:terms|agreement|rules|policy)|membership-?terms|subscription-?terms/],
  ["returns", /returns?\b|refund/],
  ["warranty", /warrant|guarantee/],
  ["privacy", /privacy/],
  ["terms", /terms|t ?& ?cs?\b|conditions of (?:use|sale)|conditions-of-(?:use|sale)/],
];

const ORDER: LinkKind[] = ["terms", "contract_summary", "subscription", "cancel", "price_guide", "returns", "warranty", "privacy"];
const MAX_LINKS = 12;

export function classifyLink(text: string, path: string): LinkKind | null {
  const t = text.toLowerCase();
  const p = decodeURIComponent(path).toLowerCase().replace(/[-_/]+/g, " ");
  for (const [kind, re] of RULES) if (re.test(t)) return kind;
  for (const [kind, re] of RULES) if (re.test(p)) return kind;
  return null;
}

export function findTermsLinks(doc: Document, pageUrl: URL): DetectedLink[] {
  const seen = new Map<string, DetectedLink>();
  for (const a of Array.from(doc.querySelectorAll("a[href]"))) {
    const href = a.getAttribute("href") ?? "";
    if (/^(?:javascript|mailto|tel):|^#/i.test(href)) continue;
    let u: URL;
    try {
      u = new URL(href, pageUrl);
    } catch {
      continue;
    }
    if (!/^https?:$/.test(u.protocol)) continue;
    u.hash = "";
    const text = clean(a.textContent || a.getAttribute("aria-label") || a.getAttribute("title")).slice(0, 120);
    const kind = classifyLink(text, u.pathname);
    if (!kind || !text) continue;
    const key = u.toString();
    if (!seen.has(key)) seen.set(key, { url: key, text, kind });
  }
  return [...seen.values()]
    .sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind))
    .slice(0, MAX_LINKS);
}
