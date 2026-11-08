"""Company deep search (ADR 0003).  Network calls faked at the httpx transport boundary.

Done when:
  * A brand that is the company itself (Microsoft) is kept as its own owner.
  * The UK company named exactly after the owner gives the CH number, from Companies
    House or the records index, and only when exactly one company fits.
  * The owner's official name, and its name without the legal form, reach the
    name-keyed (ethics) records.
  * A company named after the brand plus more words is taken only from the page's own site.
  * Off (the default), nothing changes; subsidiaries are still never walked.
"""
from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from smallprint.asa import ASA_SEARCH_URL
from smallprint.company import _is_legal_entity, _uk_company_fits, company_lookup
from smallprint.test_company import (
    _GLEIF_AUTOCOMPLETE_EMPTY,
    _claim,
    _client,
    _entity,
    _item_claim,
    _search_hits,
    _wikidata,
)

_MSFT_LEI = "INR2EJN1ERAN0W5ZP974"
_APPLE_LEI = "HWUPKR0MPOU8FGXBT394"


def _official(name: str) -> dict:
    return _claim("P1448", {"text": name, "language": "en"})


_MICROSOFT = _wikidata(
    _search_hits(("Q2283", "Microsoft"), ("Q1406", "Microsoft Windows")),
    {
        # No parent, no UK number, many shareholders: the brand is the company.
        "Q2283": _entity("Q2283", "Microsoft", _claim("P856", "https://www.microsoft.com/"),
                         _claim("P1278", _MSFT_LEI), _official("Microsoft Corporation"),
                         _item_claim("P127", "Q1"), _item_claim("P127", "Q2")),
        "Q1406": _entity("Q1406", "Microsoft Windows", _claim("P856", "https://www.microsoft.com/windows")),
    },
)

_ROUTES_MSFT = {
    "https://www.wikidata.org": _MICROSOFT,
    f"https://api.gleif.org/api/v1/lei-records/{_MSFT_LEI}": None,  # 404: no UK record of its own
    "https://api.gleif.org": _GLEIF_AUTOCOMPLETE_EMPTY,
}

_URL = "https://www.microsoft.com/en-gb/microsoft-365/buy/compare-all-microsoft-365-products"


@pytest.fixture()
def db(tmp_path) -> Path:
    p = tmp_path / "records.sqlite"
    con = sqlite3.connect(p)
    con.execute("""CREATE TABLE records (
        id INTEGER PRIMARY KEY, ch_number TEXT, company_name TEXT,
        kind TEXT, date TEXT, summary TEXT, source_url TEXT)""")
    con.executemany(
        "INSERT INTO records (ch_number, company_name, kind, date, summary, source_url) VALUES (?,?,?,?,?,?)",
        [
            ("01624297", "MICROSOFT LIMITED", "gender_pay_gap", "2026-04-03",
             "Mean gender pay gap of 6.4% in favour of men (2025 to 2026 reporting year).", "https://gpg.example/msft"),
            ("01624297", "Microsoft Limited", "donation", "2024-04-30",
             "Donated £30,000.00 to Labour Party (accepted 30/04/2024).", "https://ec.example/1"),
            # Extra words: another company, never the one behind the brand.
            ("07777777", "MICROSOFT RESEARCH LIMITED", "gender_pay_gap", "2025-01-01",
             "Mean gender pay gap of 1.0% in favour of men.", "https://gpg.example/msr"),
            (None, "Microsoft Corporation", "climate", "2020-01-01",
             "Has a Science Based Targets initiative (SBTi) validated near-term emissions reduction target.",
             "https://sciencebasedtargets.org/"),
            (None, "MICROSOFT CORP", "climate", "2021-02-02",
             "Has a validated net-zero target.", "https://sciencebasedtargets.org/"),
            (None, "Microsoft Corp Foundation", "climate", "2022-03-03",
             "Not the same organisation.", "https://sciencebasedtargets.org/"),
        ],
    )
    con.commit()
    con.close()
    return p


# ---------------------------------------------------------------------------
# Name rules
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("name,fits", [
    ("MICROSOFT LIMITED", True),
    ("Microsoft Ltd", True),
    ("Microsoft UK Limited", True),
    ("Microsoft (U.K.) Limited", True),
    ("MICROSOFT PUBLIC LIMITED COMPANY", True),
    ("MICROSOFT RESEARCH LIMITED", False),
    ("Microsoft Corporation", False),        # not a UK legal form
    ("Microsoft", False),                    # no legal form at all
    ("Microsofty Limited", False),
    ("PepsiCo UK Pension Plan Trustee Limited", False),
])
def test_uk_company_fits(name, fits):
    cores = ("microsoft", "pepsico")
    assert _uk_company_fits(name, cores) is fits


def test_legal_entity_needs_an_lei_or_a_legal_form_in_its_official_name():
    assert _is_legal_entity(_entity("Q1", "Microsoft", _claim("P1278", _MSFT_LEI)))
    assert _is_legal_entity(_entity("Q1", "Microsoft", _official("Microsoft Corporation")))
    assert not _is_legal_entity(_entity("Q1", "iOS", _official("iOS")))
    assert not _is_legal_entity(_entity("Q1", "Some product", _claim("P856", "https://x.example/")))


