# The MatchView backend, explained from zero


---

## ⚡ Quick Reference (the cram sheet)

**What this backend is:** a small program that runs on a server and acts as a
**traffic cop** between the MatchView editor (in your browser) and two cloud
services — **Cloudflare R2** (where files are stored) and Auth0 (who checks
logins). It **never touches your video bytes.** It hands out permission slips and
tracks a little bookkeeping.

**The 6 words**

| Word | In one line |
|---|---|
| **Server** | A program that runs forever, waiting for requests and sending back responses. |
| **HTTP request** | method (`GET`/`POST`/`PUT`) + URL + headers + optional body. |
| **Endpoint / route** | "when a `GET /projects` request arrives, run *this* function." |
| **Middleware** | a checkpoint that runs *before* the route on every request (e.g. the login check). |
| **Object storage (R2)** | a giant `key → bytes` map in the cloud. No real folders. |
| **Presigned URL** | a temporary, signed link that lets the browser talk to R2 **directly**, without the backend in the middle. |

**The endpoints (all need a valid login token except `/health`)**

| Method + path | Does |
|---|---|
| `GET /health` | "are you alive?" — the only ungated route |
| `POST /uploads` | start a chunked video upload; get one upload link per chunk |
| `POST /uploads/complete` | "all chunks are up" — stitch them into the final file |
| `PUT /projects/:id` | save a project (its JSON) to the cloud |
| `GET /projects` | list my projects (newest first) |
| `GET /projects/:id` | fetch one project back |
| `PUT /media/:id` | record that a media file exists in the cloud |
| `GET /media` · `GET /media/:id` | list / fetch media records |
| `GET /media/:id/url` | get a temporary link to download the actual bytes |

**The whole idea in 4 lines**

1. Browser logs in with Auth0 → gets a **token** → sends it on every request.
2. Backend **verifies** the token (`jose`) → learns *who* you are (`userId`).
3. For big files, backend hands the browser **presigned URLs**; the browser
   uploads/downloads straight to/from R2. Backend never sees the bytes.
4. Every stored key is secretly prefixed with `users/<userId>/`, so you can only
   ever touch **your own** data.




A **backend** is a *different* program running on a *different* computer (a
"server" somewhere in a data center). It has no screen. It just sits in a loop:

```
   loop forever:
     wait for a request to arrive over the internet
     figure out what it wants
     send back a response
     
```

The two programs talk over **HTTP** — the language of the web. Here's the entire
model:

```
  BROWSER (frontend)                          SERVER (backend)
  ────────────────────                        ────────────────────
  "GET /projects"          ── request ──►     receives it
   + who I am (a token)                        checks the token, looks things up
                           ◄── response ──     "200 OK  { projects: [...] }"
```

> [!info] An HTTP request is just four things
> - a **method**: `GET` (read something), `POST` / `PUT` (create/save something).
> - a **URL**: `https://matchview-backend.fly.dev/projects`
> - **headers**: `name: value` labels carrying metadata. The important one here is
>   `authorization: Bearer <token>` — "here's proof of who I am."
> - an optional **body**: the data you're sending (JSON, for `POST`/`PUT`).
>
> And a **response** is three things: a **status code** (`200` ok, `401` not
> allowed, `404` not found), **headers**, and a **body** (usually JSON text).
>
> That's the whole conversation. Everything below is just *which* requests this
> backend answers and *what it does* for each.

## Why MatchView needs one at all

MatchView is **local-first**: your projects normally live as files in a folder on
your own disk ([the workspace](../../docs/codebase/40%20Infrastructure/52-infra-storage.md)).
So why a cloud backend?

- **Cross-device.** Start analyzing a match on your laptop, continue on the
  studio machine. The cloud is the meeting point.
- **Big files.** Match footage is gigabytes. The backend arranges for the browser
  to push those straight into cloud storage, efficiently and safely.
- **Real accounts.** So *your* projects are yours and nobody else can read them.

It's an **optional layer on top** of the local app — not something the editor
needs to open a project.

---

# Part 2 — The one big idea: a traffic cop that never touches the bytes

The most important thing to understand, and the thing that surprises people:

