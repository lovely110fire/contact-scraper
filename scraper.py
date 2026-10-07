import asyncio
import gc
import re
from urllib.parse import quote_plus
from playwright.async_api import async_playwright, TimeoutError as PWTimeout

GMAPS_URL = "https://www.google.com/maps/search/{query}?hl=en"

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/124.0.0.0 Safari/537.36"
)

BLOCKED_RESOURCES = {"image", "media", "font", "stylesheet"}

# Hard ceiling per request. If we blow this, Render returns 520.
# Keep comfortably under Render's 100s HTTP timeout.
LINKS_TIMEOUT = 85
DETAILS_TIMEOUT = 40

_scrape_lock = asyncio.Lock()

CHROMIUM_ARGS = [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-dev-shm-usage",
    "--disable-gpu",
    "--disable-software-rasterizer",
    "--disable-background-networking",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-breakpad",
    "--disable-client-side-phishing-detection",
    "--disable-component-update",
    "--disable-default-apps",
    "--disable-extensions",
    "--disable-features=TranslateUI,IsolateOrigins,site-per-process,AudioServiceOutOfProcess,Translate",
    "--disable-ipc-flooding-protection",
    "--disable-renderer-backgrounding",
    "--disable-sync",
    "--disable-notifications",
    "--metrics-recording-only",
    "--mute-audio",
    "--hide-scrollbars",
    "--disable-blink-features=AutomationControlled",
    "--js-flags=--max-old-space-size=180",
    "--renderer-process-limit=1",
]


async def startup():
    pass


async def shutdown():
    pass


async def _block_heavy(route):
    if route.request.resource_type in BLOCKED_RESOURCES:
        await route.abort()
    else:
        await route.continue_()


async def _dismiss_consent(page):
    try:
        await page.get_by_role(
            "button", name=re.compile("Accept all", re.I)
        ).click(timeout=3000)
    except Exception:
        pass


def _normalize_place_url(url: str) -> str:
    """
    Transform a search-feed /maps/place/ URL into the canonical direct-link
    form that renders as a standalone place page.

    Three changes:
    1. Insert /@lat,lng,17z/ segment if missing (coords come from !3d/!4d).
    2. Strip the trailing !19sChIJ... segment, which tells Google to render
       inside a search-results layout (where h1 is hidden).
    3. Drop search-feed query params like ?authuser=0&rclk=1 for the same
       reason.
    """
    # 1. Add /@lat,lng,17z/
    if "/@" not in url:
        m = re.search(r"!3d(-?\d+\.?\d*)!4d(-?\d+\.?\d*)", url)
        if m:
            lat, lng = m.group(1), m.group(2)
            url = re.sub(r"/data=", f"/@{lat},{lng},17z/data=", url, count=1)

    # 2. Separate path and query, work on path.
    path, _sep, _query = url.partition("?")

    # 3. Remove !19s<cid> segment and decrement the enclosing counts
    #    (!4m7!3m6 → !4m6!3m5, !4m8!3m7 → !4m7!3m6, etc.).
    if "!19s" in path:
        path = re.sub(r"!19s[^!]+", "", path)
        path = re.sub(
            r"!4m(\d+)!3m(\d+)",
            lambda m: f"!4m{int(m.group(1)) - 1}!3m{int(m.group(2)) - 1}",
            path,
            count=1,
        )

    # 4. Drop the query string entirely — it only carries search-feed state.
    return path


async def _run_in_fresh_browser(work, timeout_s: int):
    """Launch Chromium, run work, tear everything down. Hard timeout."""
    async with _scrape_lock:
        async with async_playwright() as pw:
            browser = await pw.chromium.launch(headless=True, args=CHROMIUM_ARGS)
            try:
                context = await browser.new_context(
                    user_agent=USER_AGENT,
                    viewport={"width": 1280, "height": 720},
                    locale="en-US",
                    java_script_enabled=True,
                )

                async def new_page():
                    p = await context.new_page()
                    await p.route("**/*", _block_heavy)
                    return p

                try:
                    return await asyncio.wait_for(
                        work(new_page, context), timeout=timeout_s
                    )
                finally:
                    try:
                        await context.close()
                    except Exception:
                        pass
            finally:
                try:
                    await browser.close()
                except Exception:
                    pass
                # Give the OS a moment to reclaim Chromium's RSS before we
                # unblock the next request.
                await asyncio.sleep(0.5)
                gc.collect()


# ---------- STAGE 1: collect profile links ----------

async def collect_links(query: str, max_results: int = 100, max_scrolls: int = 40):
    async def work(new_page, context):
        page = await new_page()
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
            await asyncio.sleep(1.2)

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
                if stagnant >= 3:
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
        normalized = [_normalize_place_url(u) for u in urls]
        return normalized[:max_results]

    try:
        return await _run_in_fresh_browser(work, timeout_s=LINKS_TIMEOUT)
    except asyncio.TimeoutError:
        raise RuntimeError(f"/links timed out after {LINKS_TIMEOUT}s")


# ---------- STAGE 2: details for one profile ----------

async def _safe_text(page, selector, timeout=2500):
    try:
        # text_content works for hidden elements too; inner_text would skip them.
        value = await page.locator(selector).first.text_content(timeout=timeout)
        return value.strip() if value else None
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

    nav_url = _normalize_place_url(url)

    async def work(new_page, context):
        page = await new_page()
        data = {"url": url}
        try:
            await page.goto(nav_url, wait_until="domcontentloaded", timeout=25000)
            await _dismiss_consent(page)
            await page.wait_for_selector("h1", timeout=10000, state="attached")
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
            data["category"] = await _safe_text(page, 'button[jsaction*="category"]')
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

    try:
        return await _run_in_fresh_browser(work, timeout_s=DETAILS_TIMEOUT)
    except asyncio.TimeoutError:
        return {"url": url, "error": f"timed out after {DETAILS_TIMEOUT}s"}
