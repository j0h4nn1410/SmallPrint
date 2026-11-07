/**
 * Purchase detection over saved pages, in Node (linkedom), no browser.
 * Each fixtures/pages/<name>.html has a reviewed <name>.expected.json beside it.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseHTML } from "linkedom";
import { detectPurchase, type Detection } from "../src/detect";
import { classifyLink } from "../src/detect/links";
import { isCheckout } from "../src/detect/checkout";
import { RECURRING_PRICE, wordingSignals } from "../src/detect/wording";
import { parsePrice } from "../src/detect/text";
import { PAGE_URLS } from "./pages";

const PAGES = resolve(__dirname, "../../fixtures/pages");
const load = (name: string) => parseHTML(readFileSync(`${PAGES}/${name}.html`, "utf8")).document as unknown as Document;
const html = (body: string, head = "") =>
  parseHTML(`<!doctype html><html><head>${head}</head><body>${body}</body></html>`).document as unknown as Document;
const expected = (name: string) => JSON.parse(readFileSync(`${PAGES}/${name}.expected.json`, "utf8")) as { url: string; detection: Detection };
const run = (name: string) => detectPurchase(PAGE_URLS[name], load(name));

describe("saved pages produce the expected requests", () => {
  for (const name of Object.keys(PAGE_URLS)) {
    it(name, () => {
      const e = expected(name);
      expect(e.url).toBe(PAGE_URLS[name]);
      expect(run(name)).toEqual(e.detection);
    });
  }
});

describe("what each detector finds", () => {
  it("Amazon product: adapter wins, ASIN url, brand from byline, seller from buybox", () => {
    const d = run("amazon-product");
    expect(d).toMatchObject({ status: "purchase", detector: "amazon", checkout: false });
    if (d.status !== "purchase") return;
    expect(d.request.item).toEqual({
      name: "SodaStream Terra Sparkling Water Maker, Black", brand: "SodaStream", price: 89.99,
      seller: "Amazon", url: "https://www.amazon.co.uk/dp/B09ABC1234", id: "B09ABC1234",
    });
    // The Prime "subscription auto-renews" banner in the header must not make this a subscription.
    expect(d.request.purchase_type_signals).toEqual(["product"]);
    expect(d.request.links.map((l) => l.kind)).toEqual(["terms", "returns", "warranty", "privacy"]);
  });

  it("JSON-LD retailer: Product + Offer from @graph, broken block skipped, care-plan add-on ignored", () => {
    const d = run("jsonld-retailer");
    expect(d).toMatchObject({ status: "purchase", detector: "jsonld" });
    if (d.status !== "purchase") return;
    expect(d.request.item).toMatchObject({ name: "Ninja AF100UK Air Fryer, 3.8 L - Grey", brand: "Ninja", price: 99, seller: "Brightwell Electrical", id: "10215566" });
    expect(d.request.item.url).not.toMatch(/utm_|gclid/);
    expect(d.request.purchase_type_signals).toEqual(["product"]);
    expect(d.request.page_text_snippets.join("\n")).not.toMatch(/newsletter/i);
  });

  it("UK subscription: wording detector, recurring price, membership terms + cancel links", () => {
    const d = run("uk-subscription");
    expect(d).toMatchObject({ status: "purchase", detector: "wording", checkout: false });
    if (d.status !== "purchase") return;
    expect(d.request.item).toMatchObject({ name: "Join Northgate Gym", brand: "Northgate Gyms", price: 24.99 });
    expect(d.request.purchase_type_signals).toEqual(["subscription"]);
    expect(d.request.links.map((l) => l.kind)).toEqual(["terms", "subscription", "cancel", "privacy"]);
  });

  it("checkout: badge on, contract + subscription, contract summary found, no personal data", () => {
    const d = run("checkout");
    expect(d).toMatchObject({ status: "purchase", detector: "wording", checkout: true });
    if (d.status !== "purchase") return;
    expect(d.request.item).toMatchObject({ name: "Full Fibre 500", price: 29.99, url: "https://www.fernline.co.uk/checkout/review" });
    expect(d.request.purchase_type_signals).toEqual(["subscription", "contract"]);
    expect(d.request.links.find((l) => l.kind === "contract_summary")?.url).toMatch(/contract-summary-full-fibre-500\.pdf$/);
    const sent = JSON.stringify(d.request);
    for (const personal of ["Sweta", "Acharya", "High Street", "EH1", "sweta@example.com", "07700", "4242", "s3cr3t"]) {
      expect(sent).not.toContain(personal);
    }
  });

  it("no purchase: article about subscriptions, Amazon search, Amazon checkout", () => {
    expect(run("no-purchase-article")).toEqual({ status: "none", checkout: false });
    expect(run("amazon-search")).toEqual({ status: "none", checkout: false });
    // Checkout without product details still lights the badge.
    expect(run("amazon-checkout")).toEqual({ status: "none", checkout: true });
  });
});

describe("detector order and purity", () => {
  it("Amazon adapter beats JSON-LD on Amazon; JSON-LD beats wording elsewhere", () => {
    const ld = `<script type="application/ld+json">{"@type":"Product","name":"LD name","offers":{"price":"1.00"}}</script>`;
    const amazon = html(`<span id="productTitle">Adapter name</span><p>£5 a month subscription, cancel anytime</p>`, ld);
    expect(detectPurchase("https://www.amazon.co.uk/dp/B000000001", amazon)).toMatchObject({ detector: "amazon" });
    const shop = html(`<main><p>£5 a month subscription, cancel anytime</p></main>`, ld);
    const d = detectPurchase("https://shop.example/p/1", shop);
    expect(d).toMatchObject({ detector: "jsonld", request: { item: { name: "LD name" }, purchase_type_signals: ["product", "subscription"] } });
  });

  it("does not modify the document", () => {
    const doc = load("checkout");
    const before = doc.documentElement.outerHTML;
    detectPurchase(PAGE_URLS.checkout, doc);
    expect(doc.documentElement.outerHTML).toBe(before);
  });

  it("ignores non-web URLs and bad input", () => {
    expect(detectPurchase("chrome://extensions", html(""))).toEqual({ status: "none", checkout: false });
    expect(detectPurchase("not a url", html(""))).toEqual({ status: "none", checkout: false });
  });
});

describe("building blocks", () => {
  it("parsePrice", () => {
    expect(parsePrice("£1,299.99")).toBe(1299.99);
    expect(parsePrice("99.00")).toBe(99);
    expect(parsePrice(24.5)).toBe(24.5);
    expect(parsePrice("free")).toBeNull();
  });

  it("recurring price wording", () => {
    for (const s of ["£24.99 a month", "£29.99/month", "£5.99 per month", "£12 pcm", "£9.99 /mo"]) expect(s).toMatch(RECURRING_PRICE);
    for (const s of ["£24.99", "a month ago", "£24.99 a year"]) expect(s).not.toMatch(RECURRING_PRICE);
  });

  it("one 'subscribe' alone isn't a subscription; newsletter lines don't count", () => {
    expect(wordingSignals(["Subscribe to our newsletter", "Free trial for newsletter readers"]).signals).toEqual([]);
    expect(wordingSignals(["Start your free trial", "Cancel anytime"]).signals).toEqual(["subscription"]);
    expect(wordingSignals(["18-month contract"]).signals).toEqual(["contract"]);
  });

  it("classifies terms-type links", () => {
    expect(classifyLink("Contract summary", "/x")).toBe("contract_summary");
    expect(classifyLink("Subscription terms", "/x")).toBe("subscription");
    expect(classifyLink("Terms & Conditions", "/x")).toBe("terms");
    expect(classifyLink("T&Cs apply", "/x")).toBe("terms");
    expect(classifyLink("Read more", "/legal/terms-of-sale")).toBe("terms");
    expect(classifyLink("Returns & refunds", "/x")).toBe("returns");
    expect(classifyLink("Shop TVs", "/tvs")).toBeNull();
  });

  it("checkout detection", () => {
    expect(isCheckout(new URL("https://x.co.uk/checkout/delivery"), html(""))).toBe(true);
    expect(isCheckout(new URL("https://x.co.uk/basket"), html(""))).toBe(true);
    expect(isCheckout(new URL("https://x.co.uk/p/1"), html(`<button>Pay now</button>`))).toBe(true);
    expect(isCheckout(new URL("https://x.co.uk/p/1"), html(`<button>Buy now</button><button>Add to basket</button>`))).toBe(false);
    expect(isCheckout(new URL("https://x.co.uk/cartoons"), html(""))).toBe(false);
  });
});
