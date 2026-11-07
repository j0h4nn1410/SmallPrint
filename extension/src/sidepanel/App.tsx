import { Component } from "preact";
import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { AnalyseResult, CardName, Settings, StreamCard } from "~panel/types";
import { DEFAULT_SETTINGS } from "~panel/types";
import { ItemCard } from "~panel/components/ItemCard";
import { CostCard } from "~panel/components/CostCard";
import { PriceDriftCard } from "~panel/components/PriceDriftCard";
import { LockInCard } from "~panel/components/LockInCard";
import { SmallPrintCard } from "~panel/components/SmallPrintCard";
import { CompanyCard } from "~panel/components/CompanyCard";
import { FirstRunForm } from "~panel/components/FirstRunForm";
import { CANNED_REQUEST, DEFAULT_SERVER_URL, TIMEOUTS, type AnalyseBody } from "../config";
import { useActiveDetection } from "./activeDetection";
import { streamAnalyse } from "../sse";
import { getInstallId } from "../install";
import { completeSetup, isSetupDone, loadSettings, onSettingsChanged } from "../settings";
import { loadServerUrl, saveServerUrl } from "./serverUrl";

const TOTAL_CARDS = 6;

type Status = "streaming" | "done" | "error";

class CardErrorBoundary extends Component<{ name: string; children: ComponentChildren }, { caught: boolean }> {
  state = { caught: false };
  componentDidCatch(err: unknown) {
    console.error(`[smallprint] ${this.props.name} card failed to render`, err);
    this.setState({ caught: true });
  }
  render() {
    return this.state.caught
      ? <div class="card card--error"><p>Couldn't show this card ({this.props.name})</p></div>
      : <>{this.props.children}</>;
  }
}

function renderCard(c: StreamCard, settings: Settings, purchaseTypes: string[]) {
  const p = c.payload as never;
  switch (c.card as CardName) {
    case "item":
      return <ItemCard item={p as Partial<AnalyseResult["item"]>} state={c.state} purchaseTypes={purchaseTypes} />;
    case "cost":
      return <CostCard costStreams={(c.payload as { cost_streams?: AnalyseResult["cost_streams"] }).cost_streams ?? []} state={c.state} horizon={settings.horizon} />;
    case "price_drift":
      return <PriceDriftCard priceDrift={p} state={c.state} />;
    case "lock_in":
      return <LockInCard lockIn={p} state={c.state} />;
    case "small_print":
      return <SmallPrintCard items={Array.isArray(c.payload) ? (c.payload as AnalyseResult["small_print"]) : []} state={c.state} />;
    case "company":
      return <CompanyCard company={p} state={c.state} flaggedKinds={settings.recordKinds} />;
  }
}

