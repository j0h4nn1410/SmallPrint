/**
 * Content script: runs detectPurchase on the page and reports the result to the service worker.
 * Read-only: it never clicks, fills in or changes anything. Nothing is sent off-device from here;
 * the request only reaches the backend when the user opens the side panel.
 */
import { detectPurchase } from "./detect";
import type { DetectionMessage } from "./messages";

let last = "";

function report() {
  const detection = detectPurchase(location.href, document);
  const key = JSON.stringify(detection);
  if (key === last) return;
  last = key;
  const msg: DetectionMessage = { type: "smallprint:detection", url: location.href, detection };
  chrome.runtime.sendMessage(msg).catch(() => {
    /* extension reloaded or service worker asleep; the next change re-sends */
  });
}

report();

// Single-page shops change product or step without a page load: re-check after the DOM settles.
let timer: ReturnType<typeof setTimeout> | undefined;
new MutationObserver(() => {
  clearTimeout(timer);
  timer = setTimeout(report, 1000);
}).observe(document.documentElement, { childList: true, subtree: true, characterData: true });
addEventListener("popstate", () => setTimeout(report, 300));
