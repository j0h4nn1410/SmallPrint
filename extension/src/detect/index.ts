/**
 * detectPurchase: page (URL + DOM) → purchase request, or "no purchase detected".
 *
 * Pure: reads the document, never changes it, and makes no chrome.* or network calls,
 * so it runs the same in the content script and in Node tests (via linkedom).
 *
 * Detectors are tried in order and the first hit wins:
 *   1. Amazon adapter   2. JSON-LD Product/Offer   3. subscription or contract wording
 * No other site adapters before H10.
 */
import type { Detection, DetectorHit, DetectorName, PageContext, PurchaseType } from "./types";
import { amazonDetector } from "./amazon";
import { jsonLdDetector } from "./jsonld";
import { wordingDetector, wordingSignals } from "./wording";
import { findTermsLinks } from "./links";
import { isCheckout } from "./checkout";
import { pickSnippets } from "./snippets";
import { textLines, uniq } from "./text";

export type { Detection } from "./types";

const DETECTORS: [DetectorName, (ctx: PageContext) => DetectorHit | null][] = [
  ["amazon", amazonDetector],
  ["jsonld", jsonLdDetector],
  ["wording", wordingDetector],
];

const SIGNAL_ORDER: PurchaseType[] = ["product", "subscription", "contract"];

export function detectPurchase(pageUrl: string, doc: Document): Detection {
  let url: URL;
  try {
    url = new URL(pageUrl);
  } catch {
    return { status: "none", checkout: false };
  }
  if (!/^https?:$/.test(url.protocol)) return { status: "none", checkout: false };

  const ctx: PageContext = { url, doc };
  const checkout = isCheckout(url, doc);

  for (const [name, detector] of DETECTORS) {
    const hit = detector(ctx);
    if (!hit) continue;

    const roots = hit.textRoots?.length ? hit.textRoots : [doc.querySelector("main") ?? doc.body].filter((e): e is HTMLElement => !!e);
    const wording = wordingSignals(roots.flatMap((r) => textLines(r)), { ignoreAddOns: name !== "wording" });
    // Amazon pages mention Prime "subscription" everywhere; trust only the adapter's own signals there.
    const signals = name === "amazon" ? hit.signals : uniq([...hit.signals, ...wording.signals]);

    return {
      status: "purchase",
      detector: name,
      checkout,
      request: {
        item: hit.item,
        purchase_type_signals: SIGNAL_ORDER.filter((s) => signals.includes(s)),
        links: findTermsLinks(doc, url),
        page_text_snippets: pickSnippets(roots, hit.snippets),
        price_drift: { first_seen: null, current: hit.item.price ?? null },
      },
    };
  }
  return { status: "none", checkout };
}
