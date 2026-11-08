"""Tests for /health, /analyse, and /flag/company-match endpoints."""
from __future__ import annotations
import json
import sqlite3
from pathlib import Path

import jsonschema
import pytest
from httpx import ASGITransport, AsyncClient

from server.main import app

SCHEMA_DIR = Path(__file__).parent.parent.parent.parent / "contracts"
STREAM_EVENT_SCHEMA = json.loads((SCHEMA_DIR / "stream-event.schema.json").read_text())
RESPONSE_SCHEMA = json.loads((SCHEMA_DIR / "response.schema.json").read_text())

_BASE_REQUEST = {
    "item": {"name": "Netflix Standard", "brand": "Netflix", "url": "https://www.netflix.com/gb/signup", "id": None, "seller": None, "price": 4.99},
    "purchase_type_signals": ["subscription"],
    "links": [],
    "page_text_snippets": [],
    "install_id": "test-install-abc123",
}


@pytest.fixture
async def client():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c


async def test_health(client: AsyncClient) -> None:
    resp = await client.get("/health")
    assert resp.status_code == 200
    assert resp.json() == {"ok": True}


async def test_analyse_no_install_id(client: AsyncClient) -> None:
    bad = {**_BASE_REQUEST, "install_id": ""}
    resp = await client.post("/analyse", json=bad)
    assert resp.status_code == 422


async def test_analyse_streams_events_in_order(client: AsyncClient) -> None:
    expected_order = ["item", "price_drift", "cost", "lock_in", "small_print", "company"]
    received_cards: list[str] = []
    got_done = False

    async with client.stream("POST", "/analyse", json=_BASE_REQUEST) as resp:
        assert resp.status_code == 200
        event_name: str | None = None
        async for line in resp.aiter_lines():
            line = line.strip()
            if line.startswith("event:"):
                event_name = line.split(":", 1)[1].strip()
            elif line.startswith("data:"):
                data_str = line.split(":", 1)[1].strip()
                data = json.loads(data_str)
                if event_name == "card":
                    # Validate against stream-event schema
                    jsonschema.validate(data, STREAM_EVENT_SCHEMA)
                    received_cards.append(data["card"])
                elif event_name == "done":
                    got_done = True

    assert received_cards == expected_order, f"Card order wrong: {received_cards}"
    assert got_done, "No 'done' event received"


async def test_all_card_events_valid_schema(client: AsyncClient) -> None:
    """Every 'card' event data must pass stream-event schema validation."""
    validator = jsonschema.Draft202012Validator(STREAM_EVENT_SCHEMA)

    async with client.stream("POST", "/analyse", json=_BASE_REQUEST) as resp:
        event_name: str | None = None
        async for line in resp.aiter_lines():
            line = line.strip()
            if line.startswith("event:"):
                event_name = line.split(":", 1)[1].strip()
            elif line.startswith("data:") and event_name == "card":
                data = json.loads(line.split(":", 1)[1].strip())
                errors = list(validator.iter_errors(data))
                assert not errors, f"Schema errors on card '{data.get('card')}': {errors[0].message}"


def test_mock_mode_never_shows_the_sodastream_fixture_as_found_for_another_product() -> None:
    """Mock mode (no OPENAI_API_KEY) serves fixtures. Any Amazon URL used to get the SodaStream
    data as `found`: a wrong product shown with invented figures (V1, #29)."""
    from server.fixtures import pick_fixture

    other = pick_fixture("https://www.amazon.co.uk/dp/B09F72J3SG", "Philips Hue White Starter Kit")
    assert other["card_states"]["cost"] != "found"
    assert not other["cost_streams"]
    # The SodaStream request fixture still gets its mock.
    soda = pick_fixture("https://www.amazon.co.uk/dp/B09XXXXXXX", "SodaStream Terra Sparkling Water Maker")
    assert (soda["item"]["name"] or "").startswith("SodaStream")


def test_default_record_kinds_match_data_kinds() -> None:
    """DEFAULT_SETTINGS.recordKinds must use the same ids as the records the backend returns.

    The DB uses: donation, gender_pay_gap, modern_slavery, and the name-keyed
    ethics kinds lgbtq_rights, abortion_rights, climate (ADR 0002).
    asa_ruling records do not come from the DB: smallprint.asa fetches them
    live and smallprint.company merges them into the company's records.
    A mismatch means CompanyCard never flags any records for the user.
    """
    from pathlib import Path
    import json

    types_path = Path(__file__).parent.parent.parent.parent / "panel" / "src" / "types.ts"
    source = types_path.read_text(encoding="utf-8")

    # Extract the recordKinds array from DEFAULT_SETTINGS
    import re
    m = re.search(r'recordKinds:\s*\[([^\]]+)\]', source)
    assert m, "Could not find DEFAULT_SETTINGS.recordKinds in types.ts"
    kinds = re.findall(r'"([^"]+)"', m.group(1))

    db_kinds = {"donation", "gender_pay_gap", "modern_slavery", "lgbtq_rights", "abortion_rights", "climate"}
    from smallprint.news import KIND as NEWS_KIND  # live: news.py via pipeline (ADR 0004)
    live_kinds = {"asa_ruling", NEWS_KIND}
    allowed = db_kinds | live_kinds
    unknown = set(kinds) - allowed
    assert not unknown, (
        f"DEFAULT_SETTINGS.recordKinds contains ids the backend never returns: {unknown}. "
        f"Known kinds are: {allowed}"
    )


async def test_rate_limit(client: AsyncClient) -> None:
    """After 60 requests the 61st should be rate-limited."""
    # Use a fresh install_id so this test is isolated
    req = {**_BASE_REQUEST, "install_id": "rate-limit-test-install"}
    # Drain most responses quickly (don't collect body, just fire)
    for _ in range(60):
        async with client.stream("POST", "/analyse", json=req) as resp:
            assert resp.status_code == 200

    resp_61 = await client.post("/analyse", json=req)
    assert resp_61.status_code == 429


# ---------------------------------------------------------------------------
# /flag/company-match
# ---------------------------------------------------------------------------

async def test_flag_company_match(
    client: AsyncClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("FLAGS_DB", str(tmp_path / "flags.sqlite"))
    resp = await client.post(
        "/flag/company-match",
        json={
            "brand": "Fizzwell",
            "matched_parent": "Brightwater Holdings Ltd",
            "ch_number": "01234567",
            "match_via": "Wikidata",
            "page_url": "https://example.com/product",
            "correction": "Actually owned by Aqua Corp",
        },
        headers={"X-Install-Id": "test-install-abc123"},
    )
    assert resp.status_code == 200
    assert resp.json() == {"ok": True}

    # Verify the row landed in the DB
    db = sqlite3.connect(tmp_path / "flags.sqlite")
    rows = db.execute("SELECT brand, matched_parent, correction, install_id FROM company_flags").fetchall()
    db.close()
    assert len(rows) == 1
    assert rows[0] == ("Fizzwell", "Brightwater Holdings Ltd", "Actually owned by Aqua Corp", "test-install-abc123")


async def test_flag_company_match_no_install_id(
    client: AsyncClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Install ID is optional for the flag endpoint."""
    monkeypatch.setenv("FLAGS_DB", str(tmp_path / "flags.sqlite"))
    resp = await client.post(
        "/flag/company-match",
        json={"brand": "Acme", "page_url": "https://example.com"},
    )
    assert resp.status_code == 200
    assert resp.json() == {"ok": True}
