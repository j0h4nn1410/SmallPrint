# ADR 0004: "In the news" company records

**Date:** 2026-11-08
**Status:** Proposed
**Extends:** ADR 0002 (ethics records), ADR 0003 (company deep search)

## Context

The LGBTQ+ and abortion-rights rows have no date and no source URL, so they can't be
shown (the response schema requires both). More generally the company card only knows
what is in the bundled datasets. Asking an LLM to "find what this company did" would
drift: it would pick its own sources, mix opinion with reporting and paraphrase.

## Decision

Add a `news` record kind, filled live by `smallprint/news.py`, where everything that
decides *what counts* is fixed in code and the model only copies sentences:

- **Fixed outlets.** One Tavily news search restricted to `NEWS_SITES` (BBC, The
  Guardian, Reuters, AP, NBC News, The New York Times, Financial Times, Sky News).
  Every result is checked against the list again, including look-alike hosts.
- **No opinion pages.** URLs under opinion, comment(isfree), editorial, letters,
  blogs, columnists, analysis, live, video and podcast paths are dropped.
- **Verbatim only.** The model returns sentences; each is kept only if it appears
  verbatim in the article (`verify_quote`, the S1 rule), names the company as whole
  words, and is 40–400 characters. One sentence per article, at most 3 records.
- **The article's own date.** From the search result, else from the URL
  (`/2024/03/14/`, `/2024/mar/14/`). No date, no record.
- **No words of ours.** `summary` is the quote in quotation marks plus the outlet's
  name; `source_url` is the article. The panel labels it "In the news" and adds:
  *"Quoted from the article. This is what the outlet reported, not SmallPrint's
  opinion, and SmallPrint has not checked the claims."*
- **Only for an identified company** (a CH number or a known owner), so news about a
  same-named company is not attached to an unresolved brand.

Runs in the pipeline after the company lookup, capped at 15 s, charged to the install's
daily LLM limit (top 3,000 tokens of at most 4 articles, gpt-4o-mini). Results are
cached per company in-process for 7 days; failed searches and spend-limit hits are not
cached. On by default when `OPENAI_API_KEY` and `TAVILY_API_KEY` are set;
`SMALLPRINT_NEWS=0` turns it off. No schema change: news records use the existing
`{kind, summary, date, source_url}` shape.

## Consequences

- Paywalled outlets (NYT, FT) often return only the opening of an article; quotes
  outside it can't be verified and are dropped. That fails safe.
- Search finds what it finds: no news is not evidence of nothing.
- The quoted sentence may contain words like "illegal" or "guilty" when the outlet
  reports a court finding. They are the outlet's words, attributed and disclaimed;
  the "no verdict words" rule applies to text SmallPrint writes.
- The company card can take up to ~15 s longer for an identified company when news is on.
- The undated LGBTQ+ and abortion-rights rows are still hidden; news is a separate,
  clearly labelled kind, not a backfill for them.