# ---------------------------------------------------------------------------
# The Microsoft page
# ---------------------------------------------------------------------------

async def test_off_by_default_nothing_changes(db):
    http, _ = _client(_ROUTES_MSFT)
    async with http:
        result = await company_lookup("Microsoft", _URL, http=http, db_path=db, ch_api_key="")
    assert result["match_via"] == "Brand not identified" and result["records"] == []


async def test_brand_that_is_the_company_gets_its_uk_company_and_records(db):
    http, _ = _client(_ROUTES_MSFT)
    async with http:
        result = await company_lookup("Microsoft", _URL, http=http, db_path=db, ch_api_key="", deep_search=True)
    assert result["parent"] == "Microsoft Corporation"
    assert result["ch_number"] == "01624297"
    assert result["match_via"] == "Wikidata; deep search: UK company named after it (records index): MICROSOFT LIMITED"
    summaries = [r["summary"] for r in result["records"]]
    assert any("6.4%" in s for s in summaries)                       # CH-keyed: pay gap
    assert any("Labour Party" in s for s in summaries)               # CH-keyed: donation
    assert any("near-term" in s for s in summaries)                  # exact official name
    assert any("net-zero" in s for s in summaries)                   # "MICROSOFT CORP", legal form ignored
    assert not any("Not the same organisation" in s for s in summaries)
    assert not any("1.0%" in s for s in summaries)                   # Microsoft Research is not used
    assert [r["date"] for r in result["records"]] == sorted((r["date"] for r in result["records"]), reverse=True)


async def test_two_fitting_uk_companies_are_ambiguous(db):
    con = sqlite3.connect(db)
    con.execute("INSERT INTO records (ch_number, company_name, kind, date, summary, source_url) VALUES (?,?,?,?,?,?)",
                ("08888888", "MICROSOFT UK LIMITED", "modern_slavery", "2025-05-05", "Published a statement.", "https://x.example/"))
    con.commit()
    con.close()
    http, _ = _client(_ROUTES_MSFT)
    async with http:
        result = await company_lookup("Microsoft", _URL, http=http, db_path=db, ch_api_key="", deep_search=True)
    assert result["ch_number"] is None
    assert result["parent"] == "Microsoft Corporation"               # the owner is still shown
    assert {r["kind"] for r in result["records"]} == {"climate"}     # its name-keyed records too


async def test_companies_house_gives_the_uk_company_when_a_key_is_set(db):
    routes = {
        "https://api.company-information.service.gov.uk": {"items": [
            {"title": "MICROSOFT RESEARCH LIMITED", "company_number": "07777777", "company_status": "active"},
            {"title": "MICROSOFT LIMITED", "company_number": "01624297", "company_status": "active"},
            {"title": "MICROSOFT UK LIMITED", "company_number": "09999999", "company_status": "dissolved"},
        ]},
        **_ROUTES_MSFT,
    }
    http, _ = _client(routes)
    async with http:
        result = await company_lookup("Microsoft", _URL, http=http, db_path=db, ch_api_key="k", deep_search=True)
    assert result["ch_number"] == "01624297"
    assert result["match_via"].endswith("deep search: UK company named after it (Companies House): MICROSOFT LIMITED")


async def test_asa_rulings_are_looked_up_for_a_known_owner_without_a_uk_number(db):
    empty_db = db.parent / "empty.sqlite"
    sqlite3.connect(empty_db).execute(
        "CREATE TABLE records (id INTEGER PRIMARY KEY, ch_number TEXT, company_name TEXT, "
        "kind TEXT, date TEXT, summary TEXT, source_url TEXT)").connection.commit()
    http, transport = _client(_ROUTES_MSFT)
    async with http:
        result = await company_lookup("Microsoft", _URL, http=http, db_path=empty_db, ch_api_key="", deep_search=True)
    assert result["parent"] == "Microsoft Corporation" and result["ch_number"] is None
    assert any(u.startswith(ASA_SEARCH_URL) for u in transport.calls)


async def test_a_product_item_is_not_its_own_owner(db):
    product = _wikidata(
        _search_hits(("Q9", "Fernly Fizz")),
        {"Q9": _entity("Q9", "Fernly Fizz", _claim("P856", "https://fernlyfizz.example/"), _official("Fernly Fizz"))},
    )
    http, _ = _client({"https://www.wikidata.org": product, "https://api.gleif.org": _GLEIF_AUTOCOMPLETE_EMPTY})
    async with http:
        result = await company_lookup("Fernly Fizz", "fernlyfizz.example", http=http, db_path=db, ch_api_key="",
                                      deep_search=True)
    assert result["match_via"] == "Brand not identified"


# ---------------------------------------------------------------------------
# Brand name plus more words: only from the page's own site
# ---------------------------------------------------------------------------

