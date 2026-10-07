# Playwright base image with Chromium + system deps already installed
FROM mcr.microsoft.com/playwright/python:v1.47.0-jammy

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Render free tier gives 512 MB RAM. One worker only — more will OOM.
# Long timeout since Maps scraping is slow (~60s for 10 results).
ENV PORT=10000
EXPOSE 10000

CMD uvicorn main:app --host 0.0.0.0 --port ${PORT} --workers 1 --timeout-keep-alive 120
