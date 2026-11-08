"""News records for the company card: what named news outlets reported, quoted verbatim (ADR 0004).

Where it may come from is fixed in code, never chosen by the model:
  * One Tavily news search restricted to ``NEWS_SITES``.  Every result is checked
    against the list again here, and opinion, comment, live-blog and analysis pages
    are dropped by their URL path.
  * The model only copies sentences.  A sentence is kept only if it appears verbatim
    in the article (the S1 quote verifier), names the company, and is short.
  * The date is the article's own publication date (from the search result, else
    the date in its URL).  An article with no date is dropped.

The record's summary is the quote itself with the outlet's name: SmallPrint adds no
words of its own.  The panel shows it as "In the news" with a note that it is the
outlet's report, not SmallPrint's opinion, and that the claims are not checked.

Any failure (no keys, search down, refusal, spend limit) gives no news records;
the rest of the company card is unaffected.
"""
from __future__ import annotations

import asyncio
import logging
import os
import re
import time
from datetime import date, datetime
from email.utils import parsedate_to_datetime
from urllib.parse import urlsplit

import httpx
from openai import AsyncOpenAI

from smallprint.extract.extractor import _extract_chunk
from smallprint.extract.text import chunk_text
from smallprint.spend import SpendLimitReached, SpendTracker
from smallprint.verify import verify_quote

log = logging.getLogger(__name__)

TAVILY_URL = "https://api.tavily.com/search"
KIND = "news"

# The only outlets news may come from: site → name shown with the quote.
NEWS_SITES: dict[str, str] = {
    "bbc.co.uk": "BBC News",
    "bbc.com": "BBC News",
    "theguardian.com": "The Guardian",
    "reuters.com": "Reuters",
    "apnews.com": "Associated Press",
    "nbcnews.com": "NBC News",
    "nytimes.com": "The New York Times",
    "ft.com": "Financial Times",
    "news.sky.com": "Sky News",
}

# Opinion and commentary, live blogs and analysis: not straight reporting.
_NOT_REPORTING = re.compile(
    r"/(?:opinion|opinions|commentisfree|comment|comments|editorials?|letters|blogs?|columnists?|"
    r"columns?|analysis|live|live-news|podcasts?|video|videos|sounds)(?:/|$)",
    re.I,
)

SEARCH_TIMEOUT_S = 8.0
NEWS_TIMEOUT_S = 15.0       # whole news step, on top of the company lookup
MAX_ARTICLES = 4            # one LLM call each
ARTICLE_TOKENS = 3_000      # only the top of each article goes to the model
MAX_RECORDS = 3
MAX_QUOTE_CHARS = 400
MIN_QUOTE_CHARS = 40
LOOKBACK_DAYS = 3 * 365
CACHE_TTL_S = 7 * 24 * 3600
_CACHE_MAX = 500

_LEGAL_SUFFIX = re.compile(
    r"[\s,]+(?:inc|incorporated|corp|corporation|co|company|ltd|limited|plc|llc|llp|lp|group|holdings|"
    r"gmbh|ag|sa|nv|bv|se)\.?$",
    re.I,
)

SYSTEM_PROMPT = """You copy sentences from a news article. You never write your own words.

From the article, copy up to 2 sentences that report something concrete the company \
did or that was done to it: a fine, penalty or regulator ruling; a lawsuit, court ruling \
or settlement; an investigation; a political donation or lobbying; a product recall; a \
data breach; a layoff or plant closure; a pay, labour or environmental finding.

Rules:
- Copy each sentence exactly as written, character for character. Do not shorten, \
join or fix it.
- The sentence must name the company.
- Only factual reporting. Skip opinions, predictions, commentary, rumours, \
advertising and anyone's quoted views.
- If there is no such sentence, return an empty list."""

OUTPUT_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["sentences"],
    "properties": {
        "sentences": {"type": "array", "items": {"type": "string"}},
    },
}


def news_enabled() -> bool:
    """On unless SMALLPRINT_NEWS is 0/false/off/no.  Still needs the LLM and Tavily keys."""
    return os.environ.get("SMALLPRINT_NEWS", "").strip().lower() not in ("0", "false", "off", "no")