export function App() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [serverUrl, setServerUrl] = useState<string | null>(null);
  // null = still loading. false = first run not done yet → show the form instead of the cards.
  const [setupDone, setSetupDone] = useState<boolean | null>(null);
  const [editingSettings, setEditingSettings] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [cards, setCards] = useState<StreamCard[]>([]);
  const [status, setStatus] = useState<Status>("streaming");
  const [error, setError] = useState<string | null>(null);
  const run = useRef<AbortController | null>(null);
  const [demo, setDemo] = useState(false);
  const active = useActiveDetection();

  // What to analyse: the active tab's detected purchase, or the canned request in demo mode.
  const request: AnalyseBody | null = demo
    ? CANNED_REQUEST
    : active?.detection.status === "purchase" ? active.detection.request : null;
  const requestKey = request ? JSON.stringify(request) : null;
  const noPurchasePage = !demo && active !== undefined && request === null;

  useEffect(() => {
    loadSettings().then(setSettings).catch(() => {});
    isSetupDone().then(setSetupDone).catch(() => setSetupDone(false));
    loadServerUrl(DEFAULT_SERVER_URL).then(setServerUrl);
    // Pick up changes made in the settings tab while the panel is open.
    const off = onSettingsChanged((s, done) => {
      setSettings(s);
      setSetupDone(done);
    });
    return () => {
      off();
      run.current?.abort();
    };
  }, []);

  // Analyse once setup is done, the server URL is known and there's something to analyse;
  // again whenever the page's purchase or the URL changes.
  useEffect(() => {
    if (serverUrl && setupDone && request) analyse(serverUrl, request);
    else if (!request) {
      run.current?.abort();
      run.current = null;
      setCards([]);
      setError(null);
      setStatus("done");
    }
  }, [serverUrl, setupDone, requestKey]);

  // Switching to another tab leaves demo mode.
  useEffect(() => setDemo(false), [active?.url]);

  const rerun = () => serverUrl && request && analyse(serverUrl, request);

  async function analyse(url: string, body: AnalyseBody) {
    run.current?.abort();
    const controller = new AbortController();
    run.current = controller;
    setCards([]);
    setError(null);
    setStatus("streaming");
    try {
      const installId = await getInstallId();
      for await (const card of streamAnalyse(url, body, { ...TIMEOUTS, installId, signal: controller.signal })) {
        if (controller.signal.aborted) return;
        // Replace a card if the server ever resends it, otherwise append in arrival order.
        setCards((prev) => [...prev.filter((c) => c.card !== card.card), card]);
      }
      if (run.current === controller) setStatus("done");
    } catch (err) {
      if (run.current !== controller) return; // superseded by a newer run
      setError(err instanceof Error ? err.message : String(err));
      setStatus("error");
    } finally {
      // Never leave the spinner up for a run that is still the current one.
      if (run.current === controller) setStatus((s) => (s === "streaming" ? "done" : s));
    }
  }

  function onSubmitServer(e: Event) {
    e.preventDefault();
    const input = (e.currentTarget as HTMLFormElement).elements.namedItem("server") as HTMLInputElement;
    const next = input.value.trim() || DEFAULT_SERVER_URL;
    saveServerUrl(next);
    setShowSettings(false);
    if (next === serverUrl) rerun();
    else setServerUrl(next);
  }

  async function onSettingsDone(s: Settings) {
    await completeSetup(s);
    setSettings(s);
    setEditingSettings(false);
    setSetupDone(true);
  }

  if (setupDone === null) return <div class="loading">Loading…</div>;
  if (!setupDone || editingSettings) {
    return (
      <div class="panel" data-testid="settings-form">
        {setupDone && (
          <header class="sp-header">
            <h1 class="sp-title">SmallPrint</h1>
            <button class="btn btn--ghost" onClick={() => setEditingSettings(false)}>Back</button>
          </header>
        )}
        <FirstRunForm
          askPostcode={false}
          initial={settings}
          title={setupDone ? "Settings" : "Set up SmallPrint"}
          onComplete={onSettingsDone}
        />
      </div>
    );
  }

  const noPurchase = cards.find((c) => c.card === "item")?.state === "n_a";
  const visible = noPurchase ? cards.filter((c) => c.card === "item") : cards;
  const purchaseTypes = request?.purchase_type_signals ?? [];

  return (
    <div class="panel">
      <header class="sp-header">
        <h1 class="sp-title">SmallPrint</h1>
        <div class="sp-actions">
          <button class="btn btn--ghost" onClick={() => setEditingSettings(true)}>Settings</button>
          <button class="btn btn--ghost" onClick={() => setShowSettings((v) => !v)} aria-expanded={showSettings}>Server</button>
          <button class="btn btn--primary" onClick={rerun} disabled={status === "streaming" || !serverUrl || !request}>
            Re-run
          </button>
        </div>
      </header>

      {showSettings && (
        <form class="sp-settings" onSubmit={onSubmitServer}>
          <label for="server">Server</label>
          <input id="server" name="server" class="text-input" type="url" defaultValue={serverUrl ?? ""} placeholder={DEFAULT_SERVER_URL} />
          <button class="btn btn--primary" type="submit">Save</button>
        </form>
      )}

      {status === "error" && (
        <div class="error-banner sp-error" role="alert">
          <span>{error}</span>
          <button class="btn btn--ghost" onClick={rerun}>Retry</button>
        </div>
      )}

      <div class="cards" aria-live="polite" aria-busy={status === "streaming"}>
        {visible.map((c) => (
          <CardErrorBoundary key={c.card} name={c.card}>
            {renderCard(c, settings, purchaseTypes)}
          </CardErrorBoundary>
        ))}
      </div>

      {status === "streaming" && (
        <div class="sp-progress" data-testid="progress">
          <span class="spinner" aria-hidden="true" />
          <span>{cards.length === 0 ? "Checking the small print…" : `Checking… ${cards.length} of ${TOTAL_CARDS}`}</span>
        </div>
      )}

      {noPurchasePage && (
        <div class="cards" data-testid="no-purchase">
          <ItemCard item={{}} state="n_a" purchaseTypes={[]} />
          <p class="sp-footnote">
            <button class="btn btn--ghost" onClick={() => setDemo(true)}>Try the demo purchase</button>
          </p>
        </div>
      )}
      {active === undefined && !demo && <div class="loading">Looking at this page…</div>}
      {request && status === "done" && cards.length === 0 && <p class="empty-state">No results came back for this page.</p>}
      {demo && <p class="sp-footnote">Demo: analysing a canned request ({CANNED_REQUEST.item.name ?? CANNED_REQUEST.item.url}).</p>}
    </div>
  );
}
