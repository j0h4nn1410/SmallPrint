import { useEffect, useState } from "preact/hooks";
import { tabKey, type StoredDetection } from "../messages";

/**
 * The content script's latest detection for the active tab, kept up to date as the
 * user switches tabs or the page changes. `undefined` while loading, `null` if the
 * page hasn't reported (e.g. chrome:// pages or a tab opened before install).
 */
export function useActiveDetection(): StoredDetection | null | undefined {
  const [tabId, setTabId] = useState<number | null>(null);
  const [value, setValue] = useState<StoredDetection | null | undefined>(undefined);

  useEffect(() => {
    // Tests open sidepanel.html as a tab; ?tabId= pins it to the page under test.
    const pinned = Number(new URLSearchParams(location.search).get("tabId"));
    if (pinned) return setTabId(pinned);
    const refreshTab = () =>
      chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => setTabId(tab?.id ?? -1)).catch(() => setTabId(-1));
    refreshTab();
    const onActivated = () => refreshTab();
    chrome.tabs.onActivated.addListener(onActivated);
    chrome.windows?.onFocusChanged?.addListener(onActivated);
    return () => {
      chrome.tabs.onActivated.removeListener(onActivated);
      chrome.windows?.onFocusChanged?.removeListener(onActivated);
    };
  }, []);

  useEffect(() => {
    if (tabId === null) return;
    if (tabId < 0) return setValue(null);
    const key = tabKey(tabId);
    chrome.storage.session.get(key).then((r) => setValue((r[key] as StoredDetection | undefined) ?? null)).catch(() => setValue(null));
    const onChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === "session" && key in changes) setValue((changes[key].newValue as StoredDetection | undefined) ?? null);
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => chrome.storage.onChanged.removeListener(onChanged);
  }, [tabId]);

  return value;
}
