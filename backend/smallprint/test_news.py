"""News records (ADR 0004).  Tavily and the LLM are faked at the httpx boundary.

Done when:
  * Only articles on the fixed outlet list, outside opinion/comment/live/analysis
    sections, with a publication date, are read.
  * A record is a sentence that appears verbatim in the article and names the company,
    with the outlet's name; nothing the model writes itself is shown.
  * No keys, a failed search, a refusal or the spend limit give no records and no crash.
"""
from __future__ import annotations

import json

import httpx
import pytest
from openai import AsyncOpenAI

from smallprint import news
from smallprint.news import (
    article_date,
    fetch_news,
    name_cores,
    names_company,
    outlet_of,
)
from smallprint.spend import SpendTracker

FINE = "Microsoft was fined $20m by the US Federal Trade Commission over children's data on Xbox, the regulator said on Monday."
OPINION_LINE = "Microsoft is the most arrogant company in the world and should be broken up."
ARTICLE = (
    "Washington (Reuters) - " + FINE + " The company said it disagreed with the finding. "
    + "Analysts expect more cases. " + OPINION_LINE
)


@pytest.fixture(autouse=True)
def _fresh_cache():
    news.clear_cache()
    yield
    news.clear_cache()


def _tavily(results: list[dict], status: int = 200):
    seen: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(json.loads(request.content))
        return httpx.Response(status, json={"results": results})
    return httpx.AsyncClient(transport=httpx.MockTransport(handler)), seen


def _llm(sentences_by_url: dict[str, list[str]] | list[str], finish: str = "stop"):
    calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        doc = body["messages"][1]["content"]
        calls.append(doc)
        if isinstance(sentences_by_url, dict):
            got = next((v for k, v in sentences_by_url.items() if k in doc), [])
        else:
            got = sentences_by_url
        return httpx.Response(200, json={
            "id": "c", "object": "chat.completion", "created": 0, "model": "gpt-4o-mini",
            "choices": [{"index": 0, "finish_reason": finish,
                         "message": {"role": "assistant", "content": json.dumps({"sentences": got}), "refusal": None}}],
            "usage": {"prompt_tokens": 1_000, "completion_tokens": 50, "total_tokens": 1_050},
        })
    client = AsyncOpenAI(api_key="test", max_retries=0,
                         http_client=httpx.AsyncClient(transport=httpx.MockTransport(handler)))
    return client, calls


def _result(url: str, text: str = ARTICLE, published: str | None = "Mon, 05 May 2025 10:00:00 GMT") -> dict:
    r = {"url": url, "raw_content": text, "content": text[:100]}
    if published is not None:
        r["published_date"] = published
    return r


REUTERS = "https://www.reuters.com/technology/microsoft-fined-xbox-2025-05-05/"


# ---------------------------------------------------------------------------
# Sources, dates and names
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("url,outlet", [
    (REUTERS, "Reuters"),
    ("https://www.bbc.co.uk/news/business-123", "BBC News"),
    ("https://www.theguardian.com/technology/2025/may/05/microsoft-fined", "The Guardian"),
    ("https://news.sky.com/story/microsoft-123", "Sky News"),
    ("https://www.nbcnews.com/tech/microsoft-fined-rcna1", "NBC News"),
    ("https://www.theguardian.com/commentisfree/2025/may/05/microsoft", None),   # comment
    ("https://www.nytimes.com/2025/05/05/opinion/microsoft.html", None),          # opinion
    ("https://www.bbc.co.uk/news/live/business-123", None),                       # live blog
    ("https://www.reuters.com/breakingviews/analysis/microsoft", None),            # analysis
    ("https://www.dailymail.co.uk/news/article-1/microsoft.html", None),           # not on the list
    ("https://reuters.com.evil.example/technology/x", None),                       # look-alike host
    ("https://notreuters.com/technology/x", None),
    ("ftp://www.reuters.com/technology/x", None),
])
def test_outlet_of(url, outlet):
    assert outlet_of(url) == outlet


@pytest.mark.parametrize("published,url,expected", [
    ("Mon, 05 May 2025 10:00:00 GMT", "https://x/", "2025-05-05"),
    ("2025-05-05T10:00:00Z", "https://x/", "2025-05-05"),
    (None, "https://www.theguardian.com/business/2024/mar/14/story", "2024-03-14"),
    (None, "https://www.nytimes.com/2024/03/14/business/story.html", "2024-03-14"),
    (None, "https://www.theguardian.com/business/2024/xyz/14/story", None),
    (None, "https://www.nytimes.com/2024/02/30/business/story.html", None),
    ("not a date", "https://x/", None),
    (None, "https://x/", None),
])
def test_article_date(published, url, expected):
    assert article_date(published, url) == expected


def test_name_cores_and_mentions():
    cores = name_cores(["Microsoft", "Microsoft Corporation", "PepsiCo, Inc."])
    assert cores == ["Microsoft", "PepsiCo"]
    assert names_company(FINE, cores)
    assert not names_company("Microsofty launched a thing today in London.", cores)


# ---------------------------------------------------------------------------
# fetch_news
# ---------------------------------------------------------------------------

