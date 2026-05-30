"""Best-effort location extraction from transaction descriptions.

Bank-feed descriptions sometimes embed city/state hints
(e.g., "ROGER BEASLEY SOUTH AUSTIN TX 03/26", "BANFF SPRINGS HOTEL CORP",
"PORSCHE SOUTH AUSTIN", "MONOD SPORTS BANFF"). This module pulls those
hints out so trip detection and the spending UI can use them.

This is intentionally a heuristic, not a geocoder. Output is a free-text
"city" or "city, ST" string used as a hint. Real geocoding (Nominatim or
similar) is a separate concern, deferred.

Strategy:
1. First pass: trailing US state code regex. If we see "...SOMETHING TX" or
   "...SOMETHING CA 02/04", grab the state and the words leading up to it.
2. Second pass: known place tokens (curated set). If a description contains
   "BANFF", "WHISTLER", etc., return the title-case form.
3. Otherwise return None.
"""
from __future__ import annotations

import re

# Two-letter US state codes. Word-bounded to avoid false matches.
US_STATES = (
    "AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN "
    "MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA "
    "WA WV WI WY DC"
).split()

# Match "CITY WORDS XX" where XX is a state code that is NOT followed by a
# colon (ruling out payment-routing patterns like "WEB ID:", "ACH PMT ID:")
# and NOT immediately preceded by "WEB" / "PAYROLL" / "AUTOPAY" / etc.
STATE_RE = re.compile(
    r"\b([A-Z][A-Z &.'-]{2,30}?)\s+(" + "|".join(US_STATES) + r")\b(?![:.])"
)

# City-word tokens that signal a payment-routing pattern, not a real address.
PAYMENT_NOISE = {
    "WEB", "PPD", "ACH", "PMT", "PYMT", "AUTOPAY", "PAYROLL", "NOC",
    "RECC", "REM", "ID", "REF", "TRACE", "CRD", "CCD",
}

# Curated set of place tokens we recognize. Grows as the user travels.
# Stored uppercase; matched case-insensitively.
KNOWN_PLACES = {
    # Canadian travel destinations
    "BANFF", "WHISTLER", "TORONTO", "VANCOUVER", "MONTREAL", "CALGARY",
    "JASPER", "QUEBEC",
    # US destinations
    "AUSTIN", "DALLAS", "HOUSTON", "SAN ANTONIO", "DENVER", "BOULDER",
    "SEATTLE", "PORTLAND", "BEND", "VEGAS", "RENO", "TAHOE",
    "MIAMI", "ORLANDO", "TAMPA",
    "NYC", "BOSTON", "PHILADELPHIA", "CHICAGO", "DETROIT",
    "NASHVILLE", "MEMPHIS", "ATLANTA", "CHARLESTON", "SAVANNAH",
    "HONOLULU", "MAUI", "KAUAI", "OAHU",
    "JACKSON", "ASPEN", "VAIL", "BRECKENRIDGE", "PARK CITY",
    "NEW ORLEANS",
    # International
    "LONDON", "PARIS", "TOKYO", "OSAKA", "KYOTO", "BERLIN", "MUNICH",
    "ROME", "MILAN", "FLORENCE", "VENICE", "BARCELONA", "MADRID",
    "AMSTERDAM", "DUBLIN", "REYKJAVIK", "OSLO", "STOCKHOLM",
    "DUBAI", "SINGAPORE", "BANGKOK", "HONG KONG", "SEOUL", "TAIPEI",
    "MEXICO CITY", "CDMX", "OAXACA",
}

# Words to ignore when matching against KNOWN_PLACES — common merchant
# prefixes/suffixes that would otherwise cause false matches.
IGNORE_WORDS = {
    "HOTEL", "MOTEL", "INN", "RESORT", "LODGE", "CABIN",
    "AIRPORT", "AIRLINES", "AIRLINE", "AIR",
    "CORP", "INC", "LLC", "LTD", "CO",
    "RENTAL", "RENTALS", "SPORTS", "OUTFITTERS", "GEAR",
    "RESTAURANT", "CAFE", "BAR", "GRILL", "BISTRO", "DINER",
    "STORE", "SHOP", "MARKET", "MART",
}


def extract_location(description: str | None, payee: str | None = None) -> str | None:
    """Return a 'City' or 'City, ST' hint, or None if no location is found.

    Searches the description (preferred) and falls back to payee.
    """
    candidates = [s for s in (description, payee) if s]
    if not candidates:
        return None

    for text in candidates:
        # Pass 1: trailing state code
        m = STATE_RE.search(text)
        if m:
            city_words = m.group(1).strip()
            state = m.group(2)
            # Reject if any city token looks like payment-routing noise.
            tokens = set(re.findall(r"[A-Z]+", city_words))
            if not (tokens & PAYMENT_NOISE):
                city = re.sub(r"\b(AT|IN|FOR|FROM)\b", "", city_words).strip()
                if city and len(city) >= 3:
                    return f"{city.title()}, {state}"

        # Pass 2: known place tokens. Need to match a multi-word place too.
        upper = text.upper()
        for place in KNOWN_PLACES:
            if re.search(rf"\b{re.escape(place)}\b", upper):
                return place.title()

    return None
