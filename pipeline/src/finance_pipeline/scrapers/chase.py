"""Chase web scraper.

Automates the "Download account activity" flow on chase.com so we don't
have to do it by hand. Auth is user-driven on first run — Playwright
opens a real browser, you log in + complete 2FA, then the script saves
the session state. Subsequent runs reuse the cookies headlessly.

Chase's UI is a React SPA with frequently-changing CSS class names. All
selectors here lean on visible text (`get_by_role`, `get_by_text`) so
they survive minor redesigns. If Chase rearranges the download flow,
re-run `finance scrape chase --login` to re-record the session, then
run `finance scrape chase --headed` to watch the flow and adjust the
selectors below.

Dependencies: Playwright is an optional install. Run
  pip install -e pipeline/.[scrape]
  playwright install chromium
before using this module.
"""

from __future__ import annotations

import sys
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path

from ..config import PROJECT_ROOT, RAW_CHASE, SECRETS_DIR
from .. import ingest

CHASE_HOME_URL = "https://secure.chase.com/web/auth/dashboard"
CHASE_LOGIN_URL = "https://secure.chase.com/web/auth/"
STORAGE_STATE_PATH = SECRETS_DIR / "chase_playwright" / "storage_state.json"
USER_DATA_DIR = SECRETS_DIR / "chase_playwright" / "profile"
SESSION_TTL_DAYS = 25  # Chase typically re-2FAs every ~30 days

# Keep one UA across login + replay. Chase fingerprints the session and
# will silently reject a cookie load that arrives under a different UA.
_UA = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"
)
_LAUNCH_ARGS = ["--disable-blink-features=AutomationControlled"]


def _launch_persistent(p, headless: bool):
    """Open a Chrome profile living in USER_DATA_DIR so cookies +
    localStorage + IndexedDB + service workers all persist between runs.
    Returns (context, cleanup_context_manager)."""
    USER_DATA_DIR.mkdir(parents=True, exist_ok=True)
    # Prefer system Chrome (channel=chrome) over Playwright's headless
    # Chromium, which Chase detects.
    kwargs: dict[str, object] = {
        "headless": headless,
        "args": _LAUNCH_ARGS,
        "user_agent": _UA,
        "viewport": {"width": 1440, "height": 900},
        "locale": "en-US",
        "accept_downloads": True,
    }
    try:
        return p.chromium.launch_persistent_context(
            str(USER_DATA_DIR), channel="chrome", **kwargs
        )
    except Exception:
        return p.chromium.launch_persistent_context(
            str(USER_DATA_DIR), **kwargs
        )


@dataclass
class ScrapeStats:
    accounts_visited: int = 0
    files_downloaded: int = 0
    files_failed: list[str] = field(default_factory=list)
    ingested: dict[str, int] = field(default_factory=dict)

    def as_dict(self) -> dict[str, object]:
        return {
            "accounts_visited": self.accounts_visited,
            "files_downloaded": self.files_downloaded,
            "files_failed": self.files_failed,
            "ingested": self.ingested,
        }


def _require_playwright():
    try:
        from playwright.sync_api import sync_playwright  # noqa: F401
    except ImportError:
        print(
            "playwright not installed. Install with:\n"
            "  pip install -e pipeline/.[scrape]\n"
            "  playwright install chromium",
            file=sys.stderr,
        )
        raise SystemExit(1)


def _profile_fresh() -> bool:
    """Profile is considered fresh if the profile dir exists and has
    been touched within the TTL."""
    if not USER_DATA_DIR.exists():
        return False
    # Use the Cookies file as the freshness signal — Chrome updates it
    # on every authenticated navigation.
    cookies = USER_DATA_DIR / "Default" / "Cookies"
    target = cookies if cookies.exists() else USER_DATA_DIR
    age = datetime.now(tz=timezone.utc) - datetime.fromtimestamp(
        target.stat().st_mtime, tz=timezone.utc
    )
    return age < timedelta(days=SESSION_TTL_DAYS)


