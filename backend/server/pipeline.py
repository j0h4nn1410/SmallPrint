"""Real /analyse pipeline: run the lookups in parallel and stream each card as it resolves (S5, #18).

Sources, started together:
  * page   -> item and price_drift cards, straight from the request (well under 2 s)
  * terms  -> cost, lock_in and small_print cards, from the extractor (S3) under the
              per-install spend limit (S4), with a hard timeout so no spinner hangs.
              T&C pages the browser couldn't fetch are found with Tavily (S6) and
              every value from them is labelled source_step="tavily_search".
  * company -> company card. Until the company matcher (J5, #17) lands this is
              not_found: showing the mock company for a real page would be a wrong value.

Every card carries a state, a source that errors or times out still emits its cards
as not_found, and the stream always ends with `done`.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
from typing import AsyncGenerator, Awaitable, Callable

from openai import AsyncOpenAI

from smallprint.extract import Document, build_cards, extract_fields, html_to_text, pdf_b64_to_text
from smallprint.refill import find_refill
from smallprint.search_fallback import MAX_SEARCHES_PER_REQUEST, TavilySearch, site_of
from smallprint.spend import SpendTracker
from smallprint.tc_cache import TermsCache

from .models import AnalyseRequest

log = logging.getLogger(__name__)

# Extraction must stream within ~20 s (CLAUDE.md); give up a little after that.
TERMS_TIMEOUT_S = 25.0

# The company lookup is a chain of live calls (Wikidata, GLEIF, Companies House, ASA), each with
# its own timeout; together they could outlast the panel's 60 s cap. Target is 5 s; past this the
# card is not_found and the stream still ends with `done`.
COMPANY_TIMEOUT_S = 20.0

# The install id of scripts/prewarm.py. The server fetched those T&C pages itself, so their
# extraction may fill the per-site cache. main.analyse only accepts it with the pre-warm key.
PREWARM_INSTALL = "prewarm"


def refill_enabled() -> bool:
    """Refill cost (S8) is gated: off unless SMALLPRINT_REFILL=1, set only if the H10 gate passes."""
    return os.environ.get("SMALLPRINT_REFILL", "").strip().lower() in ("1", "true", "on", "yes")


def deep_search_enabled() -> bool:
    """Company deep search (ADR 0003): on unless SMALLPRINT_DEEP_SEARCH is 0/false/off/no."""
    return os.environ.get("SMALLPRINT_DEEP_SEARCH", "").strip().lower() not in ("0", "false", "off", "no")

Card = tuple[str, str, object]  # (card, state, payload)

TERMS_CARDS = ("cost", "lock_in", "small_print")
EMPTY_PAYLOAD: dict[str, object] = {
    "item": {},
    "price_drift": {"first_seen": None, "at_checkout": None, "added": []},
    "cost": {"cost_streams": []},
    "lock_in": {"evidence": []},
    "small_print": [],
    "company": {"brand": None, "parent": None, "ch_number": None, "match_via": None, "records": []},
}


def _not_found(cards: tuple[str, ...], state: str = "not_found") -> list[Card]:
    return [(c, state, EMPTY_PAYLOAD[c]) for c in cards]


def product_only(request: AnalyseRequest) -> bool:
    """A one-off product: no subscription or contract signal from the page.

    Lifetime cost and lock-in are for subscriptions and contracts. On a product page the
    extractor reads the price, a finance offer or an add-on policy as a "monthly fee" or a
    "notice period" (verbatim quotes, wrong meaning), so those cards don't apply there.
    Small print (returns window, warranty, seller) still does. No signals = unknown: keep all.
    """
    signals = set(request.purchase_type_signals)
    return "product" in signals and not signals & {"subscription", "contract"}


def _without_cost_and_lock_in(result: dict) -> dict:
    result["cost_streams"] = []
    result["lock_in"] = {**{k: None for k in result["lock_in"] if k != "evidence"}, "evidence": []}
    result["card_states"]["cost"] = "n_a"
    result["card_states"]["lock_in"] = "n_a"
    return result


# ---------------------------------------------------------------------------
# Sources
# ---------------------------------------------------------------------------

async def page_source(request: AnalyseRequest) -> list[Card]:
    item = request.item
    payload = {"name": item.name, "brand": item.brand, "seller": item.seller, "url": item.url, "id": item.id}
    # Price drift is worked out in the browser and never sent here (privacy rule).
    return [
        ("item", "found" if item.name else "not_found", payload),
        ("price_drift", "n_a", EMPTY_PAYLOAD["price_drift"]),
    ]


def _looks_like_html(text: str) -> bool:
    head = text[:2000].lower()
    return any(tag in head for tag in ("<html", "<body", "<div", "<p>", "<p ", "<main", "<article"))


def page_documents(request: AnalyseRequest) -> list[Document]:
    """The shopping page's own text, if the extension sent any."""
    snippets = "\n\n".join(s for s in request.page_text_snippets if s and s.strip())
    return [Document(request.item.url, snippets)] if snippets else []


