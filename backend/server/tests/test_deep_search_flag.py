"""The pipeline runs the company lookup with deep search on unless SMALLPRINT_DEEP_SEARCH turns it off."""
import pytest

from server import pipeline
from server.models import AnalyseRequest


def _request() -> AnalyseRequest:
    return AnalyseRequest.model_validate({
        "item": {"name": "Microsoft 365 Personal", "brand": "Microsoft", "url": "https://www.microsoft.com/en-gb/"},
        "purchase_type_signals": ["subscription"], "links": [], "page_text_snippets": [],
    })


@pytest.mark.parametrize("value,on", [
    (None, True), ("", True), ("1", True), ("on", True),
    ("0", False), ("false", False), ("OFF", False), ("no", False),
])
async def test_deep_search_flag_reaches_the_lookup(monkeypatch, value, on):
    if value is None:
        monkeypatch.delenv("SMALLPRINT_DEEP_SEARCH", raising=False)
    else:
        monkeypatch.setenv("SMALLPRINT_DEEP_SEARCH", value)
    seen = {}

    async def fake_lookup(brand, domain, **kwargs):
        seen.update(kwargs)
        return {"brand": brand, "parent": None, "ch_number": None, "match_via": "Brand not identified", "records": []}

    monkeypatch.setattr(pipeline, "get_company_lookup", lambda: fake_lookup)
    await pipeline.company_source(_request())
    assert seen.get("deep_search") is on
