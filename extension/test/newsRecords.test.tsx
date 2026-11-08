// @vitest-environment happy-dom
/**
 * ADR 0004: "In the news" records carry the outlet's quote and a note that it is the
 * outlet's report, not SmallPrint's opinion. Other records are unchanged.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/preact";
import { CompanyCard, KIND_LABELS, NEWS_DISCLAIMER } from "~panel/components/CompanyCard";
import type { Company } from "~panel/types";
import { DEFAULT_SETTINGS } from "~panel/types";

afterEach(cleanup);

const COMPANY: Company = {
  brand: "Microsoft",
  parent: "Microsoft Corporation",
  ch_number: "01624297",
  match_via: "Wikidata",
  records: [
    { kind: "news", date: "2025-05-05", source_url: "https://www.reuters.com/technology/x",
      summary: "“Microsoft was fined $20m by the US Federal Trade Commission.” (Reuters)" },
    { kind: "gender_pay_gap", date: "2026-04-03", source_url: "https://gpg.example/",
      summary: "Mean gender pay gap of 6.4% in favour of men." },
  ],
};

describe("news records", () => {
  it("are labelled, quoted, linked and carry the disclaimer", () => {
    render(<CompanyCard company={COMPANY} state="found" flaggedKinds={DEFAULT_SETTINGS.recordKinds} />);
    const news = screen.getAllByTestId("record").find((el) => el.getAttribute("data-kind") === "news")!;
    expect(news.textContent).toContain(KIND_LABELS.news);
    expect(news.textContent).toContain("(Reuters)");
    expect(news.textContent).toContain("5 May 2025");
    expect(news.querySelector("a")?.getAttribute("href")).toBe("https://www.reuters.com/technology/x");
    expect(screen.getByTestId("news-disclaimer").textContent).toBe(NEWS_DISCLAIMER);
    expect(NEWS_DISCLAIMER).toMatch(/not SmallPrint's opinion/);
  });

  it("only news records get the disclaimer", () => {
    render(<CompanyCard company={COMPANY} state="found" flaggedKinds={DEFAULT_SETTINGS.recordKinds} />);
    expect(screen.getAllByTestId("news-disclaimer")).toHaveLength(1);
  });

  it("are shown first by default", () => {
    expect(DEFAULT_SETTINGS.recordKinds).toContain("news");
  });
});