> **This backend never uploads or downloads your video.** A 4 GB match file never
> passes *through* it.

Why would a backend deliberately avoid touching the data it's about? Because
funnelling gigabytes through your own server is slow, expensive, and pointless
when the cloud storage (R2) can talk to the browser *directly*. So the backend's
real job is smaller and smarter:

```
                     ┌──────────────────────────────┐
   browser  ────1───►│  BACKEND (the traffic cop)   │
   "I want to         │  • checks you're logged in    │
    upload"           │  • asks R2 to allow it        │
                     │  • hands back permission slips │
                      └───────────────┬──────────────┘
                                      │ 2. "here are your upload links"
   browser  ◄──────────────────────────┘
      │
      │ 3. browser uploads the actual bytes STRAIGHT to R2
      ▼
   ┌───────────────────────┐
   │  Cloudflare R2         │   the bytes go here, never through the backend
   │  (cloud file storage)  │
   └───────────────────────┘
```

Those "permission slips" are the trick that makes this possible. They're called
**presigned URLs**, and they get their own section (Part 5). First, the pieces.

---

# Part 3 — The pieces (a tour of the files)

The whole backend is ~10 small files in `backend/src/`. Here's what each is for
and how they connect:

```
  server.ts     ← starts everything: reads config, builds the app, listens on a port
     │ builds
     ▼
  app.ts        ← the "switchboard": wires up middleware + all the routes
     │  uses
     ├── auth.ts          the login check (middleware) — runs before every route
     ├── uploads.ts       the /uploads routes        ┐
     ├── projects.ts      the /projects routes        ├─ the three "route groups"
     ├── media.ts         the /media routes          ┘
     │
     ├── storage.ts       a CONTRACT: "what any storage must be able to do"
     ├── r2.ts            the REAL storage: makes storage.ts work against R2
     ├── scope-store.ts   wraps storage so each user only sees their own slice
     └── env.ts           reads + checks the config from environment variables
```

Two design choices are worth calling out now, because they explain the shapes
you'll see everywhere:

### 3a. `app.ts` is built by a *factory* (so tests can fake everything)

Notice `createApp(config)` takes its storage as an **argument**:

```ts
export function createApp(config: AppConfig): Hono {
  // …wires routes using config.storage and config.objects…
}
```

Why not just import R2 directly? Because then every test would need real
Cloudflare credentials and would upload real files. Instead:

- **`server.ts`** (the real run) builds the app with **real R2**.
- **A test** builds the app with a **fake** in-memory storage, then fires requests
  at it with `app.request('/projects')` — no server, no port, no network, instant.

Same app, different storage plugged in. This is the single most common pattern in
the whole backend.

### 3b. `storage.ts` is a *contract*, not code that does anything

`storage.ts` defines **interfaces** — a list of *what storage must be able to do*,
with no implementation:

```ts
interface ObjectStore {
  putJson(key: string, value: unknown): Promise<void>   // save a small JSON file
  getJson<T>(key: string): Promise<T | null>            // read it back (or null)
  listKeys(prefix: string): Promise<string[]>           // list keys starting with…
  presignGet(key: string): Promise<string>              // temp download link for a key
}
```

The routes only ever talk to *this shape*. `r2.ts` provides the real version;
tests provide a fake one. Neither the routes nor you need to care which is
plugged in — they promise the same behavior.

> [!info] Why two storage contracts?
> There are two: **`ObjectStore`** for small JSON files (projects, media records)
> and **`MultipartStorage`** for the giant video chunks. They're separate because
> saving a 200-byte JSON and orchestrating a 4 GB chunked upload are genuinely
> different jobs.

---

# Part 4 — The gate: how the backend knows who you are

Look at `app.ts` and you'll see two checkpoints run **before** any route, on
**every** request:

```ts
app.use('*', cors({ origin: '*', /* … */ }))     // 1. CORS
app.use('*', async (c, next) => {                 // 2. the login gate
  if (c.req.path === '/health') return next()     //    /health is exempt
  return auth(c, next)                            //    everything else: verify token
})
```

> [!info] What "middleware" is
> A **middleware** is a function that runs *before* your route handlers, on every
> request — a checkpoint. If it's happy, it calls `next()` and the real route
> runs. If not, it responds itself (e.g. `401 Unauthorized`) and the route
> **never runs**. The login gate is middleware.

