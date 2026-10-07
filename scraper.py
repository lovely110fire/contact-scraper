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

_pw = None
_browser: Browser | None = None
_scrape_lock = asyncio.Lock()  # 512 MB RAM = one scrape at a time


async def startup():
    global _pw, _browser
    _pw = await async_playwright().start()
    _browser = await _pw.chromium.launch(
        headless=True,
        args=[
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--disable-dev-shm-usage",
            "--disable-gpu",
            "--single-process",
            "--no-zygote",
            "--disable-background-networking",
            "--disable-background-timer-throttling",
            "--disable-backgrounding-occluded-windows",
            "--disable-breakpad",
            "--disable-client-side-phishing-detection",
            "--disable-component-update",
            "--disable-default-apps",
            "--disable-extensions",
            "--disable-features=TranslateUI,IsolateOrigins,site-per-process",
            "--disable-ipc-flooding-protection",
            "--disable-renderer-backgrounding",
            "--disable-sync",
            "--metrics-recording-only",
            "--mute-audio",
            "--hide-scrollbars",
            "--disable-blink-features=AutomationControlled",
        ],
    )


async def shutdown():
    global _browser, _pw
    if _browser:
        await _browser.close()
        _browser = None
    if _pw:
        await _pw.stop()
        _pw = None


async def _block_heavy(route):
    if route.request.resource_type in BLOCKED_RESOURCES:
        await route.abort()
    else:
        await route.continue_()


async def _new_context():
    return await _browser.new_context(
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
    """Return a de-duplicated list of Google Maps place URLs for a query."""
    if _browser is None:
        raise RuntimeError("Browser not started.")

    async with _scrape_lock:
        context = await _new_context()
        try:
            page = await context.new_page()
            await page.route("**/*", _block_heavy)

            url = GMAPS_URL.format(query=quote_plus(query))
            await page.goto(url, wait_until="domcontentloaded", timeout=30000)
            await _dismiss_consent(page)

            # If Google landed us directly on a place page, return just that one.
            if "/maps/place/" in page.url:
                return [page.url]

            feed_selector = 'div[role="feed"]'
            try:
                await page.wait_for_selector(feed_selector, timeout=15000)
            except PWTimeout:
                return []

            last_count = 0
            stagnant = 0
            end_marker_seen = False

            for _ in range(max_scrolls):
                await page.evaluate(
                    f"document.querySelector('{feed_selector}').scrollBy(0, 3000)"
                )
                await asyncio.sleep(1.3)

                count = await page.evaluate(
                    "document.querySelectorAll('a[href*=\"/maps/place/\"]').length"
                )

                # Google shows "You've reached the end of the list" when done.
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
            await context.close()


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
    """Open one Google Maps place URL and extract its details."""
    if _browser is None:
        raise RuntimeError("Browser not started.")

    if "/maps/place/" not in url and "google.com/maps" not in url:
        raise ValueError("Not a Google Maps URL")

    async with _scrape_lock:
        context = await _new_context()
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
            await context.close()
