/** DOM-to-text helpers that work the same in a browser and in linkedom (no innerText, no layout). */

const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "SVG", "IFRAME", "INPUT", "SELECT", "TEXTAREA", "OPTION", "BUTTON"]);
const CHROME = new Set(["NAV", "HEADER", "FOOTER", "ASIDE"]);
const BLOCK = new Set([
  "ADDRESS", "ARTICLE", "BLOCKQUOTE", "BR", "DD", "DIV", "DL", "DT", "FIELDSET", "FIGCAPTION", "FIGURE", "FORM",
  "H1", "H2", "H3", "H4", "H5", "H6", "HR", "LI", "MAIN", "OL", "P", "PRE", "SECTION", "TABLE", "TBODY", "TD", "TH",
  "THEAD", "TR", "UL", "LABEL", "SUMMARY", "DETAILS",
]);

export function clean(s: string | null | undefined): string {
  return (s ?? "").replace(/\s+/g, " ").trim();
}

/** Text of an element. */
export function textOf(el: Element | null | undefined): string {
  return clean(el?.textContent);
}

/**
 * Visible-ish lines of text under `root`, one per block element.
 * Skips scripts, form controls, hidden elements and, with `skipChrome`, nav/header/footer/aside.
 */
export function textLines(root: Element | null | undefined, skipChrome = true): string[] {
  if (!root) return [];
  const lines: string[] = [];
  let current = "";
  const flush = () => {
    const t = clean(current);
    if (t) lines.push(t);
    current = "";
  };
  const walk = (node: Node) => {
    if (node.nodeType === 3) {
      current += node.textContent ?? "";
      return;
    }
    if (node.nodeType !== 1) return;
    const el = node as Element;
    const tag = el.tagName.toUpperCase();
    if (SKIP.has(tag) || (skipChrome && CHROME.has(tag))) return;
    if (el.hasAttribute("hidden") || el.getAttribute("aria-hidden") === "true") return;
    if (/display:\s*none/i.test(el.getAttribute("style") ?? "")) return;
    const block = BLOCK.has(tag);
    if (block) flush();
    for (const child of Array.from(el.childNodes)) walk(child);
    if (block) flush();
  };
  walk(root);
  flush();
  return lines;
}

/** "£1,299.99" → 1299.99, "24.99" → 24.99, 24.99 → 24.99. Returns null if there's no number. */
export function parsePrice(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const m = v.replace(/ /g, " ").match(/(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?/);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, "") + (m[2] ? `.${m[2]}` : ""));
  return Number.isFinite(n) ? n : null;
}

export function meta(doc: Document, ...names: string[]): string | null {
  for (const n of names) {
    const el = doc.querySelector(`meta[property="${n}"], meta[name="${n}"], meta[itemprop="${n}"]`);
    const v = clean(el?.getAttribute("content"));
    if (v) return v;
  }
  return null;
}

/** Canonical URL if it's on the same site, else the page URL without query and hash (they can carry session IDs). */
export function canonicalUrl(doc: Document, url: URL): string {
  const href = doc.querySelector('link[rel="canonical"]')?.getAttribute("href");
  if (href) {
    try {
      const c = new URL(href, url);
      if (c.hostname === url.hostname) return c.toString();
    } catch {
      /* ignore */
    }
  }
  return url.origin + url.pathname;
}

export function uniq<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}
