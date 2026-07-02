

---

## ⚡ Quick Reference
- **Phase 1 (identity):** browser sends the **Auth0 token** instead of the shared password. Backend **verifies** it (`jose`), reads the user id (`sub`).
- **Phase 2 (isolation):** backend prefixes every storage key with `users/<id>/`.

| Side | File | Change |
|---|---|---|
| BE | `src/auth.ts` *(new)* | verify token → set `userId` |
| BE | `src/app.ts` | secret gate → auth middleware |
| BE | `src/scope-store.ts` *(new)* | prefix keys with `users/<id>/` |
| BE | `src/projects.ts`/`media.ts` | use the scoped store |
| FE | `backend-client.ts` | send `Bearer <token>` not the secret |

`cd backend && npm install jose`

---
---

# Part A — HTTP, fetch, and the backend, from zero

## A.1 What an HTTP request actually is
Two programs talking over the network. One side **sends a request**, the other **sends back a response**.

A **request** is just four things:
- a **method**: `GET` (read), `POST`/`PUT` (write), etc.
- a **URL**: `https://matchview-backend.fly.dev/projects`
- **headers**: a set of `name: value` labels carrying metadata (who you are, what format you send). Example: `authorization: Bearer eyJ...`
- an optional **body**: the data you're sending (for POST/PUT).

A **response** is three things:
- a **status code**: `200` = ok, `401` = not allowed, `404` = not found.
- **headers**
- a **body**: usually JSON text, e.g. `{"projects":[...]}`.

That's the whole model. "The backend" is a program that receives requests and returns responses.

## A.2 What `fetch` is and where it comes from
**`fetch` is a function that already exists** — the runtime (the browser, and Node 18+) provides it globally. **You do not import it; it's just there**, like `Math` or `JSON`. Its job: send one HTTP request.

Shape:
```ts
fetch(url: string, options?): Promise<Response>
```
A tiny real use, traced:
```ts
const res = await fetch("https://matchview-backend.fly.dev/projects", {
  method: "GET",
  headers: { authorization: "Bearer eyJ..." },
})
// res is a Response object:
//   res.ok      === true        (status was 200–299)
//   res.status  === 200
//   await res.json()  === { projects: [ {id:"p1"}, ... ] }   ← the body, parsed
```
So: **`fetch` = "send this HTTP request and give me back the response."** Remember it's global and built-in — that matters for the `doFetch` trace coming up.

## A.3 The 5 backend words
1. **Server** — a program that runs forever receiving requests. Ours uses **Hono** (a small framework) on Node, in Docker.
2. **Route + handler** — "for `GET /projects`, run this function." The function is the **handler**: `router.get('/projects', async (c) => {...})`.
3. **Middleware** — a function that runs **before** handlers on **every** request — a checkpoint. If it rejects, it responds itself and the handler never runs.
4. **Context `c`** — a fresh per-request object Hono gives every middleware/handler. Read the request (`c.req.header('authorization')`), stash a value (`c.set('userId','x')`), read it (`c.get('userId')`), respond (`c.json({...}, 200)`).
5. **Object store (R2)** — not disk. A `Map<string, blob>`: a **key** (string) → data. **No folders** — `projects/abc/x.json` is one flat string. "List a folder" = "list keys **starting with** `projects/`". Behind this TS interface:
   ```ts
   interface ObjectStore {
     putJson(key: string, value: unknown): Promise<void>
     getJson<T>(key: string): Promise<T | null>
     listKeys(prefix: string): Promise<string[]>   // keys starting with prefix
     presignGet(key: string): Promise<string>      // temp download URL for a key
   }
   ```

---

# Part B — Phase 1: identity (token instead of secret)

## B.1 Where we are
Every request today carries `x-demo-secret: <password>`; the backend checks it matches. One shared key, no users. To do *per-user* anything, the backend must learn **who** is calling — which the Auth0 **token** carries (what a token is = `why-jose.md`).

## B.2 Frontend — the real file NOW, and the `doFetch` trace

