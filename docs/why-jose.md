# JWT, Auth0 & `jose` — the complete cram sheet

> One self-contained doc. Assumes **zero** prior knowledge of tokens, auth, or
> cryptography. Read top-to-bottom the first time. After that, the **Quick
> Reference** at the top is your cram sheet for revising in 2 minutes.

---

## ⚡ Quick Reference (the cram sheet)

**The 6 words**

| Term | In one line |
|---|---|
| **JWT** | A token string with 3 dot-separated parts: `header.payload.signature`. Pronounced "jot". |
| **Payload / claims** | The JSON inside the token saying who you are (`sub`, `exp`, `iss`, `aud`). **Readable by anyone** — not secret. |
| **Signature** | A cryptographic stamp on the end. The *only* thing that makes a token trustworthy. |
| **Private key** | Secret. Auth0 only. **Creates** signatures. |
| **Public key** | Published to the world (at the JWKS URL). **Checks** signatures, can't create them. |
| **JWKS** | The URL where Auth0 publishes its public keys: `https://<tenant>.auth0.com/.well-known/jwks.json` |

**The claims that matter**

| Claim | Means | We use it to… |
|---|---|---|
| `sub` | "subject" = the user's permanent unique ID | namespace their data: `users/<sub>/...` |
| `iss` | "issuer" = who made the token | confirm it's from OUR Auth0 tenant |
| `aud` | "audience" = who the token is FOR | confirm it's meant for OUR backend API |
| `exp` | expiry timestamp | reject expired tokens |

**The whole flow in 5 steps**

1. User logs in → Auth0 **signs** a JWT with its **private key** → browser holds it.
2. Browser sends it on every request: `Authorization: Bearer <token>`.
3. Backend fetches Auth0's **public key** (JWKS) and **verifies** the signature.
4. Valid → read `sub`, trust it, scope storage to `users/<sub>/...`.
5. Invalid/expired/wrong-audience/forged → `401 Unauthorized`.

**Why `jose`:** doing step 3 correctly (fetch + rotate keys, check signature,
reject expired / wrong-audience / "no-algorithm" tokens) is fiddly and
security-critical. `jose` does it in **two function calls**. Don't hand-roll
crypto.

**The actual code (this is genuinely all of it):**
```ts
import { createRemoteJWKSet, jwtVerify } from 'jose'

const jwks = createRemoteJWKSet(                       // once, at startup
  new URL(`https://${AUTH0_DOMAIN}/.well-known/jwks.json`),
)

