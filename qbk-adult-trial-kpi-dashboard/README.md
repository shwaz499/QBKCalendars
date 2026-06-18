# QBK Adult Trial KPI Dashboard

Standalone deployment for the QBK Adult Trial KPI page.

This app is separate from the youth dashboard. It serves an adult-trial funnel at the root URL and syncs the supporting Salesmessage and DaySmart data needed to populate it.

## What it does

- Opens directly to the Adult Trial KPI page
- Syncs Adult inbox conversation headers from Salesmessage
- Syncs customer, registration, and membership data from DaySmart
- Builds an adult trial funnel for recent leads
- Uses actual DaySmart admin location check-ins for the `Checked In` stage
- Shows KPI summary, status buckets, detail rows, and email preview

## Funnel

- New Lead
- Scheduled
- Checked In
- Membership purchased
- No-show / Lost

## Local setup

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
uvicorn app.main:app --reload --port 8001
```

## Required environment variables

- `SALESMESSAGE_API_TOKEN`
- `SALESMESSAGE_BASE_URL`
- `ADULT_INBOX_ID`
- `DASH_API_CLIENT_ID`
- `DASH_API_SECRET`
- `DASH_API_BASE_URL`
- `DAYSMART_COMPANY`
- `APP_PASSWORD`

## Required for Checked In stage

- `DAYSMART_USERNAME`
- `DAYSMART_PASSWORD`

Those admin credentials are used to load the DaySmart location check-in report so the dashboard can distinguish rostered trial leads from people who actually checked in.

## Recommended environment variables

- `DATABASE_URL`
  Default: `adult_kpi.db`
- `OPENAI_API_KEY`
- `OPENAI_MODEL`

## Render

This repo is designed to run as a simple Python web service on Render.

Recommended settings:

- Runtime: `python`
- Build command: `pip install -r requirements.txt`
- Start command: `uvicorn app.main:app --host 0.0.0.0 --port $PORT`

Important note:

- If you deploy with SQLite only, synced data is not guaranteed to persist across restarts or redeploys.
- If you want durable data later, the clean next step is adding a persistent disk or moving to Postgres.