**The login gate (`auth.ts`)** does this on every request:

1. Read the `authorization: Bearer <token>` header.
2. **Verify** the token is real (signed by *our* Auth0, not expired, meant for
   *our* API). If anything's off → `401`, the route never runs.
3. If valid, pull the user's permanent id (`sub`) out of the token and stash it on
   the request as `userId`, so route handlers can do `c.get('userId')`.

*How* a token is verified without the backend ever knowing Auth0's secret is a
beautiful little bit of cryptography — and it has its own from-zero doc:
[`why-jose.md`](./why-jose.md). For this overview, all you need: **after the gate,
the backend has a trustworthy `userId`.**

> [!info] Two subtleties in that snippet
> - **CORS runs first.** Before a cross-site `POST`, the browser sends a "may I?"
>   preflight request that carries **no token**. If the login gate saw it first,
>   it'd `401` it and the real request would never happen. CORS must answer the
>   preflight before auth looks at anything.
> - **`/health` is exempt** so uptime monitors can ping "are you alive?" without a
>   login.

---

# Part 5 — The magic trick: presigned URLs

This is the concept that makes "never touch the bytes" possible, so it's worth
getting from zero.

**The problem.** The browser has a 4 GB video. R2 (the cloud storage) will only
accept uploads from someone with the secret R2 credentials. Those credentials
live on the **backend** and must *never* be sent to the browser (anyone could
steal them). So how does the browser upload to R2 without having the keys?

**The answer.** The backend uses its secret keys to pre-compute a **signed URL** —
a normal-looking link with a cryptographic signature baked into it that says
*"the holder of this link may upload one specific file, to this one spot, until
this expiry time."* It hands that link to the browser. The browser uploads to the
link. R2 checks the signature, sees it's valid, accepts the bytes.

```
  backend (has R2 secret keys)
     │  getSignedUrl(...)   ← computes the signature LOCALLY. No request is sent.
     ▼
  "https://…r2…/videos/abc/source.mp4?X-Amz-Signature=9f3c…&X-Amz-Expires=3600"
     │  handed to the browser
     ▼
  browser PUTs the bytes to that URL ───────────────► R2 verifies signature → stores it
```

Think of it like a **valet ticket**: the backend (the valet) holds the master
keys; it stamps you a ticket good for *one* car, *one* spot, for *one* hour. You
never get the master keys, but the ticket gets your car parked.

> [!note] The signing is offline
> `getSignedUrl` does **not** call R2 — it just does math with the secret key to
> produce the link. That's why the backend can hand out a hundred upload links
> without doing a hundred network calls.

Presigned URLs power **both** directions:

- **Upload:** `presignPart` → a signed `PUT` link the browser uploads a chunk to.
- **Download:** `presignGet` → a signed `GET` link the browser downloads bytes
  from (that's what `GET /media/:id/url` returns).

---

# Part 6 — Job #1, walked: uploading a video (the chunked flow)

Big files aren't uploaded in one shot — a dropped connection at 99% would waste
gigabytes. Instead the file is split into **chunks** ("parts", 100 MB each by
default), each uploaded separately, then stitched. This is called a **multipart
upload**, and it's a three-step dance:

```
  ── Step 1 ─────────────────────────────────────────────────────────────
  browser → POST /uploads   { filename:"match.mp4", contentType, size: 250_000_000 }

  backend:
    • makes a unique key:   videos/<random-id>/source.mp4
    • asks R2 to "begin a multipart upload" → R2 returns an uploadId
    • size 250 MB ÷ 100 MB  → 3 chunks → makes 3 presigned PUT links
    • replies:  { videoId, key, uploadId, partSize, parts: [
                    { partNumber: 1, url: "https://…sig…" },
                    { partNumber: 2, url: "https://…sig…" },
                    { partNumber: 3, url: "https://…sig…" } ] }

  ── Step 2 ─────────────────────────────────────────────────────────────
  browser uploads each chunk STRAIGHT to R2 (backend not involved):
    PUT chunk 1 → parts[0].url → R2 replies with an ETag (a fingerprint) "a1b2…"
    PUT chunk 2 → parts[1].url → ETag "c3d4…"
    PUT chunk 3 → parts[2].url → ETag "e5f6…"
  browser keeps each { partNumber, etag }.

  ── Step 3 ─────────────────────────────────────────────────────────────
  browser → POST /uploads/complete
            { key, uploadId, parts: [ {partNumber:1, etag:"a1b2…"}, … ] }

  backend → tells R2 "stitch these parts (in order) into the final file."
            R2 assembles them. Done. The full video now lives at `key` in R2.
```

> [!info] What's an "ETag"?
> When R2 stores a chunk it returns an **ETag** — a short fingerprint of that
> chunk's bytes. At `complete`, the browser sends the ETags back so R2 can confirm
> it's stitching the exact chunks it received (and in the right order —
> `r2.ts` sorts them by `partNumber` because R2 requires ascending order).

