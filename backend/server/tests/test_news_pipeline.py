"""The company card gets news records (ADR 0004) only for an identified company, with both keys set."""
import asyncio

import pytest

from server import pipeline
from server.models import AnalyseRequest
from smallprint.search_fallback import TavilySearch

NEWS = {"kind": "news", "summary": "“Microsoft was fined.” (Reuters)", "date": "2025-05-05",
        "source_url": "https://www.reuters.com/technology/x"}
PAY_GAP = {"kind": "gender_pay_gap", "summary": "Mean gender pay gap of 6.4%.", "date": "2026-04-03",
           "source_url": "https://gpg.example/"}


def _request() -> AnalyseRequest:
    return AnalyseRequest.model_validate({
        "item": {"name": "Microsoft 365", "brand": "Microsoft", "url": "https://www.microsoft.com/en-gb/"},
        "purchase_type_signals": ["subscription"], "links": [], "page_text_snippets": [],
    })


def _lookup(result: dict):
    async def fake(brand, domain, **_):
        return dict(result)
    return fake


IDENTIFIED = {"brand": "Microsoft", "parent": "Microsoft Corporation", "ch_number": "01624297",
              "match_via": "Wikidata", "records": [PAY_GAP]}
UNKNOWN = {"brand": "Microsoft", "parent": None, "ch_number": None, "match_via": "Brand not identified", "records": []}


@pytest.fixture
def news_calls(monkeypatch):
    calls = []

    async def fake_news(brand, parent, **kw):
        calls.append((brand, parent, kw))
        return [NEWS]
    monkeypatch.setattr(pipeline, "get_news_lookup", lambda: fake_news)
    monkeypatch.delenv("SMALLPRINT_NEWS", raising=False)
    return calls


async def test_news_is_added_for_an_identified_company(monkeypatch, news_calls):
    monkeypatch.setattr(pipeline, "get_company_lookup", lambda: _lookup(IDENTIFIED))
    [(_, state, payload)] = await pipeline.company_source(
        _request(), "install-1", object(), None, TavilySearch("tvly-key"))
    assert state == "found"
    assert payload["records"] == [PAY_GAP, NEWS]
    [(brand, parent, kw)] = news_calls
    assert (brand, parent, kw["api_key"], kw["install_id"]) == ("Microsoft", "Microsoft Corporation", "tvly-key", "install-1")


async def test_no_news_for_an_unidentified_brand(monkeypatch, news_calls):
    monkeypatch.setattr(pipeline, "get_company_lookup", lambda: _lookup(UNKNOWN))
    [(_, state, payload)] = await pipeline.company_source(_request(), "i", object(), None, TavilySearch("k"))
    assert state == "not_found" and payload["records"] == [] and news_calls == []


@pytest.mark.parametrize("client,search", [(None, TavilySearch("k")), (object(), None), (None, None)])
async def test_no_news_without_both_keys(monkeypatch, news_calls, client, search):
    monkeypatch.setattr(pipeline, "get_company_lookup", lambda: _lookup(IDENTIFIED))
    [(_, _, payload)] = await pipeline.company_source(_request(), "i", client, None, search)
    assert payload["records"] == [PAY_GAP] and news_calls == []


async def test_no_news_when_turned_off(monkeypatch, news_calls):
    monkeypatch.setenv("SMALLPRINT_NEWS", "0")
    monkeypatch.setattr(pipeline, "get_company_lookup", lambda: _lookup(IDENTIFIED))
    [(_, _, payload)] = await pipeline.company_source(_request(), "i", object(), None, TavilySearch("k"))
    assert payload["records"] == [PAY_GAP] and news_calls == []


async def test_old_call_shape_still_works(monkeypatch, news_calls):
    """company_source(request) (mock mode, other callers) keeps working and adds no news."""
    monkeypatch.setattr(pipeline, "get_company_lookup", lambda: _lookup(IDENTIFIED))
    [(_, state, payload)] = await pipeline.company_source(_request())
    assert state == "found" and payload["records"] == [PAY_GAP] and news_calls == []


async def test_a_slow_or_failing_news_lookup_leaves_the_card_intact(monkeypatch):
    monkeypatch.setattr(pipeline, "get_company_lookup", lambda: _lookup(IDENTIFIED))
    from smallprint import news

    async def slow(*a, **k):
        await asyncio.sleep(5)
        return [NEWS]

    async def broken(*a, **k):
        raise RuntimeError("boom")

    monkeypatch.setattr(news, "NEWS_TIMEOUT_S", 0.1)
    for fn in (slow, broken):
        monkeypatch.setattr(pipeline, "get_news_lookup", lambda fn=fn: fn)
        [(_, state, payload)] = await pipeline.company_source(_request(), "i", object(), None, TavilySearch("k"))
        assert state == "found" and payload["records"] == [PAY_GAP]
