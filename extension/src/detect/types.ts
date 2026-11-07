import type { AnalyseBody } from "../config";

export type PurchaseType = "product" | "subscription" | "contract";
export type LinkKind =
  | "terms" | "returns" | "warranty" | "cancel" | "subscription"
  | "contract_summary" | "price_guide" | "privacy" | "other";

export interface DetectedLink {
  url: string;
  text: string;
  kind: LinkKind;
}

/** What `detectPurchase` returns. `checkout` is independent of whether a purchase was recognised. */
export type Detection =
  | { status: "purchase"; detector: DetectorName; checkout: boolean; request: AnalyseBody }
  | { status: "none"; checkout: boolean };

export type DetectorName = "amazon" | "jsonld" | "wording";

export type Item = AnalyseBody["item"];

/** What a detector recognises. The shared steps (links, snippets, signals) are added afterwards. */
export interface DetectorHit {
  item: Item;
  signals: PurchaseType[];
  /** Root(s) whose text is relevant for wording signals and snippets. Defaults to the whole page. */
  textRoots?: Element[];
  /** Extra snippets the detector picked out (e.g. Amazon feature bullets). */
  snippets?: string[];
}

export interface PageContext {
  url: URL;
  doc: Document;
}