Notice again: in Step 2, **the bytes go browser → R2 directly.** The backend only
appears at the start (hand out links) and the end (say "stitch"). That's the
traffic cop, doing its whole job in a few hundred bytes of JSON.

---

# Part 7 — Job #2 & #3: syncing projects and media

These two are simpler — small JSON bookkeeping, no chunking. They're the "meeting
point" that lets a project hop between devices.

**Projects** (`projects.ts`) — the editing data itself:

```
  PUT /projects/p1   { name, updatedAt, project: {…the whole timeline…} }
     → saves TWO files in R2:
         projects/p1/project.json   the full data (can be big)
         projects/p1/meta.json      { id, name, updatedAt }  ← tiny, cheap to list

  GET /projects      → reads every meta.json, sorts newest-first, returns the list
                       (reads only the tiny metas, not the big project files)
  GET /projects/p1   → reads projects/p1/project.json back
```

The **split** (a big `project.json` + a tiny `meta.json`) is a deliberate little
trick: listing "my projects" should be cheap, so the name/date live in a separate
tiny file the list can read without downloading every full project.

**Media** (`media.ts`) — a *catalog* of what footage exists in the cloud:

```
  PUT /media/m1      { fileName, size, contentType, r2Key, updatedAt }
     → saves media/m1/meta.json   (just the record — the BYTES already live at
                                    r2Key, put there by the upload flow in Part 6)
  GET /media         → list all media records
  GET /media/m1/url  → a presigned GET link to download the actual bytes from R2
```

So a second device can call `GET /media`, see "there's a match.mp4 you don't have
locally," and `GET /media/m1/url` to pull the bytes down on demand.

> [!note] Media has no `data.json`
> Projects store their data *in* the backend's JSON files. Media does **not** — the
> media "data" is the giant video, which lives in R2 at `r2Key` from the upload.
> The media routes only track the lightweight *record*.

---

# Part 8 — How your data stays *yours* (per-user scoping)

Every route above secretly runs its storage through a wrapper before touching R2:

```ts
const store = scopeStore(deps.objects, c.get('userId'))   // ← the one magic line
```

`scope-store.ts` returns a storage object that **glues `users/<userId>/` onto
every key** before it reaches R2, and **strips it back off** list results:

```
  handler thinks it's saving:   projects/p1/meta.json
  scopeStore actually saves:    users/auth0_6612ab/projects/p1/meta.json
                                └──── your private slice ────┘

  handler asks to list:         projects/
  scopeStore lists:             users/auth0_6612ab/projects/   ← only YOUR keys
  then strips the prefix so the handler sees plain  projects/p1/meta.json
```

Because `userId` comes from the **verified token** (Part 4), not from anything the
browser chose, there is no request you can craft that reaches someone else's
folder — a malicious `videos/SOMEONE_ELSE/x.mp4` just becomes
`users/ME/videos/SOMEONE_ELSE/x.mp4`, trapped in your own slice. The full
walkthrough of this is in
[`per-user-auth-phases-1-2.md`](./per-user-auth-phases-1-2.md).

> [!info] "Folders" in R2 are a lie (a helpful one)
> Object storage is a flat `key → bytes` map — there are no real directories.
> `users/A/projects/p1/meta.json` is just one long **key string**. "List the
> projects folder" really means "list every key **starting with**
> `users/A/projects/`." That's why the prefix trick *is* the isolation.

