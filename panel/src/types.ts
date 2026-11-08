/** contracts/response.schema.json card_state. The four honest states, plus limit_reached: the
 * backend didn't look because the install's daily spend limit was used up (not "looked, nothing"). */
export type CardState = "found" | "estimated" | "not_found" | "n_a" | "limit_reached";

export interface Evidence {
  quote?: string | null;
  url?: string | null;
  fetched?: string | null;
  source_step?: string | null;
}

export interface CostStream {
  label: string;
  type: "one_off" | "recurring" | "usage" | "step_change";
  amount?: number;
  unit_price?: number;
  units_per_month?: { low: number; mid: number; high: number };
  from_month?: number;
  to_month?: number;
  month?: number;
  evidence: Evidence;
}

export interface LockIn {
  min_term_months?: number | null;
  exit_fee?: string | null;
  notice_days?: number | null;
  auto_renews?: boolean | null;
  cancel_method?: string | null;
  proprietary_refills?: boolean | null;
  evidence?: LockInEvidence[];
}

export type LockInField =
  | "min_term_months"
  | "exit_fee"
  | "notice_days"
  | "auto_renews"
  | "cancel_method"
  | "proprietary_refills";

export interface LockInEvidence {
  field: LockInField;
  quote: string;
  url: string;
  /** Set when the quote came from a fallback source, e.g. "tavily_search" (contracts/response.schema.json). */
  source_step?: string | null;
}

export interface SmallPrintItem {
  field: string;
  value?: string | null;
  quote?: string | null;
  url?: string | null;
  source_step?: string | null;
}

export interface CompanyRecord {
  kind: string;
  summary: string;
  date: string;
  source_url: string;
}

export interface Company {
  brand?: string | null;
  parent?: string | null;
  ch_number?: string | null;
  match_via?: string | null;
  records?: CompanyRecord[];
}

export interface PriceDriftAdded {
  label: string;
  amount: number;
}

export interface PriceDrift {
  first_seen?: number | null;
  at_checkout?: number | null;
  added?: PriceDriftAdded[];
}

export interface ItemInfo {
  name?: string | null;
  brand?: string | null;
  seller?: string | null;
  url?: string | null;
  id?: string | null;
}

export interface CardStates {
  cost: CardState;
  lock_in: CardState;
  small_print: CardState;
  company: CardState;
  price_drift: CardState;
}

export interface AnalyseResult {
  purchase_types: string[];
  item: ItemInfo;
  cost_streams: CostStream[];
  lock_in: LockIn;
  small_print: SmallPrintItem[];
  company: Company;
  price_drift: PriceDrift;
  card_states: CardStates;
}

export type CardName = "item" | "cost" | "lock_in" | "small_print" | "company" | "price_drift";

export interface StreamCard {
  card: CardName;
  state: CardState;
  payload: unknown;
}

export interface Settings {
  horizon: 12 | 24;
  recordKinds: string[];
}

export const DEFAULT_SETTINGS: Settings = {
  horizon: 12,
  recordKinds: ["donation", "gender_pay_gap", "modern_slavery", "asa_ruling", "climate", "news"],
};

export interface AnalyseRequest {
  item: {
    name?: string | null;
    brand?: string | null;
    price?: number | null;
    seller?: string | null;
    /** As the page states it, e.g. Amazon's "Manufacturer" row. Optional. */
    manufacturer?: string | null;
    url: string;
    id?: string | null;
  };
  purchase_type_signals: string[];
  links: { url: string; text: string; kind: string }[];
  page_text_snippets: string[];
  /** T&C pages and PDFs fetched in the browser. Optional; a failed fetch is sent with fetch_failed: true. */
  terms?: TermsDocument[];
  /** Deprecated: send the X-Install-Id header instead. */
  install_id?: string;
}

export type TermsKind =
  | "terms"
  | "returns"
  | "warranty"
  | "cancel"
  | "subscription"
  | "contract_summary"
  | "price_guide"
  | "privacy"
  | "other";

/** Mirrors terms_document in contracts/request.schema.json. */
export type TermsDocument =
  | { url: string; kind?: TermsKind; text: string; fetch_failed?: false }
  | { url: string; kind?: TermsKind; pdf_b64: string; fetch_failed?: false }
  | { url: string; kind?: TermsKind; fetch_failed: true; error?: string | null };