# ---------------------------------------------------------------------------
# Sources and dates
# ---------------------------------------------------------------------------

def outlet_of(url: str) -> str | None:
    """The outlet name if ``url`` is on an allowed news site and is straight reporting, else None."""
    parts = urlsplit(url or "")
    if parts.scheme not in ("http", "https"):
        return None
    host = (parts.hostname or "").lower().removeprefix("www.")
    site = next((s for s in NEWS_SITES if host == s or host.endswith("." + s)), None)
    if site is None or _NOT_REPORTING.search(parts.path or ""):
        return None
    return NEWS_SITES[site]


_URL_DATE = re.compile(r"/(20\d{2})[/-](\d{1,2}|[a-z]{3})[/-](\d{1,2})(?:/|-|\.|$)", re.I)
_MONTHS = {m: i for i, m in enumerate(
    ("jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"), start=1)}


def article_date(published: str | None, url: str) -> str | None:
    """ISO date of publication: the search result's date, else one in the URL, else None."""
    s = (published or "").strip()
    if s:
        for parse in (parsedate_to_datetime, datetime.fromisoformat):
            try:
                return parse(s.replace("Z", "+00:00")).date().isoformat()
            except (TypeError, ValueError, IndexError):
                continue
    m = _URL_DATE.search(urlsplit(url or "").path)
    if m:
        month = int(m[2]) if m[2].isdigit() else _MONTHS.get(m[2].lower())
        try:
            return date(int(m[1]), month, int(m[3])).isoformat() if month else None
        except ValueError:
            return None
    return None


# ---------------------------------------------------------------------------
# Names
# ---------------------------------------------------------------------------

def name_cores(names) -> list[str]:
    """Names to look for in a quote, legal form removed ("Microsoft Corporation" → "Microsoft")."""
    out: list[str] = []
    for n in names:
        n = (n or "").strip()
        while n:
            stripped = _LEGAL_SUFFIX.sub("", n).strip(" ,.")
            if stripped == n:
                break
            n = stripped
        if len(n) >= 2 and n.casefold() not in (o.casefold() for o in out):
            out.append(n)
    return out


def names_company(quote: str, cores: list[str]) -> bool:
    """The quote names one of ``cores`` as whole words (case-insensitive)."""
    return any(re.search(r"(?<!\w)" + re.escape(c) + r"(?!\w)", quote, re.I) for c in cores)


def _query_name(brand: str, parent: str | None) -> str:
    """Search for the owner when it isn't just the brand with a legal form ("Pepsi Max" → "PepsiCo")."""
    brand_core = (name_cores([brand]) or [brand])[0]
    if parent:
        parent_core = (name_cores([parent]) or [parent])[0]
        if parent_core.casefold() != brand_core.casefold():
            return parent_core
    return brand_core


# ---------------------------------------------------------------------------
# Cache (per process; news changes slowly and every lookup costs a search + LLM calls)
# ---------------------------------------------------------------------------

_cache: dict[tuple[str, ...], tuple[float, list[dict]]] = {}


def _cache_key(cores: list[str]) -> tuple[str, ...]:
    return tuple(sorted(c.casefold() for c in cores))


def _cache_get(key: tuple[str, ...]) -> list[dict] | None:
    hit = _cache.get(key)
    if hit and time.monotonic() - hit[0] < CACHE_TTL_S:
        return [dict(r) for r in hit[1]]
    _cache.pop(key, None)
    return None


def _cache_put(key: tuple[str, ...], records: list[dict]) -> None:
    if len(_cache) >= _CACHE_MAX:
        _cache.pop(next(iter(_cache)))
    _cache[key] = (time.monotonic(), [dict(r) for r in records])


def clear_cache() -> None:
    _cache.clear()


# ---------------------------------------------------------------------------
# Search and extraction
# ---------------------------------------------------------------------------

