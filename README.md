# GMaps Scraper — Two-Stage (Render Free Tier)

FastAPI + Playwright. Two endpoints so each HTTP call stays under Render's 100s limit.

## Endpoints

### 1. Collect profile links
```
GET /links?q=dentist+in+los+angeles&limit=60
```
Scrolls Google Maps results and returns every profile URL it can gather (up to 200).
Returns:
```json
{
  "query": "dentist in los angeles",
  "count": 58,
  "links": [
    "https://www.google.com/maps/place/.../data=...",
    "https://www.google.com/maps/place/.../data=...",
    ...
  ]
}
```

### 2. Get details for one profile
```
GET /details?url=<url-encoded-maps-link>
POST /details    { "url": "..." }
```
Returns:
```json
{
  "url": "...",
  "name": "Smile Dental Clinic",
  "address": "123 Main St, Los Angeles, CA 90001",
  "phone": "(213) 555-0123",
  "website": "https://smiledental.com",
  "category": "Dentist",
  "rating": "4.7",
  "reviews": "214",
  "plus_code": "..."
}
```

## Suggested workflow (from your client / n8n / Make / Zapier / curl loop)

```bash
# Step 1: get links
curl "https://your-service.onrender.com/links?q=dentist+in+los+angeles&limit=50"

# Step 2: loop over each link, hit /details
for url in $(cat links.txt); do
  curl -s "https://your-service.onrender.com/details?url=$(python -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))" "$url")"
  sleep 2   # be polite to Google
done
```

## Deploy to Render (free)
1. Push to GitHub.
2. Render → New → Blueprint → pick repo (reads `render.yaml`, plan: free).
3. First build ~5 min.
4. Test: `https://your-service.onrender.com/links?q=cafe+in+lahore&limit=20`

## Free tier realities
- **512 MB RAM** — one scrape at a time (lock enforces this).
- **Cold start ~30s** after 15 min idle.
- **`/links` with limit=60**: ~30–50s.
- **`/details`**: ~8–12s per call.
- **100s HTTP timeout** on Render — stay under it; the two-stage design is for exactly this.
- **One IP** → Google will CAPTCHA after a few hundred requests. Space them out (2–3s between calls).

## Local
```bash
pip install -r requirements.txt
playwright install chromium
uvicorn main:app --reload --port 8000
```

## If selectors stop returning data
Google tweaks the Maps DOM every few months. Open a place page in a real browser, inspect the fields, update the selectors in `scraper.py` → `get_place_details`.