def _apple():
    return _wikidata(
        {"search": [
            {"id": "Q89", "label": "apple", "match": {"type": "label", "text": "apple"}},
            {"id": "Q312", "label": "Apple Inc.", "match": {"type": "label", "text": "Apple Inc."}},
            {"id": "Q270285", "label": "Apple TV", "match": {"type": "label", "text": "Apple TV"}},
            {"id": "Q48493", "label": "iOS", "match": {"type": "alias", "text": "Apple iOS"}},
        ]},
        {
            "Q89": _entity("Q89", "apple"),
            "Q312": _entity("Q312", "Apple Inc.", _claim("P856", "https://www.apple.com/"),
                            _claim("P1278", _APPLE_LEI), _official("Apple Inc.")),
            "Q270285": _entity("Q270285", "Apple TV", _claim("P856", "https://www.apple.com/tv/")),
            "Q48493": _entity("Q48493", "iOS", _claim("P856", "https://www.apple.com/"), _claim("P1278", "X" * 18 + "00")),
        },
    )


async def test_company_from_the_pages_own_site(db):
    con = sqlite3.connect(db)
    con.execute("INSERT INTO records (ch_number, company_name, kind, date, summary, source_url) VALUES (?,?,?,?,?,?)",
                ("01591116", "APPLE (UK) LIMITED", "gender_pay_gap", "2026-03-01", "Mean gender pay gap of 9.0%.", "https://x/"))
    con.commit()
    con.close()
    http, _ = _client({"https://www.wikidata.org": _apple(),
                       f"https://api.gleif.org/api/v1/lei-records/{_APPLE_LEI}": None,
                       "https://api.gleif.org": _GLEIF_AUTOCOMPLETE_EMPTY})
    async with http:
        result = await company_lookup("Apple", "https://www.apple.com/uk/", http=http, db_path=db, ch_api_key="",
                                      deep_search=True)
    assert result["parent"] == "Apple Inc."
    assert result["ch_number"] == "01591116"
    assert result["match_via"].startswith("Wikidata, from the page's own website")


async def test_a_subdomain_page_counts_but_another_site_does_not(db):
    for url, found in (("https://store.apple.com/uk", True), ("https://www.amazon.co.uk/dp/X", False)):
        http, _ = _client({"https://www.wikidata.org": _apple(),
                           f"https://api.gleif.org/api/v1/lei-records/{_APPLE_LEI}": None,
                           "https://api.gleif.org": _GLEIF_AUTOCOMPLETE_EMPTY})
        async with http:
            result = await company_lookup("Apple", url, http=http, db_path=db, ch_api_key="", deep_search=True)
        assert (result["parent"] == "Apple Inc.") is found, url


async def test_page_site_rule_stays_off_without_deep_search(db):
    http, _ = _client({"https://www.wikidata.org": _apple(), "https://api.gleif.org": _GLEIF_AUTOCOMPLETE_EMPTY})
    async with http:
        result = await company_lookup("Apple", "https://www.apple.com/uk/", http=http, db_path=db, ch_api_key="")
    assert result["match_via"] == "Brand not identified"


# ---------------------------------------------------------------------------
# Unchanged safeguards
# ---------------------------------------------------------------------------

async def test_deep_search_never_walks_subsidiaries(db):
    """The Walkers false match (a pension trustee) must not come back through deep search."""
    pepsi_max = _wikidata(
        _search_hits(("Q100", "Pepsi Max")),
        {
            "Q100": _entity("Q100", "Pepsi Max", _item_claim("P176", "Q200"), _claim("P856", "https://www.pepsimax.co.uk/")),
            "Q200": _entity("Q200", "PepsiCo", _claim("P856", "https://www.pepsico.com/"), _item_claim("P355", "Q300")),
            "Q300": _entity("Q300", "PepsiCo UK Pension Plan Trustee Limited", _claim("P2622", "02484669")),
        },
    )
    con = sqlite3.connect(db)
    con.execute("INSERT INTO records (ch_number, company_name, kind, date, summary, source_url) VALUES (?,?,?,?,?,?)",
                ("02484669", "PEPSICO UK PENSION PLAN TRUSTEE LIMITED", "gender_pay_gap", "2025-01-01", "x", "https://x/"))
    con.commit()
    con.close()
    http, transport = _client({"https://www.wikidata.org": pepsi_max, "https://api.gleif.org": _GLEIF_AUTOCOMPLETE_EMPTY})
    async with http:
        result = await company_lookup("Pepsi Max", "amazon.co.uk", http=http, db_path=db, ch_api_key="",
                                      deep_search=True)
    assert result["parent"] == "PepsiCo" and result["ch_number"] is None
    assert not any("Q300" in u for u in transport.calls)


async def test_undated_records_stay_out_with_deep_search(db):
    con = sqlite3.connect(db)
    con.execute("INSERT INTO records (ch_number, company_name, kind, date, summary, source_url) VALUES (?,?,?,?,?,?)",
                (None, "MICROSOFT CORP", "abortion_rights", None, "Listed by ...", None))
    con.commit()
    con.close()
    http, _ = _client(_ROUTES_MSFT)
    async with http:
        result = await company_lookup("Microsoft", _URL, http=http, db_path=db, ch_api_key="", deep_search=True)
    assert all(r["date"] for r in result["records"])
    assert "abortion_rights" not in {r["kind"] for r in result["records"]}