async def _search(http: httpx.AsyncClient, api_key: str, query: str) -> list[dict] | None:
    """Tavily news results on the allowed sites, or None if the search failed."""
    body = {
        "query": query,
        "topic": "news",
        "days": LOOKBACK_DAYS,
        "search_depth": "basic",
        "max_results": 10,
        "include_raw_content": "text",
        "include_domains": sorted(NEWS_SITES),
    }
    try:
        resp = await http.post(TAVILY_URL, json=body, timeout=SEARCH_TIMEOUT_S,
                               headers={"Authorization": f"Bearer {api_key}"})
        resp.raise_for_status()
        return resp.json().get("results") or []
    except (httpx.HTTPError, ValueError, AttributeError):
        log.warning("news search failed for %r", query, exc_info=True)
        return None


def _articles(results: list[dict]) -> list[dict]:
    """Allowed, dated, straight-reporting articles with text, newest first, one per URL."""
    out, seen = [], set()
    for r in results:
        url = (r.get("url") or "").strip()
        text = r.get("raw_content") or r.get("content") or ""
        outlet = outlet_of(url)
        when = article_date(r.get("published_date"), url)
        if not outlet or not when or url in seen or not text.strip():
            continue
        seen.add(url)
        out.append({"url": url, "text": text, "outlet": outlet, "date": when})
    out.sort(key=lambda a: a["date"], reverse=True)
    return out[:MAX_ARTICLES]


def _clean_quote(s: str) -> str:
    return re.sub(r"\s+", " ", s or "").strip()


async def _quotes(client: AsyncOpenAI, article: dict, cores: list[str],
                  install_id: str | None, tracker: SpendTracker | None) -> list[str]:
    """Verified sentences from one article.  Raises SpendLimitReached."""
    chunks = chunk_text(article["text"], ARTICLE_TOKENS)
    if not chunks:
        return []
    chunk = chunks[0]  # the top of the article: where the news is, and a bounded cost
    system = SYSTEM_PROMPT + "\n\nThe company: " + " / ".join(cores)
    raw = await _extract_chunk(client, chunk, install_id, tracker, system=system, schema=OUTPUT_SCHEMA)
    kept = []
    for s in (raw or {}).get("sentences") or []:
        if not isinstance(s, str):
            continue
        q = _clean_quote(s)
        if (MIN_QUOTE_CHARS <= len(q) <= MAX_QUOTE_CHARS
                and verify_quote(q, chunk) and names_company(q, cores)):
            kept.append(q)
    return kept


async def fetch_news(
    brand: str,
    parent: str | None = None,
    *,
    client: AsyncOpenAI | None,
    api_key: str | None,
    install_id: str | None = None,
    tracker: SpendTracker | None = None,
    http: httpx.AsyncClient | None = None,
) -> list[dict]:
    """News records ({kind, summary, date, source_url}) about the company, newest first. [] on any failure."""
    cores = name_cores([brand, parent])
    if not cores or client is None or not api_key:
        return []
    key = _cache_key(cores)
    cached = _cache_get(key)
    if cached is not None:
        return cached

    own_http = http is None
    if own_http:
        http = httpx.AsyncClient(follow_redirects=True)
    try:
        results = await _search(http, api_key, _query_name(brand, parent))
        if results is None:
            return []  # search failed: don't cache, try again next time
        articles = _articles(results)
        complete = True
        outcomes = await asyncio.gather(
            *(_quotes(client, a, cores, install_id, tracker) for a in articles), return_exceptions=True)
        records: list[dict] = []
        seen_quotes: set[str] = set()
        for article, got in zip(articles, outcomes):
            if isinstance(got, BaseException):
                complete = False
                if not isinstance(got, SpendLimitReached):
                    log.warning("news extraction failed for %s: %r", article["url"], got)
                continue
            for q in got[:1]:  # one record per article
                if q.casefold() in seen_quotes:
                    continue
                seen_quotes.add(q.casefold())
                records.append({
                    "kind": KIND,
                    "summary": f"“{q}” ({article['outlet']})",
                    "date": article["date"],
                    "source_url": article["url"],
                })
        records = records[:MAX_RECORDS]
        if complete:
            _cache_put(key, records)
        return records
    finally:
        if own_http:
            await http.aclose()
