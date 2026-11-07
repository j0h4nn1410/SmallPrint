// Loads dist/ as an unpacked extension in a fresh Chromium profile and checks, against a running backend:
//  - install opens the first-run form (horizon + record kinds only); Skip gives a working panel
//  - the /analyse request carries the install UUID as X-Install-Id and nothing else about the user
//  - the content script detects purchases on saved pages (served at their real URLs via request
//    interception, no network), checkout pages light the badge, and the panel analyses the detected request
//  - cards appear one at a time and the spinner goes away
//  - the Settings link reopens the form
//  - an unreachable server shows an error instead of spinning forever
//   npm run build && npm run e2e            (backend on http://localhost:8000)
//   SERVER_URL=https://... npm run e2e
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// CommonJS require so a globally installed playwright (NODE_PATH) works too.
const { chromium } = createRequire(import.meta.url)("playwright");

const dist = resolve(import.meta.dirname, "../dist");
const server = process.env.SERVER_URL ?? "http://localhost:8000";
const shots = process.env.SHOTS_DIR;
const pagesDir = resolve(import.meta.dirname, "../../fixtures/pages");
const PAGES = {
  product: ["amazon-product", "https://www.amazon.co.uk/SodaStream-Terra-Sparkling-Water-Maker/dp/B09ABC1234"],
  checkout: ["checkout", "https://www.fernline.co.uk/checkout/review"],
  article: ["no-purchase-article", "https://www.themoneycolumn.co.uk/2026/10/are-subscriptions-worth-it"],
};

