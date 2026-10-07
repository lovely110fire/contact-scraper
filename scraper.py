import asyncio
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

# One request = one fresh browser. No persistent state, no dead references.
# Lock ensures only one browser runs at a time on the 512 MB free tier.
_scrape_lock = asyncio.Lock()

CHROMIUM_ARGS = [
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
]


# Kept for compatibility with main.py — nothing to warm up now.
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


async def _run_in_fresh_browser(work):
    """
    Launch Chromium, run `work(page_factory, context)`, then shut everything down.
    page_factory() returns a new page with resource blocking already set up.
    """
    async with _scrape_lock:
        async with async_playwright() as pw:
            browser = await pw.chromium.launch(headless=True, args=CHROMIUM_ARGS)
            try:
                context = await browser.new_context(
                    user_agent=USER_AGENT,
                    viewport={"width": 1366, "height": 900},
                    locale="en-US",
                )

                async def new_page():
                    p = await context.new_page()
                    await p.route("**/*", _block_heavy)
                    return p

                try:
                    return await work(new_page, context)
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


# ---------- STAGE 1: collect profile links ----------

async def collect_links(query: str, max_results: int = 100, max_scrolls: int = 40):
    async def work(new_page, context):
        page = await new_page()
        url = GMAPS_URL.format(query=quote_plus(query))
        await page.goto(url, wait_until="domcontentloaded", timeout=30000)
        await _dismiss_consent(page)

        # Google landed us directly on a single place page.
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

    return await _run_in_fresh_browser(work)


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

    async def work(new_page, context):
        page = await new_page()
        data = {"url": url}
        try:
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

    return await _run_in_fresh_browser(work)