def build_documents(request: AnalyseRequest) -> list[Document]:
    """Turn the request into the documents the extractor reads. Page text first."""
    return page_documents(request) + terms_documents(request)


def terms_documents(request: AnalyseRequest) -> list[Document]:
    """T&C pages and PDFs the browser fetched, as text."""
    docs: list[Document] = []
    for t in request.terms:
        if t.fetch_failed:
            continue  # found with search instead, see fallback_documents
        try:
            if t.text:
                text = html_to_text(t.text) if _looks_like_html(t.text) else t.text
            elif t.pdf_b64:
                text = pdf_b64_to_text(t.pdf_b64)
            else:
                continue
        except Exception:  # a corrupt PDF must not take the other documents down
            log.warning("could not read terms document %s", t.url, exc_info=True)
            continue
        if text.strip():
            docs.append(Document(t.url, text))
    return docs


async def fallback_documents(request: AnalyseRequest, search: TavilySearch | None) -> list[Document]:
    """Search for each T&C document the browser failed to fetch (at most 2 searches)."""
    failed = [t for t in request.terms if t.fetch_failed][:MAX_SEARCHES_PER_REQUEST]
    if not failed or search is None:
        return []
    name = request.item.brand or request.item.name
    found = await asyncio.gather(*(search.find_terms(t.url, name, t.kind) for t in failed))
    seen: set[str] = set()
    docs: list[Document] = []
    for d in (d for batch in found for d in batch):
        if d.url not in seen:
            seen.add(d.url)
            docs.append(d)
    return docs


async def terms_source(request: AnalyseRequest, install_id: str, client: AsyncOpenAI,
                       tracker: SpendTracker, search: TavilySearch | None = None,
                       cache: TermsCache | None = None) -> list[Card]:
    site = site_of(request.item.url)

    async def run() -> dict | None:
        page_docs = page_documents(request)
        # Browser-fetched documents first: they win over search results for the same field.
        term_docs = terms_documents(request)

        # Repeat visit with no T&C sent: serve the site's cached T&C fields (no fetch, search or LLM).
        site_fields = cache.get_site(site) if cache and site and not term_docs else None
        if site_fields is None:
            term_docs += await fallback_documents(request, search)
        if not page_docs and not term_docs and site_fields is None:
            return None

        found_page, limit_page = await extract_fields(client, page_docs, install_id, tracker, cache)
        if site_fields is not None:
            found_terms, limit_terms = site_fields, False
        else:
            found_terms, limit_terms = await extract_fields(client, term_docs, install_id, tracker, cache)
            # Only a complete extraction becomes the site's entry (no refusals, no limit cut-off),
            # and only from text the server can vouch for: the pre-warm run's own fetches, or
            # documents the server found itself (search). Text a client sent is served back to
            # that client only. Otherwise one install could decide what every other install
            # sees for a site, with quotes that verify against text the real page never had.
            trusted = install_id == PREWARM_INSTALL or all(d.source for d in term_docs)
            if cache and site and term_docs and trusted and not limit_terms and all(
                    cache.has_doc(d.url, d.text, d.source) for d in term_docs):
                cache.put_site(site, found_terms)

        # The shopping page's own text wins over its T&Cs for the same field.
        merged = {**found_terms, **found_page}
        return build_cards(merged, limit_page or limit_terms)

    refill_on = refill_enabled() and search is not None and "product" in request.purchase_type_signals

    async def run_refill() -> dict | None:
        try:
            return await find_refill(client, search, name=request.item.name, brand=request.item.brand,
                                     page_url=request.item.url, install_id=install_id, tracker=tracker, cache=cache)
        except Exception:
            log.exception("refill lookup failed")
            return None

    async def run_all() -> dict | None:
        if refill_on:
            result, refill = await asyncio.gather(run(), run_refill())
        else:
            result, refill = await run(), None
        if result and product_only(request):
            result = _without_cost_and_lock_in(result)
        if refill:
            result = result or build_cards({})
            result["cost_streams"].append(refill)
            if result["card_states"]["cost"] != "found":
                result["card_states"]["cost"] = "estimated"  # only the refill estimate on this card
        return result

    # One budget for search, extraction and refill, so the cards always resolve in time.
    try:
        result = await asyncio.wait_for(run_all(), TERMS_TIMEOUT_S)
    except asyncio.TimeoutError:
        # A slow product page still says cost and lock-in don't apply (40-URL run 2026-11-08).
        log.warning("terms source timed out after %ss", TERMS_TIMEOUT_S)
        result = None
    if result is None:
        if product_only(request):
            return _not_found(("cost", "lock_in"), "n_a") + _not_found(("small_print",))
        return _not_found(TERMS_CARDS)
    states = result["card_states"]
    return [
        ("cost", states["cost"], {"cost_streams": result["cost_streams"]}),
        ("lock_in", states["lock_in"], result["lock_in"]),
        ("small_print", states["small_print"], result["small_print"]),
    ]