---

# Part 9 — R2, and the one gotcha worth knowing

`r2.ts` makes the storage contracts real using the **AWS S3 SDK** — because
Cloudflare R2 speaks the same API as Amazon S3, the standard S3 toolkit works,
just pointed at R2's address (`https://<account>.r2.cloudflarestorage.com`).
Nothing here touches Amazon; your files live in *your* R2 bucket.

> [!warning] The checksum gotcha (real bug, real fix)
> Newer versions of the AWS SDK attach an extra **checksum** tag to every request.
> **R2 rejects that tag**, so uploads mysteriously fail. The fix, in `buildClient`:
> ```ts
> requestChecksumCalculation: 'WHEN_REQUIRED',
> responseChecksumValidation: 'WHEN_REQUIRED',
> ```
> "Only add the checksum when an operation truly needs it" (ours never do). If you
> ever see presigned R2 uploads failing right after an SDK upgrade, this is the
> first place to look.

One more R2 detail the code handles: `listKeys` can only return **1000 keys per
call**, so `r2.ts` loops with a `ContinuationToken` until R2 says there are no
more. You don't have to think about it — just know that's why there's a `do/while`
in there.

---

# Part 10 — Run it, test it, configure it

**Run locally:**
```bash
cd backend
npm install
cp .env.example .env      # then fill in the real values (see below)
npm run dev               # http://localhost:8787, auto-reloads on save
```

**Smoke-check it's alive:**
```bash
curl http://localhost:8787/health
# {"ok":true,"service":"matchview-backend"}

curl http://localhost:8787/projects
# {"error":"missing token"}   ← 401, because no login token was sent. Correct!
```

**Test it** (`npm test`) — runs Vitest against the app with **fake** storage (Part
3a), so no R2 and no network are needed; tests are instant and deterministic.

**Configure it** (`.env`, all required except `PORT`/`PART_SIZE`):

| Variable | What it is |
|---|---|
| `AUTH0_DOMAIN` | your Auth0 tenant, e.g. `dev-xxxx.us.auth0.com` — used to verify tokens |
| `AUTH0_AUDIENCE` | the identifier of your Auth0 API, e.g. `https://matchview-api` |
| `R2_ACCOUNT_ID` · `R2_ACCESS_KEY_ID` · `R2_SECRET_ACCESS_KEY` · `R2_BUCKET` | your Cloudflare R2 connection + which bucket |
| `PORT` | port to listen on (default `8787`) |
| `PART_SIZE` | upload chunk size in bytes (default 100 MB; **must be ≥ 5 MB** — an R2 rule) |

`env.ts` reads and **validates** all of this at startup, so the server fails
loudly with a clear message if something's missing — better than a confusing
crash later.

---

# Part 11 — The whole thing in seven sentences

1. The backend is a small **server** that answers HTTP requests from the MatchView
   browser app.
2. It's a **traffic cop**: it never handles your video bytes — those go
   browser ↔ **R2** (cloud storage) directly.
3. Every request must carry a **login token**; the gate (`auth.ts`, using `jose`)
   verifies it and learns your `userId`.
4. To upload, the backend hands the browser **presigned URLs** — temporary signed
   links — and the browser pushes chunks straight to R2, then asks the backend to
   **stitch** them.
5. To sync, the backend stores small **JSON** files (project data + media records)
   in R2 and lists/fetches them back.
6. Every stored key is silently prefixed with `users/<userId>/`, so you can only
   ever reach **your own** data.
7. `storage.ts` is a **contract** so tests run against a fake and the real server
   runs against R2 — same code, swappable storage.

---

**Where to go next:**
- [`why-jose.md`](./why-jose.md) — the login-token cryptography, from absolute
  zero (public/private keys with numbers you can check on a calculator).
- [`per-user-auth-phases-1-2.md`](./per-user-auth-phases-1-2.md) — the full
  frontend+backend walkthrough of how per-user isolation was built, every line
  traced.
- The design spec: `../../docs/superpowers/specs/2026-06-17-matchview-cloud-backend-design.md`.