def login_interactive() -> None:
    """Open a real browser using a persistent profile; let the user log
    in + 2FA. Everything (cookies, localStorage, IndexedDB, service
    workers) stays in USER_DATA_DIR, so subsequent headless runs can
    reuse the full authenticated state — which cookie-only
    storage_state.json couldn't carry across."""
    _require_playwright()
    from playwright.sync_api import sync_playwright

    with sync_playwright() as p:
        context = _launch_persistent(p, headless=False)
        page = context.pages[0] if context.pages else context.new_page()
        page.goto(CHASE_LOGIN_URL)
        print(
            "Log in to Chase in the browser window, complete 2FA if prompted,\n"
            "wait for the dashboard to fully render, then return here and "
            "press Enter.",
        )
        try:
            input("> ")
        except EOFError:
            pass
        context.close()
    print(f"session profile saved at {USER_DATA_DIR}")


# TODO Chase UI selectors — placeholders tuned for the public dashboard
# as of early 2026. Re-run `finance scrape chase --headed` whenever Chase
# redesigns; the log below prints which step failed.
ACCOUNT_TILE_ROLE = "link"
DOWNLOAD_BUTTON_TEXT = "Download account activity"
DATE_RANGE_OPTION_TEXT = "Choose a date range"
FORMAT_SELECT_LABEL = "File type"
SUBMIT_BUTTON_TEXT = "Download"


def scrape_all(
    headed: bool = True,
    days: int = 730,
    ingest_after: bool = True,
    only_suffixes: list[str] | None = None,
) -> ScrapeStats:
    """Headless run: visits every Chase account tile on the dashboard,
    downloads its max-window activity, saves the file to raw/chase/ and
    (optionally) runs ingest_chase_statements on it."""
    _require_playwright()
    from playwright.sync_api import TimeoutError as PwTimeout
    from playwright.sync_api import sync_playwright

    stats = ScrapeStats()

    if not _profile_fresh():
        print(
            "No fresh Chase profile. Run `finance scrape chase --login` first.",
            file=sys.stderr,
        )
        return stats

    RAW_CHASE.mkdir(parents=True, exist_ok=True)
    today_iso = datetime.now(tz=timezone.utc).date().isoformat()

    with sync_playwright() as p:
        context = _launch_persistent(p, headless=not headed)
        context.add_init_script(
            "Object.defineProperty(navigator,'webdriver',{get:()=>undefined})"
        )
        page = context.pages[0] if context.pages else context.new_page()

        try:
            page.goto(CHASE_HOME_URL, wait_until="networkidle", timeout=60_000)
        except PwTimeout:
            print("dashboard didn't load in time — session likely expired")
            browser.close()
            return stats

        # Wait for the authenticated dashboard shell. Chase's dashboard
        # renders client-side, so networkidle alone can fire before tiles
        # mount. If we see the login form instead, the saved session is
        # stale and the user needs to re-run `--login`.
        try:
            page.wait_for_selector(
                "input[name='userId'], [data-testid='account-tile']",
                state="visible",
                timeout=20_000,
            )
        except PwTimeout:
            pass
        if "auth/logon" in page.url or "signin" in page.url.lower():
            print(
                "  stopped on login page — session cookies are stale or "
                "Chase wants fresh 2FA. Re-run `scrape chase --login`."
            )
            browser.close()
            return stats

        # Diagnostic dump so we can tell login-page vs dashboard from one run.
        print(f"  landed at: {page.url}")
        print(f"  title: {page.title()}")
        debug_dir = PROJECT_ROOT / ".secrets" / "chase_playwright" / "debug"
        debug_dir.mkdir(parents=True, exist_ok=True)
        try:
            page.screenshot(path=str(debug_dir / "dashboard.png"), full_page=True)
            (debug_dir / "dashboard.html").write_text(page.content())
            print(f"  snapshot: {debug_dir}")
        except Exception as e:
            print(f"  could not snapshot: {e}")

        # Enumerate accounts by grabbing every dashboard tile that links
        # to an account detail page. Chase's tile text usually includes
        # the account nickname plus the last 4 digits in parentheses.
        account_links = page.get_by_role(ACCOUNT_TILE_ROLE).filter(
            has_text=r"\((\d{4})\)"
        )
        count = account_links.count()
        tiles: list[tuple[str, str]] = []
        for i in range(count):
            el = account_links.nth(i)
            label = (el.inner_text() or "").strip()
            href = el.get_attribute("href") or ""
            # Grab the trailing 4-digit suffix out of the tile label.
            import re as _re
            m = _re.search(r"\((\d{3,})\)", label)
            if not m:
                continue
            suffix = m.group(1)
            if only_suffixes and suffix not in only_suffixes:
                continue
            tiles.append((suffix, href))

        print(f"found {len(tiles)} Chase account tile(s)")
        for suffix, href in tiles:
            stats.accounts_visited += 1
            try:
                download_path = _download_one_account(
                    page, suffix, href, today_iso, days
                )
            except Exception as e:
                print(f"  {suffix}: scrape error — {e}")
                stats.files_failed.append(suffix)
                continue
            if download_path:
                stats.files_downloaded += 1
                print(f"  {suffix}: saved {download_path.name}")

        context.close()

    if ingest_after and stats.files_downloaded:
        print("\ningesting downloaded statements...")
        counts = ingest.ingest_chase_statements()
        stats.ingested = counts.as_dict()

    return stats


