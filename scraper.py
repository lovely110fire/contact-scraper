import asyncio
import re
from urllib.parse import quote_plus
from playwright.async_api import (
    async_playwright,
    Browser,
    TimeoutError as PWTimeout,
)

GMAPS_URL = "https://www.google.com/maps/search/{query}?hl=en"

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/124.0.0.0 Safari/537.36"
)

BLOCKED_RESOURCES = {"image", "media", "font", "stylesheet"}

# Restart browser every N requests to prevent memory bloat on free tier.
RESTART_AFTER_REQUESTS = 8

_pw = None
_browser: Browser | None = None
_scrape_lock = asyncio.Lock()
_request_count = 0


async def startup():
    """Initialize playwright. Browser is launched lazily on first request."""
    global _pw
    _pw = await async_playwright().start()


async def shutdown():
    global _browser, _pw
    if _browser:
        try:
            await _browser.close()
        except Exception:
            pass
        _browser = None
    if _pw:
        await _pw.stop()
        _pw = None


async def _launch_browser():
    """Launch Chromium with low-memory flags (no --single-process; it crashes)."""
    return await _pw.chromium.launch(
        headless=True,
        args=[
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--disable-dev-shm-usage",
            "--disable-gpu",
            "--disable-background-networking",
            "--disable-background-timer-throttling",
            "--disable-backgrounding-occluded-windows",
            "--disable-breakpad",
            "--disable-client-side-phishing-detection",
            "--disable-component-update",
            "--disable-default-apps",
            "--disable-extensions",
            "--disable-features=TranslateUI,IsolateOrigins,site-per-process,AudioServiceOutOfProcess",
            "--disable-ipc-flooding-protection",
            "--disable-renderer-backgrounding",
            "--disable-sync",
            "--metrics-recording-only",
            "--mute-audio",
            "--hide-scrollbars",
            "--disable-blink-features=AutomationControlled",
            "--memory-pressure-off",
            "--js-flags=--max-old-space-size=256",
        ],
    )


async def _ensure_browser():
    """Make sure we have a live browser. Relaunch if dead or hit restart threshold."""
    global _browser, _request_count

    needs_restart = (
        _browser is None
        or not _browser.is_connected()
        or _request_count >= RESTART_AFTER_REQUESTS
    )

    if needs_restart:
        if _browser is not None:
            try:
                await _browser.close()
            except Exception:
                pass
            _browser = None
        _request_count = 0
        _browser = await _launch_browser()

    _request_count += 1
    return _browser


async def _block_heavy(route):
    if route.request.resource_type in BLOCKED_RESOURCES:
        await route.abort()
    else:
        await route.continue_()


async def _new_context(browser):
    return await browser.new_context(
        user_agent=USER_AGENT,
        viewport={"width": 1366, "height": 900},
        locale="en-US",
    )


async def _dismiss_consent(page):
    try:
        await page.get_by_role(
            "button", name=re.compile("Accept all", re.I)
        ).click(timeout=3000)
    except Exception:
        pass


# ---------- STAGE 1: collect profile links ----------

async def collect_links(query: str, max_results: int = 100, max_scrolls: int = 40):
    async with _scrape_lock:
        browser = await _ensure_browser()
        context = await _new_context(browser)
        try:
            page = await context.new_page()
            await page.route("**/*", _block_heavy)

            url = GMAPS_URL.format(query=quote_plus(query))
            await page.goto(url, wait_until="domcontentloaded", timeout=30000)
            await _dismiss_consent(page)

            if "/maps/place/" in page.url:
                return [page.url]

            feed_selector = 'div[role="feed"]'
            try:
                await page.wait_for_selector(feed_selector, timeout=15000)
            except PWTimeout:
                return []

            last_count = 0
            stagnant = 0

            for _ in range(max_scrolls):
                await page.evaluate(
                    f"document.querySelector('{feed_selector}').scrollBy(0, 3000)"
                )
                await asyncio.sleep(1.3)

                count = await page.evaluate(
                    "document.querySelectorAll('a[href*=\"/maps/place/\"]').length"
                )

                end_marker_seen = await page.evaluate(
                    "!!document.querySelector('p.fontBodyMedium span.HlvSq')"
                )

                if count >= max_results or end_marker_seen:
                    break

                if count == last_count:
                    stagnant += 1
                    if stagnant >= 4:
                        break
                else:
                    stagnant = 0
                last_count = count

            urls = await page.evaluate(
                """() => {
                    const anchors = document.querySelectorAll('a[href*="/maps/place/"]');
                    const seen = new Set();
                    const out = [];
                    anchors.forEach(a => {
                        if (!seen.has(a.href)) {
                            seen.add(a.href);
                            out.push(a.href);
                        }
                    });
                    return out;
                }"""
            )
            return urls[:max_results]
        finally:
            try:
                await context.close()
            except Exception:
                pass


# ---------- STAGE 2: details for one profile ----------

async def _safe_text(page, selector, timeout=2500):
    try:
        return (await page.locator(selector).first.inner_text(timeout=timeout)).strip()
    except Exception:
        return None


async def _safe_attr(page, selector, attr, timeout=2500):
    try:
        return await page.locator(selector).first.get_attribute(attr, timeout=timeout)
    except Exception:
        return None


def _clean(prefix, value):
    if not value:
        return None
    return re.sub(f"^{prefix}:?\\s*", "", value).strip()


async def get_place_details(url: str):
    if "/maps/place/" not in url and "google.com/maps" not in url:
        raise ValueError("Not a Google Maps URL")

    async with _scrape_lock:
        browser = await _ensure_browser()
        context = await _new_context(browser)
        data = {"url": url}
        try:
            page = await context.new_page()
            await page.route("**/*", _block_heavy)
            await page.goto(url, wait_until="domcontentloaded", timeout=25000)
            await _dismiss_consent(page)
            await page.wait_for_selector("h1", timeout=10000)
            await asyncio.sleep(0.8)

            data["name"] = await _safe_text(page, "h1")
            data["address"] = _clean(
                "Address",
                await _safe_attr(page, 'button[data-item-id="address"]', "aria-label"),
            )
            data["phone"] = _clean(
                "Phone",
                await _safe_attr(page, 'button[data-item-id^="phone"]', "aria-label"),
            )
            data["website"] = await _safe_attr(
                page, 'a[data-item-id="authority"]', "href"
            )
            data["category"] = await _safe_text(
                page, 'button[jsaction*="category"]'
            )
            data["rating"] = await _safe_text(
                page, "div.F7nice span[aria-hidden='true']"
            )

            reviews_lbl = await _safe_attr(
                page, "div.F7nice span[aria-label*='review']", "aria-label"
            )
            if reviews_lbl:
                m = re.search(r"([\d,]+)", reviews_lbl)
                data["reviews"] = m.group(1).replace(",", "") if m else None
            else:
                data["reviews"] = None

            data["plus_code"] = _clean(
                "Plus code",
                await _safe_attr(page, 'button[data-item-id^="oloc"]', "aria-label"),
            )
            return data
        except Exception as e:
            data["error"] = str(e)
            return data
        finally:
            try:
                await context.close()
            except Exception:
                pass