async function verifyToken(token: string): Promise<string> {  // per request
  const { payload } = await jwtVerify(token, jwks, {
    issuer: `https://${AUTH0_DOMAIN}/`,
    audience: AUTH0_AUDIENCE,
  })
  return payload.sub as string          // the trustworthy user id
}
```

---
---

# Part 1 — The problem we're actually solving

Our backend has endpoints like "give me all my projects" and "give me a download
link for this video." With real user accounts, the backend must answer one
question on **every single request**:

> "Who is making this request, and can I trust they are who they claim to be?"

Today (demo mode) the answer is dumb: every request carries a shared password
(`x-demo-secret`). Match = you're in. No real users — one shared door key.

With Auth0 we want real, separate users. After login, the browser sends a
**token** on every request. The backend looks at that token and decides: *is
this real, and which user is it?* That check is the entire ballgame, and `jose`
is the tool that does it correctly. To see why it's not trivial, we need to know
what a token actually is.

---

# Part 2 — What a JWT actually is

The token Auth0 hands the browser is a **JWT** ("JSON Web Token", say "jot"). It
looks like one long ugly string with two dots:

```
eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJhdXRoMHwxMjMiLCJleHAiOjE3MDB9.SflKxwRJSMeKKF2QT4fwpM
└────── header ──────┘ └─────────── payload ───────────────┘ └──── signature ────┘
```

Two dots split it into **three parts**:

### Part 1 — Header
How the token was signed, e.g. `{ "alg": "RS256", "typ": "JWT" }`. ("RS256" is
the signing method — it matters later.)

### Part 2 — Payload (the "claims")
The actual info, plain JSON:
```json
{
  "sub": "auth0|6612ab...",          // user's permanent unique ID  ← the gold
  "iss": "https://you.auth0.com/",   // issuer
  "aud": "https://matchview-api",    // audience (who it's for)
  "exp": 1700000000                  // expiry (Unix timestamp)
}
```

### Part 3 — Signature
A cryptographic stamp. **This is the only part that makes the token
trustworthy.** Here's why that matters so much.

---

# Part 3 — The trap: the payload is NOT secret

The surprise that catches everyone:

> The header and payload are **not encrypted** — they're just **base64**, a
> reversible text encoding (a costume, not a lock). Anyone can paste a JWT into
> [jwt.io](https://jwt.io) and read the payload in plain text.

So if our backend were lazy:
```ts
// ⚠️ DANGEROUSLY WRONG
const payload = JSON.parse(base64decode(token.split('.')[1]))
const userId = payload.sub   // "trust whatever the token says"
```
…an attacker would hand-craft a token saying `"sub": "your-id"`, send it, and
get **your** projects. They never logged in. They just typed JSON.

That's why the **signature** exists, and why verifying it is the whole job. Now
the part you actually asked about: how the signature is un-fakeable.

---

# Part 4 — The public/private-key "magic", from zero

The goal we're going to make true:

> A pair of keys where doing the operation with key A can **only** be undone with
> key B, and **knowing B does not let you figure out A.**

If that's possible, keep A secret (**private key**), publish B (**public key**).
Things only-A could do, the world confirms with B — but no one can do them
themselves, and B never reveals A. That last clause is the trick.

## 4.1 — A "one-way street" (one-way function)

Operations easy to do, hard to undo:

- **Mixing paint:** blue + yellow → green in 2 seconds. Given the green, name the
  exact shades that went in? Basically can't.
- **Multiplying vs un-multiplying** (the one we'll use):
  - Forward: `61 × 53 = 3233`. Easy.
  - Backward: "what two numbers make 3233?" You'd have to *try things*. For a
    number 600 digits long, every computer on Earth running longer than the
    universe has existed **can't do it.**

A **one-way function** = easy one way, impossible the other. "Multiply two big
primes" is the classic.

## 4.2 — Clock arithmetic ("modulo"), the playground

You already do this: **12-o'clock arithmetic.** It's 10 o'clock, add 5 hours →
not "15 o'clock" but **3 o'clock.** You wrapped around 12. That wrap is
"working **modulo** 12" — the remainder after dividing.

```
15 mod 12 = 3     (15 = 12 + 3)
25 mod 12 = 1     (25 = 24 + 1)
17 mod 5  = 2     (17 = 15 + 2)
```
Just: **divide, keep the remainder.** Why crypto loves it: wrapping *scrambles*
and loses info — if the clock says 3, the real number could've been 3, 15, 27,
39… That loss is what makes things hard to reverse.

## 4.3 — RSA with tiny numbers you can check by hand

The famous algorithm (**RSA** = Rivest, Shamir, Adleman). Real keys use giant
numbers; the math is identical. Let's build a *real working* key pair small
enough to verify on a calculator.

**Step A — pick two primes** (prime = divisible only by 1 and itself):
```
p = 5      q = 11        ← the SECRET seeds
```

**Step B — multiply them → the modulus (our wrap-around number):**
```
n = p × q = 5 × 11 = 55        ← PUBLIC (we tell everyone)
```
I told you `n = 55` but **not** `p` and `q`. For 55 you can spot `5 × 11`
instantly. For a 600-digit `n`, nobody can. **That gap is the entire security.**

**Step C — compute the helper number (totient):**
```
φ = (p − 1) × (q − 1) = 4 × 10 = 40
```
You can only compute `φ` if you know `p` and `q`. Someone with only `n = 55`
can't get `φ` without un-multiplying 55 back into 5 and 11. **Pocket this — it's
*why* the public can't derive the private key.**

**Step D — pick the PUBLIC key number `e`** (shares no factor with `φ`):
```
e = 3        →  PUBLIC KEY = (e=3, n=55)   shout it from the rooftops
```

**Step E — compute the PRIVATE key number `d`**, defined by `(e × d) mod φ = 1`:
```
(3 × d) mod 40 = 1
try d = 27:  3 × 27 = 81,  81 mod 40 = 1   ✓
d = 27       →  PRIVATE KEY = (d=27, n=55)   guard with your life
```
Finding `d` **required** `φ = 40`, which **required** the secret primes. So the
private key can *only* be computed by whoever knows `p` and `q`. Everyone else
would have to factor `n` first. **That's the lock.**

## 4.4 — Sign something, watch the world verify it

| Key | Numbers | Who has it |
|---|---|---|
| **Public** | `e = 3`, `n = 55` | everyone |
| **Private** | `d = 27`, `n = 55` | only me |

Message = the number **2**. (Real signing uses the *hash* of the token as the
number; the math below is identical.)

**I sign with my PRIVATE key** — "raise message to the power `d`, on clock `n`":
```
signature = (2 ^ 27) mod 55