def _download_one_account(
    page, suffix: str, href: str, today_iso: str, days: int
) -> Path | None:
    """Drive the download flow for one account. Returns the saved path
    or None if we bailed out. Raises on unrecoverable errors."""
    from playwright.sync_api import TimeoutError as PwTimeout

    target = href if href.startswith("http") else f"https://secure.chase.com{href}"
    page.goto(target, wait_until="networkidle", timeout=60_000)

    # Open the activity-download dialog. Chase sometimes wraps this in
    # a "More" menu on narrow viewports — try the direct button first.
    download_btn = page.get_by_role("button", name=DOWNLOAD_BUTTON_TEXT).first
    try:
        download_btn.click(timeout=15_000)
    except PwTimeout:
        # Fallback: open a menu and click the download entry inside.
        page.get_by_role("button", name="More").first.click(timeout=10_000)
        page.get_by_text(DOWNLOAD_BUTTON_TEXT, exact=False).first.click(timeout=10_000)

    # Pick "Choose a date range" + fill in [today - days, today].
    try:
        page.get_by_text(DATE_RANGE_OPTION_TEXT, exact=False).first.click(timeout=10_000)
    except PwTimeout:
        pass  # Some account types jump straight to the date inputs.

    start = (
        datetime.now(tz=timezone.utc).date() - timedelta(days=days)
    ).strftime("%m/%d/%Y")
    end = datetime.now(tz=timezone.utc).date().strftime("%m/%d/%Y")
    # Chase labels the two inputs "From" and "To". Best-effort fill.
    try:
        page.get_by_label("From").fill(start, timeout=5_000)
        page.get_by_label("To").fill(end, timeout=5_000)
    except PwTimeout:
        pass

    # Pick the file format: QFX for bank accounts, CSV for cards (Chase
    # sometimes doesn't offer QFX for credit). Fall through to whatever's
    # selected if neither option is exposed.
    for preferred in ("QFX", "CSV"):
        try:
            page.get_by_label(FORMAT_SELECT_LABEL).select_option(label=preferred, timeout=3_000)
            break
        except PwTimeout:
            continue
        except Exception:
            continue

    # Trigger download + capture the file.
    with page.expect_download(timeout=60_000) as dl_info:
        page.get_by_role("button", name=SUBMIT_BUTTON_TEXT).first.click()
    download = dl_info.value

    suggested = download.suggested_filename or f"{suffix}.qfx"
    ext = Path(suggested).suffix or ".qfx"
    dst = RAW_CHASE / f"{today_iso}_{suffix}{ext}"
    download.save_as(str(dst))
    # Also write companion CSVs with the suffix embedded in the filename
    # so the CSV ingest branch can discover the acctid.
    return dst


def print_report(stats: ScrapeStats) -> None:
    print()
    print(
        f"accounts visited: {stats.accounts_visited}  "
        f"downloaded: {stats.files_downloaded}"
    )
    if stats.files_failed:
        print(f"failed: {', '.join(stats.files_failed)}")
    if stats.ingested:
        print(
            "ingest: "
            + ", ".join(f"{k}={v}" for k, v in stats.ingested.items())
        )