def get_company_lookup():
    """Return the company_lookup callable. Tests monkeypatch this to inject a fast stub."""
    from smallprint.company import company_lookup
    return company_lookup


def get_news_lookup():
    """Return the fetch_news callable. Tests monkeypatch this to inject a stub."""
    from smallprint.news import fetch_news
    return fetch_news


async def _news_records(result: dict, install_id: str | None, client: AsyncOpenAI | None,
                        tracker: SpendTracker | None, search: TavilySearch | None) -> list[dict]:
    """News records (ADR 0004) for an identified company, or [] when off, unconfigured or failing."""
    from smallprint.news import NEWS_TIMEOUT_S, news_enabled
    # Only once we know who the company is: news about an unresolved brand name could be
    # about a different company with the same name.
    if not (client and search and news_enabled() and (result.get("ch_number") or result.get("parent"))):
        return []
    try:
        return await asyncio.wait_for(
            get_news_lookup()(result.get("brand") or "", result.get("parent"), client=client,
                              api_key=search.api_key, install_id=install_id, tracker=tracker),
            NEWS_TIMEOUT_S)
    except asyncio.TimeoutError:
        log.warning("news lookup timed out for brand=%s", result.get("brand"))
    except Exception:
        log.exception("news lookup failed for brand=%s", result.get("brand"))
    return []


async def company_source(request: AnalyseRequest, install_id: str | None = None,
                         client: AsyncOpenAI | None = None, tracker: SpendTracker | None = None,
                         search: TavilySearch | None = None) -> list[Card]:
    brand = request.item.brand or request.item.name or ""
    domain = request.item.url or ""
    try:
        result = await asyncio.wait_for(
            get_company_lookup()(brand, domain, manufacturer=request.item.manufacturer,
                                 deep_search=deep_search_enabled()), COMPANY_TIMEOUT_S)
    except asyncio.TimeoutError:
        log.warning("company lookup timed out after %ss for brand=%s", COMPANY_TIMEOUT_S, brand)
        return [("company", "not_found", {**EMPTY_PAYLOAD["company"], "brand": brand})]
    news = await _news_records(result, install_id, client, tracker, search)
    if news:
        result = {**result, "records": [*(result.get("records") or []), *news]}
    # "found" when we know who's behind it, even if no UK records could be joined: a
    # Companies House match, a known parent, or a record matched on the exact brand or
    # parent name (the ethics datasets carry no CH number, ADR 0002).
    found = result.get("ch_number") or result.get("parent") or result.get("records")
    state = "found" if found else "not_found"
    return [("company", state, result)]


# ---------------------------------------------------------------------------
# Streaming
# ---------------------------------------------------------------------------

def _event(card: Card) -> dict:
    name, state, payload = card
    return {"event": "card", "data": json.dumps({"card": name, "state": state, "payload": payload})}


async def stream_real(request: AnalyseRequest, install_id: str, client: AsyncOpenAI,
                      tracker: SpendTracker, search: TavilySearch | None = None,
                      cache: TermsCache | None = None) -> AsyncGenerator[dict, None]:
    sources: list[tuple[tuple[str, ...], Callable[[], Awaitable[list[Card]]]]] = [
        (("item", "price_drift"), lambda: page_source(request)),
        (TERMS_CARDS, lambda: terms_source(request, install_id, client, tracker, search, cache)),
        (("company",), lambda: company_source(request, install_id, client, tracker, search)),
    ]

    async def run(cards: tuple[str, ...], fn: Callable[[], Awaitable[list[Card]]]) -> list[Card]:
        try:
            return await fn()
        except asyncio.TimeoutError:
            log.warning("source %s timed out", cards)
        except Exception:
            log.exception("source %s failed", cards)
        return _not_found(cards)

    tasks = [asyncio.create_task(run(cards, fn)) for cards, fn in sources]
    try:
        for next_done in asyncio.as_completed(tasks):
            for card in await next_done:
                yield _event(card)
        yield {"event": "done", "data": "{}"}
    finally:
        # Client went away mid-stream: stop paying for lookups nobody will see.
        for t in tasks:
            t.cancel()
