# MatchView Backend (demo coordinator)

The "traffic cop" between the editor, Cloudflare R2, and the Azure AI server.
It never touches video bytes — it hands out R2 upload URLs, kicks off AI jobs,
and relays results to the browser.

See the design doc: `../docs/superpowers/specs/2026-06-17-matchview-cloud-backend-design.md`.

## Run it locally

```bash
cd backend
npm install
cp .env.example .env      # then edit DEMO_SECRET
npm run dev               # http://localhost:8787, auto-reloads
```

Smoke test:

```bash
curl http://localhost:8787/health
# {"ok":true,"service":"matchview-backend"}

curl http://localhost:8787/whoami
# {"error":"unauthorized"}   (401 — no secret)

curl -H "x-demo-secret: <your DEMO_SECRET>" http://localhost:8787/whoami
# {"ok":true,"gated":true}
```

## Test it

```bash
npm test
```

## What's here so far

Slice ① — server skeleton + shared-secret gate. Upcoming: R2 multipart upload
(slice ②), AI orchestration + SSE streaming (slice ④).
