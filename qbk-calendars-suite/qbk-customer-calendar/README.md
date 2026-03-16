# QBK Customer Daily Calendar

Standalone customer-facing calendar app for viewing all QBK events on a selected day.

## Features
- Date picker for a daily events view.
- Live data from QBK DaySmart (DashPlatform) API through a local `/api/events` endpoint.
- Sample JSON fallback for local testing.
- Every event has a booking link into QBK's online booking flow.

## Run locally (live data)
From `/Users/joshschwartz/Documents/New project/qbk-customer-calendar`:

```bash
python3 server.py
```

Open:
- `http://localhost:8010/index.html`
- `http://localhost:8010/widget.html` (embed-friendly widget view)

## Credentials
The server uses one of these sources:
1. `DASH_API_CLIENT_ID` + `DASH_API_SECRET` environment variables.
2. Fallback: `~/.codex/config.toml` from the configured `qbk-sports-admin` MCP server.

## Optional sample mode
The UI has a **Use Sample Data** button that loads `events.sample.json`.

## Legacy static mode
If needed, you can still serve the folder statically:

```bash
python3 -m http.server 8000
```

But static mode cannot call live `/api/events` unless the API server is running.

## Wix widget embed
Use `widget.html` for Wix so the page is compact and iframe-friendly.

1. Deploy this app to a public URL (Wix cannot load `localhost`).
2. In Wix Editor, add an **Embed Code** element.
3. Choose **Embed HTML** and paste:

```html
<iframe
  src="https://YOUR_PUBLIC_DOMAIN/widget.html"
  title="QBK Daily Events"
  width="100%"
  height="980"
  style="border:0; overflow:hidden;"
  loading="lazy"
></iframe>
```

Optional:
- You can also use `https://YOUR_PUBLIC_DOMAIN/index.html?embed=1`.
- If your widget appears cropped, increase the iframe height in Wix.

## Deploy to public domain (Render)
This repo includes a Render blueprint at:

`/Users/joshschwartz/Documents/New project/render.yaml`

### Deploy
1. Push this project to GitHub.
2. In Render, click **New +** -> **Blueprint**.
3. Connect your GitHub repo and select this project.
4. Render reads `render.yaml` and creates `qbk-customer-calendar`.
5. In service settings, add environment variables:
   - `DASH_API_CLIENT_ID`
   - `DASH_API_SECRET`
6. Deploy and wait for the first successful build.

### Attach your domain
1. In Render service -> **Settings** -> **Custom Domains**, add your domain (example: `calendar.yourdomain.com`).
2. Render shows DNS records to add at your DNS provider (usually a `CNAME`).
3. Add those records, wait for DNS to propagate, then verify in Render.

### Wix URL to use
After deploy, set your Wix iframe source to:

`https://calendar.yourdomain.com/widget.html`
