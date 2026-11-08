# ADR 0003: Company deep search

**Date:** 2026-11-08
**Status:** Proposed
**Extends:** ADR 0001 (CH join), ADR 0002 (ethics records name join)

## Context

On a brand's own site the company card often said "Owner not identified" and
"No public records matched" even though the records index held the company's
records. Example: microsoft.com had 8 Microsoft records in the index (2 gender pay
gap reports and a donation for MICROSOFT LIMITED 01624297, 3 SBTi climate rows for
"Microsoft Corporation", plus undated LGBTQ+/abortion rows), and the card showed none.

Causes, all in `smallprint/company`:

1. **A brand that is the company was dropped.** Wikidata matched Microsoft (Q2283)
   on its website, but it has no parent and no Companies House number, and the
   lookup discarded any match without one of those.
2. **Exact names never reach the UK company.** GLEIF and Companies House must
   match the brand's name word for word, so "Microsoft" never finds "MICROSOFT
   LIMITED". Wikidata and GLEIF don't link Microsoft to its UK company either.
3. **The ethics join is exact on the brand or parent.** Climate is filed under
   "Microsoft Corporation"; with no owner resolved, only "Microsoft" was tried.
4. **Exact-label search misses companies named after the brand plus more words**
   ("Apple Inc.", "Sky Group", "Spotify Technology").
5. ASA rulings were only fetched once a CH number was found.

## Decision

Add an opt-in `deep_search` flag to `company_lookup`. Off, behaviour is byte-for-byte
the same as before (all existing tests pass unchanged). The pipeline turns it on;
`SMALLPRINT_DEEP_SEARCH=0` turns it off.

With deep search on:

- **The brand can be its own owner.** When the matched Wikidata item has no parent and
  no UK number but is a legal entity (an LEI, or an official name ending in a legal
  form), it is shown as the owner under its official name ("Microsoft Corporation").
  Products ("iOS", "Apple TV") are not legal entities and are not used.
- **The page's own site.** When no exact-name item can be picked, an item whose label
  is the brand plus more words is taken only if it is a legal entity, its official
  website is the page's host (or a parent domain of it), and it is the only one.
- **The UK company named after the owner.** When the owner is known but has no UK
  number: a company whose name is exactly the owner's name plus a UK legal form,
  optionally with a UK qualifier ("MICROSOFT LIMITED", "APPLE (UK) LIMITED"), at
  Companies House (when a key is set) and then among the records index's CH-keyed
  companies. Exactly one must fit in a source, or none is used. Dissolved companies
  are skipped.
- **Name-keyed records** also match the owner's label and official name, and those
  names with the legal form ignored ("MICROSOFT CORP"). Every other word must match.
- **ASA rulings** are fetched for a known owner even without a UK number.

Still never done: walking the subsidiary graph (Wikidata P355, GLEIF children), fuzzy
or partial matching, or showing undated records (the response schema requires a date
and a source URL; the LGBTQ+ and abortion rows have neither).

## Consequences

- microsoft.com: Microsoft Corporation, 01624297, pay gap, donation, climate, ASA.
  apple.com → Apple Inc. / APPLE (UK) LIMITED; sky.com → Sky Group; amazon.co.uk →
  Amazon.com, Inc. with climate and ASA rulings; Tesco and Vodafone gain climate records.
- "Named after the owner" is a name rule, not proof of ownership. It is narrow
  (exact words plus a UK legal form, only after Wikidata settled the owner, unique
  match only) and `match_via` says "deep search" so the card is honest about it.
- Up to ~2 s more Wikidata time and one deep step capped at 5 s, inside the
  pipeline's 20 s company timeout.
- LGBTQ+ and abortion-rights rows remain hidden until the data loader gives them a
  date and source URL (a data fix, not a matcher fix).