const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "sp-e2e-")), {
  headless: true,
  channel: "chromium", // new headless mode; the old one cannot load extensions
  args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`],
  viewport: { width: 400, height: 900 },
});
// Serve the saved pages at their real URLs.
for (const [file, url] of Object.values(PAGES)) {
  await ctx.route(url, (route) => route.fulfill({ contentType: "text/html", body: readFileSync(`${pagesDir}/${file}.html`, "utf8") }));
}
let failed = false;
const check = (ok, msg) => { console.log(`${ok ? "PASS" : "FAIL"} ${msg}`); if (!ok) failed = true; };

try {
  const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent("serviceworker"));
  const id = new URL(sw.url()).host;
  const behavior = await sw.evaluate(() => chrome.sidePanel.getPanelBehavior());
  check(behavior.openPanelOnActionClick === true, "toolbar click opens the side panel");

  // First run: installing opens the setup tab.
  // The tab can exist before its URL is set, so poll rather than wait for a "page" event.
  let setup;
  for (const t = Date.now(); !setup && Date.now() - t < 10000; await new Promise((r) => setTimeout(r, 100))) {
    setup = ctx.pages().find((p) => p.url().includes("options.html"));
  }
  if (!setup) throw new Error("first-run tab did not open on install");
  await setup.waitForLoadState();
  await setup.getByText("Skip (use defaults)").waitFor();
  const legends = await setup.locator("legend").allTextContents();
  check(legends.length === 2 && !/postcode/i.test(legends.join()), `first-run form asks only for: ${legends.join(" / ")}`);
  if (shots) await setup.screenshot({ path: join(shots, "firstrun.png") });
  await setup.getByText("Skip (use defaults)").click();
  await setup.getByTestId("setup-saved").waitFor();
  const stored = await setup.evaluate(() => chrome.storage.local.get(null));
  check(stored.smallprint_settings?.horizon === 12 && stored.smallprint_settings?.recordKinds?.length === 5 && stored.setup_done === true,
    "Skip stores 12 months + every record kind in chrome.storage.local");
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  check(UUID_RE.test(stored.install_id ?? ""), `install UUID generated (${stored.install_id})`);

  // Visit a saved page; return its tab id once the content script has reported.
  const visit = async (key) => {
    const tab = await ctx.newPage();
    await tab.goto(PAGES[key][1]);
    let tabId;
    for (const t = Date.now(); Date.now() - t < 10000 && tabId === undefined; await new Promise((r) => setTimeout(r, 100))) {
      // The extension has no "tabs" permission, so find the tab by its stored detection, not tabs.query({url}).
      tabId = await sw.evaluate(async (url) => {
        const all = await chrome.storage.session.get(null);
        const hit = Object.entries(all).find(([k, v]) => k.startsWith("detection:") && v.url === url);
        return hit ? Number(hit[0].split(":")[1]) : undefined;
      }, PAGES[key][1]);
    }
    if (tabId === undefined) throw new Error(`no detection reported for ${key}`);
    const badge = await sw.evaluate((tabId) => chrome.action.getBadgeText({ tabId }), tabId);
    const detection = await sw.evaluate((k) => chrome.storage.session.get(k).then((r) => r[k].detection), `detection:${tabId}`);
    return { tab, tabId, badge, detection };
  };

  const product = await visit("product");
  check(product.detection.status === "purchase" && product.detection.detector === "amazon" && product.badge === "",
    `Amazon product page detected by the ${product.detection.detector} adapter, no badge`);
  const checkout = await visit("checkout");
  check(checkout.detection.checkout === true && checkout.badge === "£", `checkout page lights the badge ("${checkout.badge}")`);
  const article = await visit("article");
  check(article.detection.status === "none" && article.badge === "", "article page: no purchase, no badge");

  // The side panel page, pinned to a tab (in real use it follows the active tab).
  const open = async (url, tabId = product.tabId) => {
    const page = await ctx.newPage();
    await page.goto(`chrome-extension://${id}/sidepanel.html?tabId=${tabId}`);
    await page.evaluate((u) => chrome.storage.local.set({ smallprint_server_url: u }), url);
    await page.reload();
    return page;
  };

  // Network trace: record every request the panel makes from here on.
  const trace = [];
  ctx.on("request", (r) => { if (r.url().startsWith(server)) trace.push(r); });

  // Happy path
  const page = await open(server);
  const t0 = Date.now();
  const seen = [];
  await page.waitForFunction(() => document.querySelectorAll(".cards > .card, .cards > section").length > 0, null, { timeout: 15000 });
  while (Date.now() - t0 < 15000) {
    const n = await page.locator(".cards > *").count();
    if (n > seen.length) seen.push({ n, ms: Date.now() - t0 });
    if (shots && n === 2 && !seen.shot) { seen.shot = true; await page.screenshot({ path: join(shots, "streaming.png") }); }
    if ((await page.getByTestId("progress").count()) === 0) break;
    await page.waitForTimeout(50);
  }
  const final = await page.locator(".cards > *").count();
  const titles = await page.locator(".card__title").allTextContents();
  console.log("  arrivals:", seen.map((s) => `${s.n}@${s.ms}ms`).join(" "), "| titles:", titles.join(", "));
  check(final === 6, `six cards rendered (got ${final})`);
  check(seen.length >= 4, `cards arrived incrementally (${seen.length} distinct steps)`);
  check((await page.getByTestId("progress").count()) === 0, "spinner gone after done");
  check((await page.getByRole("alert").count()) === 0, "no error banner");
  if (shots) await page.screenshot({ path: join(shots, "done.png"), fullPage: true });

  // What actually left the browser.
  const analyse = trace.filter((r) => r.url().endsWith("/analyse") && r.method() === "POST");
  check(analyse.length >= 1, `captured ${analyse.length} POST /analyse request(s)`);
  const STANDARD = new Set(["accept", "content-type", "user-agent", "origin", "referer", "sec-ch-ua", "sec-ch-ua-mobile",
    "sec-ch-ua-platform", "sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest", "sec-fetch-storage-access", "accept-encoding",
    "accept-language", "content-length", "connection", "host"]);
  for (const r of analyse) {
    const headers = await r.allHeaders();
    const custom = Object.keys(headers).filter((h) => !STANDARD.has(h));
    console.log("  headers sent:", JSON.stringify(headers));
    check(JSON.stringify(custom) === JSON.stringify(["x-install-id"]) && headers["x-install-id"] === stored.install_id,
      `only non-standard header is X-Install-Id = the stored UUID (custom: ${custom.join(", ")})`);
    check(!("cookie" in headers) && !("referer" in headers), "no cookie or referer sent");
    const body = r.postDataJSON();
    check(Object.keys(body).sort().join() === "item,links,page_text_snippets,price_drift,purchase_type_signals" &&
      !/install_id|postcode|horizon|recordKinds|political_donations/.test(JSON.stringify(body)),
      `body is page data only (keys: ${Object.keys(body).join(", ")})`);
    check(body.item.id === "B09ABC1234" && body.item.name.startsWith("SodaStream Terra"), `body carries the detected item (${body.item.name})`);
    // The saved Amazon page greets "Sweta" and shows her postcode in the header; none of it may leave.
    check(!/Sweta|EH1/.test(JSON.stringify(body)), "no personal details from the page in the body");
  }

  // Settings link reopens the form, prefilled; saving 24 months returns to the cards.
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByTestId("settings-form").waitFor();
  check(await page.getByText("Settings", { exact: true }).count() > 0, "Settings link reopens the form");
  await page.getByRole("button", { name: "24 months" }).click();
  await page.getByText("Save and start").click();
  await page.locator(".card__title").first().waitFor();
  const horizon = await page.evaluate(() => chrome.storage.local.get("smallprint_settings").then((r) => r.smallprint_settings.horizon));
  check(horizon === 24, "changed horizon saved to chrome.storage.local");

  // A page with no purchase: the panel says so and offers the demo.
  const none = await open(server, article.tabId);
  await none.getByTestId("no-purchase").waitFor({ timeout: 10000 });
  check((await none.getByTestId("progress").count()) === 0, "no-purchase page: 'No purchase detected', no spinner");
  if (shots) await none.screenshot({ path: join(shots, "no-purchase.png") });
  await none.getByText("Try the demo purchase").click();
  await none.locator(".card__title").first().waitFor({ timeout: 10000 });
  check(true, "demo button runs the canned request");

  // Unreachable server
  const bad = await open("http://127.0.0.1:9");
  await bad.getByRole("alert").waitFor({ timeout: 15000 });
  check((await bad.getByTestId("progress").count()) === 0, `unreachable server → error, no spinner ("${(await bad.getByRole("alert").innerText()).split("\n")[0]}")`);
  if (shots) await bad.screenshot({ path: join(shots, "error.png") });
} finally {
  await ctx.close();
}
process.exit(failed ? 1 : 0);
