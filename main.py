from contextlib import asynccontextmanager
from fastapi import FastAPI, Query, HTTPException
from pydantic import BaseModel
from scraper import collect_links, get_place_details, startup, shutdown


@asynccontextmanager
async def lifespan(app: FastAPI):
    await startup()
    yield
    await shutdown()


app = FastAPI(title="GMaps Scraper", lifespan=lifespan)


class DetailsBody(BaseModel):
    url: str


@app.get("/")
def root():
    return {
        "status": "ok",
        "endpoints": {
            "GET /links?q=dentist+in+los+angeles&limit=50": "collect profile URLs",
            "GET /details?url=<gmaps_place_url>": "details for one profile",
            "POST /details": "same, with JSON body {url: ...}",
        },
    }


@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/links")
async def links(
    q: str = Query(..., description="Search query"),
    limit: int = Query(60, ge=1, le=200),
):
    try:
        urls = await collect_links(q, max_results=limit)
        return {"query": q, "count": len(urls), "links": urls}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/details")
async def details_get(url: str = Query(..., description="Google Maps place URL")):
    try:
        return await get_place_details(url)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/details")
async def details_post(body: DetailsBody):
    try:
        return await get_place_details(body.url)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
