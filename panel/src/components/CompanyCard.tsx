import { useState } from "preact/hooks";
import { CardShell } from "./CardShell";
import type { Company, CompanyRecord, CardState } from "../types";

type FlagState = "idle" | "open" | "submitting" | "done" | "error";

interface Props {
  company: Company;
  state: CardState;
  /** Record kinds the user ticked in settings ("values filter"). Settings IDs or record kinds. */
  flaggedKinds: string[];
  /** Called when the user submits a wrong-match report. Returns true on success. */
  onFlag?: (correction?: string) => Promise<boolean>;
}

/**
 * Neutral names for each record kind. Evidence, not verdicts: no score, no good/bad labels,
 * no verdict words. A record says what was recorded, when, and where it comes from.
 */
export const KIND_LABELS: Record<string, string> = {
  donation: "Political donation",
  gender_pay_gap: "Gender pay gap report",
  modern_slavery: "Modern slavery statement",
  asa_ruling: "ASA ruling",
  regulator_decision: "Regulator decision",
  nmw_underpayment: "Minimum wage underpayment",
  prompt_payment: "Payment practices report",
  lgbtq_rights: "LGBTQ+ rights",
  abortion_rights: "Abortion rights",
  climate: "Climate targets",
  news: "In the news",
};

/** Shown under every news record: the words are the outlet's, not ours. */
export const NEWS_DISCLAIMER =
  "Quoted from the article. This is what the outlet reported, not SmallPrint's opinion, and SmallPrint has not checked the claims.";

/** Settings IDs that differ from the record kind they mean. */
const SETTING_TO_KIND: Record<string, string> = {
  political_donations: "donation",
  regulator_decisions: "regulator_decision",
};

/** The record kinds the user asked to see first. */
export function flaggedRecordKinds(settingKinds: readonly string[]): Set<string> {
  return new Set(settingKinds.map((k) => SETTING_TO_KIND[k] ?? k));
}

const byDateDesc = (a: CompanyRecord, b: CompanyRecord) => (b.date ?? "").localeCompare(a.date ?? "");

/** "2023-04-05" → "5 April 2023"; anything else is shown as given. */
export function formatDate(iso: string): string {
  const m = iso?.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return iso;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
}

function Record({ r, flagged }: { r: CompanyRecord; flagged: boolean }) {
  return (
    <li class={flagged ? "record-item record-item--tracked" : "record-item"} data-testid="record" data-kind={r.kind}>
      <span class="record-kind">{KIND_LABELS[r.kind] ?? r.kind.replace(/_/g, " ")}</span>
      <span class="record-date">{formatDate(r.date)}</span>
      <p class="record-summary">{r.summary}</p>
      {r.kind === "news" && <p class="muted record-disclaimer" data-testid="news-disclaimer">{NEWS_DISCLAIMER}</p>}
      {r.source_url ? (
        <a href={r.source_url} class="source-link" target="_blank" rel="noopener noreferrer">Source ↗</a>
      ) : (
        <span class="muted">Source link not available</span>
      )}
    </li>
  );
}

const NoRecords = () => <p class="muted" data-testid="no-records">No public records matched.</p>;

export function CompanyCard({ company, state, flaggedKinds, onFlag }: Props) {
  const [showAll, setShowAll] = useState(false);
  const [flagState, setFlagState] = useState<FlagState>("idle");
  const [correction, setCorrection] = useState("");

  async function handleFlag() {
    if (!onFlag) return;
    setFlagState("submitting");
    const ok = await onFlag(correction.trim() || undefined);
    setFlagState(ok ? "done" : "error");
  }

  if (state === "n_a") {
    return <CardShell title="Who's behind it" state="n_a"><p class="muted">Company information doesn't apply to this page.</p></CardShell>;
  }
  if (state === "not_found") {
    return (
      <CardShell title="Who's behind it" state="not_found">
        {company?.brand && <p><strong>{company.brand}</strong></p>}
        <NoRecords />
      </CardShell>
    );
  }

  const tracked = flaggedRecordKinds(flaggedKinds);
  const records = [...(company.records ?? [])].sort(byDateDesc);
  // Values filter: the kinds the user ticked come first, newest first; the rest are one tap away.
  const top = records.filter((r) => tracked.has(r.kind));
  const rest = records.filter((r) => !tracked.has(r.kind));

  return (
    <CardShell title="Who's behind it" state={state}>
      {company.brand && <p class="company__brand"><strong>{company.brand}</strong></p>}
      {company.parent && company.parent !== company.brand && (
        <p class="company__meta">Parent company: {company.parent}</p>
      )}
      {(company.match_via || company.ch_number) && (
        <p class="company__match-via" data-testid="match-via">
          Matched by: {company.match_via ?? "Companies House number"}
          {company.ch_number && <> · Companies House {company.ch_number}</>}
        </p>
      )}

      {/* Wrong-match flag — only shown when a match was made and a handler is wired up */}
      {onFlag && (company.match_via || company.ch_number) && (
        <div class="company__flag" data-testid="company-flag">
          {flagState === "idle" && (
            <button type="button" class="company__flag-trigger" onClick={() => setFlagState("open")}>
              Wrong match?
            </button>
          )}
          {flagState === "open" && (
            <div class="company__flag-form">
              {company.parent && (
                <p class="company__flag-prompt">
                  Is <strong>{company.parent}</strong> the wrong parent for <strong>{company.brand}</strong>?
                </p>
              )}
              <input
                type="text"
                class="text-input"
                placeholder="Correct parent company (optional)"
                value={correction}
                maxLength={200}
                onInput={(e) => setCorrection((e.target as HTMLInputElement).value)}
              />
              <div class="company__flag-actions">
                <button type="button" class="btn btn--primary" onClick={handleFlag}>Flag this match</button>
                <button type="button" class="btn btn--ghost" onClick={() => setFlagState("idle")}>Cancel</button>
              </div>
            </div>
          )}
          {flagState === "submitting" && <span class="muted">Sending…</span>}
          {flagState === "done" && (
            <span class="company__flag-done" data-testid="flag-done">✓ Flagged — we'll review this match.</span>
          )}
          {flagState === "error" && (
            <span class="company__flag-error">
              Couldn't send.{" "}
              <button type="button" class="company__flag-trigger" onClick={handleFlag}>Retry</button>
            </span>
          )}
        </div>
      )}

      {records.length === 0 ? (
        <NoRecords />
      ) : (
        <div class="company__records">
          {top.length > 0 && (
            <>
              <p class="records-heading">Records you chose to see first</p>
              <ul class="records-list">
                {top.map((r, i) => <Record key={`t${i}`} r={r} flagged />)}
              </ul>
            </>
          )}
          {top.length === 0 && rest.length > 0 && (
            <p class="muted">None of the records are of the kinds you chose to see first.</p>
          )}
          {rest.length > 0 && (
            <div class="records-others">
              <button type="button" class="show-all-btn" aria-expanded={showAll} onClick={() => setShowAll((v) => !v)}>
                {showAll ? "Hide other records" : `Show ${rest.length} other record${rest.length === 1 ? "" : "s"}`}
              </button>
              {showAll && (
                <ul class="records-list">
                  {rest.map((r, i) => <Record key={`o${i}`} r={r} flagged={false} />)}
                </ul>
              )}
            </div>
          )}
        </div>
      )}
    </CardShell>
  );
}
