/** Is this a basket / checkout / payment step? Drives the toolbar badge. */
import { clean } from "./text";

const CHECKOUT_PATH = /\/(?:checkout|basket|cart|bag|payment|order-?review|place-?order)(?:s)?(?:[/?.#-]|$)|\/gp\/(?:buy|cart)\//i;
const PAY_BUTTON = /^(?:place (?:your )?order|pay now|pay £[\d,.]+|complete (?:purchase|order|payment)|confirm (?:and pay|order|purchase|payment)|submit order|buy now and pay|proceed to payment|continue to payment|join now and pay|start (?:my )?membership)$/i;

export function isCheckout(url: URL, doc: Document): boolean {
  if (CHECKOUT_PATH.test(url.pathname)) return true;
  if (doc.querySelector('input[autocomplete^="cc-"], input[name*="cardnumber" i], input[name*="card_number" i]')) return true;
  const buttons = doc.querySelectorAll('button, input[type="submit"], a[role="button"]');
  for (const b of Array.from(buttons)) {
    const label = clean(b.textContent || b.getAttribute("value") || b.getAttribute("aria-label"));
    if (PAY_BUTTON.test(label)) return true;
  }
  return false;
}