2^1=2,  2^2=4,  2^4=16,  2^8=256 mod55=36,  2^16=36²=1296 mod55=31
2^27 = 2^16 · 2^8 · 2^2 · 2^1 = 31·36·4·2 (mod 55)
     = (1116 mod55=16) ·4=64 mod55=9 ·2 = 18
signature = 18
```
I send: **message `2` + signature `18`.**

**The world verifies with my PUBLIC key** — "raise signature to the power `e`":
```
check = (18 ^ 3) mod 55
18² = 324 mod55 = 49
18³ = 49 · 18 = 882 mod55 = 2
check = 2   ← exactly the original message ✅
```
The match is the proof: *only someone who knew `d = 27` could have produced a
`18` that lands back on `2` when you apply `e = 3`.*

**Feel the asymmetry:**
- I used `d` (private) to **create** 18.
- You used `e` (public) to **confirm** 18.
- You **can't** reverse it to find `d` — that needs `φ`, which needs the secret
  primes, which needs factoring `n`. **Public key checks the work but can never
  do the work.** That's the "magic": multiplication being a one-way street,
  dressed in clock arithmetic.

## 4.5 — Why publishing `n` doesn't leak the secret

| Operation | Difficulty |
|---|---|
| Multiply `p × q` → `n` (what I did) | trivial |
| Factor `n` → `p × q` (what an attacker needs) | impossible at 2048+ bits |

`n = 55` is trivially factorable, so this toy key is *not* secure — it's a
teaching model. Make `p`, `q` ~300 digits each and factoring would outlast the
universe. **Same math, just bigger numbers = real security.**

---

# Part 5 — Where the public key lives: JWKS

Auth0 publishes its public key(s) at a fixed URL — the **JWKS** ("JSON Web Key
Set"):
```
https://<your-tenant>.auth0.com/.well-known/jwks.json
```
Two real-world headaches you'd have to handle by hand:

- **Key rotation:** Auth0 periodically swaps signing keys. Your code must notice,
  re-fetch the JWKS, find the new key — *without* re-downloading on every request.
- **Key selection:** the JWKS can list several keys; the token header's `kid`
  ("key ID") says which one signed it; you must pick the match.

Caching + rotation + key-matching done correctly is the first big chunk `jose`
handles for us.

---

# Part 6 — So what IS `jose`, and why it?

`jose` is a small, trusted JS library that does Parts 4–5 **correctly** in one
or two calls.

- **Name:** stands for the standards family — **J**avaScript **O**bject
  **S**igning and **E**ncryption (JWT, JWK, JWS, JWE…). Named after what it
  implements.
- **Who:** maintained by Filip Skokan (`panva`), deeply involved in writing the
  OAuth/OpenID standards. Millions of downloads/week; the trusted choice.
- **Why it fits us:**
  - `createRemoteJWKSet(url)` → fetches Auth0's JWKS, **caches**, **auto-refreshes
    on rotation**. (Part 5 solved.)
  - `jwtVerify(token, keys, options)` → checks the signature **and** `issuer`,
    `audience`, expiry in one go. (Part 4 + safety solved.)
  - Modern (uses built-in WebCrypto), tiny, runs in Node / Deno / Cloudflare
    Workers — handy if the backend ever moves to an edge runtime.

### Pitfalls `jose` saves you from (why never DIY)

| Pitfall | DIY disaster | `jose` |
|---|---|---|
| **`alg: none`** | Token says "no signature"; naive code accepts it. Attacker strips signature, walks in. | Never silently accepts "none". |
| **Alg confusion (RS256→HS256)** | Attacker re-labels the token and signs with your *public* key as a shared secret; sloppy code accepts. | Won't verify with a mismatched key type. |
| **Forgot expiry** | Old tokens work forever. | Checks `exp` automatically. |
| **Forgot `aud`/`iss`** | A token for another app/tenant works on yours. | Rejects unless they match. |
| **Key rotation/caching** | Re-fetch every request (slow) or cache forever (breaks on rotation). | `createRemoteJWKSet` does it right. |

**Security rule of thumb:** don't hand-roll crypto verification. Use the boring,
audited library.

### Alternatives, and why not

| Option | Verdict |
|---|---|
| `jsonwebtoken` (old classic) | Works, but needs `jwks-rsa` bolted on for JWKS; older callback API. Clunkier. |
| `hono/jwt` (built into our framework) | Great for simple shared-secret (HS256). **Doesn't** do remote rotating JWKS — exactly what Auth0 (RS256) needs. |
| `express-jwt` / `express-oauth2-jwt-bearer` | Auth0's own — but for **Express**, and we're on **Hono**. Wrong framework. |
| Write it ourselves | See the pitfalls table. No. |
| **`jose`** ✅ | Framework-agnostic, JWKS + verify + claim checks in two functions, modern & audited. Best fit. |

---

# Part 7 — Our actual backend code

```ts
import { createRemoteJWKSet, jwtVerify } from 'jose'

