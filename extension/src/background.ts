import { getInstallId } from "./install";
import { tabKey, type DetectionMessage, type StoredDetection } from "./messages";

// Clicking the toolbar icon opens the side panel.
const openOnClick = () => chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);
openOnClick(); // onInstalled doesn't fire on every service-worker start

chrome.runtime.onInstalled.addListener(({ reason }) => {
  openOnClick();
  getInstallId().catch(console.error);
  // A side panel can only be opened from a user gesture, so first-run setup opens as a tab.
  if (reason === chrome.runtime.OnInstalledReason.INSTALL) chrome.runtime.openOptionsPage();
});

/** Checkout pages light up the badge for that tab. */
async function setBadge(tabId: number, checkout: boolean) {
  await chrome.action.setBadgeText({ tabId, text: checkout ? "£" : "" });
  if (checkout) {
    await chrome.action.setBadgeBackgroundColor({ tabId, color: "#d97706" });
    await chrome.action.setTitle({ tabId, title: "SmallPrint: checkout page. Open to see the real cost and small print." });
  } else {
    await chrome.action.setTitle({ tabId, title: "Open SmallPrint" });
  }
}

chrome.runtime.onMessage.addListener((msg: DetectionMessage, sender) => {
  const tabId = sender.tab?.id;
  if (msg?.type !== "smallprint:detection" || tabId === undefined || sender.id !== chrome.runtime.id) return;
  if (sender.frameId !== 0) return; // top frame only
  const stored: StoredDetection = { url: msg.url, detection: msg.detection };
  chrome.storage.session.set({ [tabKey(tabId)]: stored }).catch(console.error);
  setBadge(tabId, msg.detection.checkout).catch(console.error);
});

// A new page load starts clean, so stale results never show (e.g. on pages the content script can't run in).
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status !== "loading" || !info.url) return;
  chrome.storage.session.remove(tabKey(tabId)).catch(() => {});
  setBadge(tabId, false).catch(() => {});
});
chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove(tabKey(tabId)).catch(() => {});
});