Here's the actual relevant part of `backend-client.ts` today:
```ts
// NOW — backend-client.ts
export interface BackendConfig {
  baseUrl: string
  secret: string                 // the shared password
  fetchImpl?: typeof fetch        // OPTIONAL fake fetch (for tests); usually absent
}

export function createBackendClient(config: BackendConfig) {
  const baseUrl = config.baseUrl.replace(/\/+$/, '')
  const doFetch = config.fetchImpl ?? fetch        // ← the confusing line

  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await doFetch(`${baseUrl}${path}`, {
      ...init,
      headers: {
        'content-type': 'application/json',
        'x-demo-secret': config.secret,            // ← secret on every call
        ...init?.headers,
      },
    })
    if (!res.ok) throw new Error(`Backend ${path} failed: ${res.status}`)
    return res.json() as Promise<T>
  }
  // every method (listProjects, putProject, …) calls request()
}
```

### The `doFetch` line, traced

`const doFetch = config.fetchImpl ?? fetch`

The pieces:
- `fetch` — the global built-in from A.2.
- `config.fetchImpl` — optional; a function "shaped like fetch" (`typeof fetch`). Usually `undefined`.
- `??` — "left side, unless it's `null`/`undefined`, then right side."

**Trace 1 — the REAL app calls `listProjects()`:**
```
config = {
  baseUrl: "https://matchview-backend.fly.dev",
  secret:  "demo123",
  fetchImpl: undefined          // real app passes none
}

doFetch = config.fetchImpl ?? fetch
        = undefined          ?? fetch
        = fetch               // ← doFetch IS the real global fetch now

request("/projects"):
  res = await doFetch("https://matchview-backend.fly.dev/projects", {...})
        // doFetch === fetch → a REAL network GET goes out
  res.json() = { projects: [ {id:"p1"} ] }   // returned to caller
```

**Trace 2 — a TEST calls `listProjects()`:**
```
fakeFetch = async (url, opts) => ({ ok: true, json: async () => ({ projects: [] }) })

config = {
  baseUrl: "http://test",
  secret:  "x",
  fetchImpl: fakeFetch          // test passes a fake
}

doFetch = config.fetchImpl ?? fetch
        = fakeFetch          ?? fetch
        = fakeFetch           // ← fakeFetch isn't null/undefined, so it wins

request("/projects"):
  res = await doFetch(...)     // calls fakeFetch → NO network → canned answer
  res.json() = { projects: [] }
```

**So `doFetch` = "whichever fetch we should use."** The `??` is the switch: tests inject a fake so they never hit the network; the real app injects nothing, so it falls back to the real `fetch`. Every method calls `doFetch` and never cares which it got. That's the only reason the line exists.