// Built ONCE at startup. Knows how to fetch + cache + refresh Auth0's keys.
const jwks = createRemoteJWKSet(
  new URL(`https://${AUTH0_DOMAIN}/.well-known/jwks.json`),
)

// Called on EVERY request. Returns the user's id, or throws if the token is
// bad / expired / forged / for-the-wrong-app.
async function verifyToken(token: string): Promise<string> {
  const { payload } = await jwtVerify(token, jwks, {
    issuer: `https://${AUTH0_DOMAIN}/`,   // must be from OUR tenant
    audience: AUTH0_AUDIENCE,             // must be intended for OUR api
  })
  return payload.sub as string            // trustworthy user id
}
```

Wrapped in our middleware (`auth.ts`), it will:
1. Read `Authorization: Bearer <token>` off the request.
2. Call `verifyToken`.
3. Success → `c.set('userId', sub)` so route handlers can scope storage to
   `users/<sub>/...`.
4. Any failure → `401 Unauthorized`.

If the signature is fake, the token expired, or the issuer/audience is wrong,
`jwtVerify` **throws** → `401`. If it returns, we have a `sub` we can *actually
trust*.

---

# Part 8 — Bonus: encryption is the same trick, mirrored

(Not used by JWTs — just so you're not confused later.) The same key pair can
also **encrypt**: the world encrypts *to you* with your **public** key, and only
your **private** key can decrypt. Signing is the mirror: only your private key
signs, the world verifies with the public key. Same math, opposite roles. JWTs
only use **sign/verify**.

---

# Part 9 — The whole thing in five sentences

1. Multiplying two huge primes is easy; un-multiplying (factoring) is effectively
   impossible — a **one-way street**.
2. With **clock (modulo) arithmetic** you build a pair `e` and `d` that undo each
   other.
3. Computing `d` needs the secret primes; everyone else only sees `n` and `e`
   and would have to factor `n` to catch up — which they can't.
4. So `d` **signs** (only the secret holder), `e` **verifies** (anyone), and
   publishing `e` never reveals `d`.
5. That's exactly how Auth0 signs your JWT and how our backend — via **`jose`** —
   checks it without ever holding Auth0's secret. **No magic; just a
   multiplication you can't run backwards.**