async def test_verbatim_sentence_from_an_allowed_outlet_becomes_a_record():
    http, sent = _tavily([_result(REUTERS)])
    client, _ = _llm([FINE])
    async with http:
        records = await fetch_news("Microsoft", "Microsoft Corporation", client=client, api_key="k", http=http)
    assert records == [{
        "kind": "news",
        "summary": f"“{FINE}” (Reuters)",
        "date": "2025-05-05",
        "source_url": REUTERS,
    }]
    # The outlet list is passed to the search itself, not left to the model.
    assert set(sent[0]["include_domains"]) == set(news.NEWS_SITES)
    assert sent[0]["topic"] == "news"


async def test_a_sentence_the_model_rewrote_is_dropped():
    http, _ = _tavily([_result(REUTERS)])
    client, _ = _llm(["Microsoft was fined twenty million dollars by the FTC over Xbox children's data."])
    async with http:
        assert await fetch_news("Microsoft", None, client=client, api_key="k", http=http) == []


async def test_a_sentence_that_does_not_name_the_company_is_dropped():
    http, _ = _tavily([_result(REUTERS)])
    client, _ = _llm(["The company said it disagreed with the finding."])
    async with http:
        assert await fetch_news("Microsoft", None, client=client, api_key="k", http=http) == []


async def test_off_list_opinion_and_undated_articles_never_reach_the_model():
    results = [
        _result("https://www.dailymail.co.uk/news/article-1/microsoft.html"),
        _result("https://www.theguardian.com/commentisfree/2025/may/05/microsoft"),
        _result("https://www.bbc.co.uk/news/business-999", published=None),   # no date anywhere
    ]
    http, _ = _tavily(results)
    client, calls = _llm([FINE])
    async with http:
        assert await fetch_news("Microsoft", None, client=client, api_key="k", http=http) == []
    assert calls == []


async def test_newest_first_one_record_per_article_and_capped():
    urls = [f"https://www.bbc.co.uk/news/business-{i}" for i in range(6)]
    dates = ["Mon, 0{} May 2025 10:00:00 GMT".format(i + 1) for i in range(6)]
    http, _ = _tavily([_result(u, published=d) for u, d in zip(urls, dates)])
    client, calls = _llm([FINE, FINE])
    async with http:
        records = await fetch_news("Microsoft", None, client=client, api_key="k", http=http)
    assert len(calls) == news.MAX_ARTICLES
    assert len(records) == 1  # the same sentence in every article is shown once
    assert records[0]["date"] == "2025-05-06"


async def test_no_keys_or_no_brand_means_no_calls():
    http, sent = _tavily([_result(REUTERS)])
    client, calls = _llm([FINE])
    async with http:
        assert await fetch_news("Microsoft", None, client=None, api_key="k", http=http) == []
        assert await fetch_news("Microsoft", None, client=client, api_key="", http=http) == []
        assert await fetch_news("", None, client=client, api_key="k", http=http) == []
    assert sent == [] and calls == []


async def test_failed_search_gives_nothing_and_is_not_cached():
    http, sent = _tavily([], status=500)
    client, _ = _llm([FINE])
    async with http:
        assert await fetch_news("Microsoft", None, client=client, api_key="k", http=http) == []
        await fetch_news("Microsoft", None, client=client, api_key="k", http=http)
    assert len(sent) == 2


async def test_results_are_cached_per_company():
    http, sent = _tavily([_result(REUTERS)])
    client, calls = _llm([FINE])
    async with http:
        first = await fetch_news("Microsoft", None, client=client, api_key="k", http=http)
        second = await fetch_news("microsoft", None, client=client, api_key="k", http=http)
    assert first == second and len(sent) == 1 and len(calls) == 1


async def test_refusal_gives_nothing():
    http, _ = _tavily([_result(REUTERS)])
    client, _ = _llm([FINE], finish="content_filter")
    async with http:
        assert await fetch_news("Microsoft", None, client=client, api_key="k", http=http) == []


async def test_spend_limit_stops_the_calls_and_is_not_cached():
    tracker = SpendTracker(daily_limit_usd=0.0)
    http, _ = _tavily([_result(REUTERS)])
    client, calls = _llm([FINE])
    async with http:
        assert await fetch_news("Microsoft", None, client=client, api_key="k", http=http,
                                install_id="i", tracker=tracker) == []
    assert calls == []
    assert news._cache == {}


async def test_owner_is_searched_when_it_differs_from_the_brand():
    http, sent = _tavily([])
    client, _ = _llm([])
    async with http:
        await fetch_news("Pepsi Max", "PepsiCo", client=client, api_key="k", http=http)
        await fetch_news("Microsoft", "Microsoft Corporation", client=client, api_key="k", http=http)
    assert [s["query"] for s in sent] == ["PepsiCo", "Microsoft"]


async def test_records_have_no_words_of_ours_beyond_the_outlet_name():
    http, _ = _tavily([_result(REUTERS)])
    client, _ = _llm([FINE])
    async with http:
        [record] = await fetch_news("Microsoft", None, client=client, api_key="k", http=http)
    assert record["summary"] == f"“{FINE}” (Reuters)"