(The singleton that builds this client from env vars — `getBackendClient()` reading `VITE_BACKEND_URL` + `VITE_DEMO_SECRET` — also lives in this file; we'll replace it in B.4.)

## B.3 Frontend — the change (secret → token)
Three edits:

**(1) Config — a token-getter instead of a secret:**
```ts
// AFTER
export interface BackendConfig {
  baseUrl: string
  getToken: () => Promise<string>   // ← was: secret: string
  fetchImpl?: typeof fetch
}
```
**(2) `request` — get a fresh token, send it as a Bearer header:**
```ts
// AFTER — inside request<T>()
const token = await config.getToken()
const res = await doFetch(`${baseUrl}${path}`, {
  ...init,
  headers: {
    'content-type': 'application/json',
    authorization: `Bearer ${token}`,   // ← replaces 'x-demo-secret'
    ...init?.headers,
  },
})
```
Traced, real app:
```
config.getToken = () => Promise<"eyJhbGci...">
token = await config.getToken()        // token = "eyJhbGci..."
headers.authorization = `Bearer ${token}` = "Bearer eyJhbGci..."
doFetch("https://.../projects", { headers: { authorization: "Bearer eyJhbGci..." }})
```
> **`Bearer <token>`** is the standard "here's my token" header. **A getter, not a string**, because tokens expire in minutes — `getToken()` returns a *fresh* one each call.

**(3) Replace the env singleton with a "configure once" function** (the token is dynamic from Auth0, not a build-time env var):
```ts
// AFTER
let singleton: BackendClient | null = null
export function configureBackendClient(config: BackendConfig): void {
  singleton = createBackendClient(config)
}
export function getBackendClient(): BackendClient {
  if (!singleton) throw new Error('Backend client not configured yet')
  return singleton
}
```

## B.4 Frontend — who calls `configureBackendClient`? (the React bit)

> **React in 90 seconds**
> - A **component** is a function returning UI; React calls it to render.
> - A **hook** is a function (`use…`) that only works *inside* a component while React renders it.
> - **`useAuth0()`** (Auth0's hook) gives `getAccessTokenSilently()` — returns the current token.
> - **`useEffect(fn, deps)`** runs `fn` after render — for "do once on mount."

The catch: `getAccessTokenSilently` only exists **inside a component** (it's a hook value). `backend-client.ts` is a plain module — not a component — so it can't call the hook. Fix: a tiny component grabs the function and hands it down once.
```tsx
export function BackendClientSetup() {
  const { getAccessTokenSilently } = useAuth0()        // only valid inside a component
  useEffect(() => {
    configureBackendClient({
      baseUrl: import.meta.env.VITE_BACKEND_URL as string,
      getToken: () => getAccessTokenSilently(),         // inject the getter
    })
  }, [getAccessTokenSilently])
  return null   // renders nothing; exists only to run the wiring
}
```
After this runs once, any code can call `getBackendClient()` and every request carries a fresh token.

## B.5 Backend — verify the token (`src/auth.ts`, new), traced

```ts
import { createMiddleware } from 'hono/factory'
import { createRemoteJWKSet, jwtVerify } from 'jose'

export function createAuthMiddleware(config: { domain: string; audience: string }) {
  const jwks = createRemoteJWKSet(                         // fetches+caches Auth0 keys
    new URL(`https://${config.domain}/.well-known/jwks.json`),
  )
  return createMiddleware<{ Variables: { userId: string } }>(async (c, next) => {
    const header = c.req.header('authorization') ?? ''
    const token = header.startsWith('Bearer ') ? header.slice(7) : ''
    if (!token) return c.json({ error: 'missing token' }, 401)
    try {
      const { payload } = await jwtVerify(token, jwks, {
        issuer: `https://${config.domain}/`,
        audience: config.audience,
      })
      if (!payload.sub) return c.json({ error: 'no subject' }, 401)
      c.set('userId', sanitizeUserId(payload.sub))
      await next()
    } catch {
      return c.json({ error: 'invalid token' }, 401)
    }
  })
}
function sanitizeUserId(sub: string): string {
  return sub.replace(/[^A-Za-z0-9_-]/g, '_')
}
```
- `createMiddleware` (from `hono/factory`) just builds a typed middleware; `<{ Variables: { userId: string } }>` is only TS telling Hono "the context will carry a string `userId`."
- `createRemoteJWKSet` / `jwtVerify` are the `jose` functions from `why-jose.md`.

**Trace — a valid request comes in:**
```
incoming: GET /projects, header "authorization: Bearer eyJhbGci...Qssw5c"

header = c.req.header('authorization')        // "Bearer eyJhbGci...Qssw5c"
header.startsWith('Bearer ')                   // true
token  = header.slice(7)                        // "eyJhbGci...Qssw5c"  (drops "Bearer ")
!token                                           // false → don't 401

jwtVerify(token, jwks, { issuer, audience }):
  payload = { sub: "auth0|6612ab", iss: "https://dev-x.us.auth0.com/",
              aud: "https://matchview-api", exp: 1750000000 }
payload.sub                                      // "auth0|6612ab"
sanitizeUserId("auth0|6612ab")                   // "auth0_6612ab"  ('|' → '_')
c.set('userId', "auth0_6612ab")                  // stashed on the request
await next()                                     // → the /projects handler runs
```

**Trace — no token (the 401 path):**
```
incoming: GET /projects, NO authorization header

header = c.req.header('authorization') ?? ''    // ''
token  = ''                                       // '' doesn't start with "Bearer "
!token                                            // true
→ return c.json({ error: 'missing token' }, 401) // handler NEVER runs
```

## B.6 Backend — swap the gate in `app.ts`
The real secret gate today:
```ts
// NOW — app.ts
app.use('*', async (c, next) => {
  if (c.req.path === '/health') return next()
  const provided = c.req.header('x-demo-secret')
  if (provided !== config.demoSecret) return c.json({ error: 'unauthorized' }, 401)
  return next()
})
```
Replace with:
```ts
// AFTER — app.ts
import { createAuthMiddleware } from './auth.ts'
const auth = createAuthMiddleware(config.auth0)    // { domain, audience }
app.use('*', async (c, next) => {
  if (c.req.path === '/health') return next()
  return auth(c, next)
})
```
In `AppConfig`: drop `demoSecret`, add `auth0: { domain: string; audience: string }`; `server.ts` fills it from `process.env.AUTH0_DOMAIN`/`AUTH0_AUDIENCE`.
> Keep the CORS line ABOVE this (it already runs first). The browser's preflight `OPTIONS` carries no token; auth must not see it first.

### ✅ Phase 1 done when
valid token → works; no/bad token → `401`; handlers can read `c.get('userId')`.

---

# Part C — Phase 2: isolation, traced

## C.1 The idea
Prefix every key with `users/<id>/`. Since R2 "folders" are just prefixes (A.3), the prefix *is* the isolation. `<id>` comes from `c.get('userId')` → from the verified token → the client never picks whose data it touches.

## C.2 The scoped store (`src/scope-store.ts`, new)
```ts
import type { ObjectStore } from './storage.ts'
export function scopeStore(objects: ObjectStore, userId: string): ObjectStore {
  const prefix = `users/${userId}/`
  return {
    putJson: (key, value) => objects.putJson(prefix + key, value),
    getJson: (key) => objects.getJson(prefix + key),
    presignGet: (key) => objects.presignGet(prefix + key),
    listKeys: async (p) => {
      const keys = await objects.listKeys(prefix + p)
      return keys.map((k) => k.slice(prefix.length))   // strip prefix back off
    },
  }
}
```
**Trace — handler does `store.listKeys('projects/')` for user `auth0_6612ab`:**
```
userId = "auth0_6612ab"
prefix = "users/auth0_6612ab/"

store.listKeys("projects/"):
  objects.listKeys(prefix + "projects/")
    = objects.listKeys("users/auth0_6612ab/projects/")
  R2 returns:
    [ "users/auth0_6612ab/projects/p1/meta.json",
      "users/auth0_6612ab/projects/p2/meta.json" ]   // ONLY this user's keys
  .map(k => k.slice(prefix.length))     // chop off the "users/auth0_6612ab/" part
    = [ "projects/p1/meta.json",
        "projects/p2/meta.json" ]       // handler sees normal keys, no prefix
```
The handler code (`k.endsWith('/meta.json')`, etc.) keeps working unchanged — it never sees `users/auth0_6612ab/`. The prefix is a secret kept inside the wrapper.

## C.3 Using it — one line per handler
```ts
// projects.ts — NOW
const keys = await deps.objects.listKeys('projects/')     // EVERYONE's 😱
// projects.ts — AFTER
const store = scopeStore(deps.objects, c.get('userId'))   // this user's view
const keys = await store.listKeys('projects/')            // only theirs ✅
```
Add that one line at the top of each handler in `projects.ts`/`media.ts`; use `store` instead of `deps.objects`.

## C.4 The upload gotcha
The client sends a key back later (on `complete`, as `r2Key`). Rule: **the client only ever sees UNPREFIXED keys; the backend adds `users/<id>/` on every op.** So a client sending `videos/SOMEONE_ELSE/x.mp4` gets `users/ME/videos/SOMEONE_ELSE/x.mp4` — trapped in their own folder. (Add a `scopeMultipart` wrapper, same pattern.)
> ⚠️ Never prefix twice (`users/A/users/A/…`) — keys stay unprefixed outside the wrapper.

### ✅ Phase 2 done when
A's project lands at `users/A/projects/…`; `GET /projects` returns only the caller's.

---

# Part D — Test
1. Backend locally with `AUTH0_DOMAIN`/`AUTH0_AUDIENCE` (`npm start`).
2. Frontend: `VITE_BACKEND_URL` → it; `VITE_AUTH0_AUDIENCE` set (verifiable token).
3. No token → 401. 4. Two users (two browser profiles) → check `users/A/…` vs `users/B/…` in R2. 5. Same user, 2nd browser → data pulls down.
> Backend tests: give `createAuthMiddleware` an optional injectable verify-fn so vitest passes a fake returning a known `sub` (no real Auth0).

# Part E — Gotchas
- Tokens expire → always send a fresh one (the getter).
- `VITE_AUTH0_AUDIENCE` must be set or Auth0 returns an opaque token `jose` can't verify.
- CORS stays **before** auth (preflight `OPTIONS` has no token).
- `/health` stays outside the gate.
- No double-prefix outside the scoped wrapper.
