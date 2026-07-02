/**
 * The Hono application — all routes and middleware, but no server.
 *
 * Built via a factory (`createApp`) that takes its config as an argument so
 * tests can spin up an app with a known secret and FAKE storage, then call
 * `app.request(...)` without a real port or real R2. `server.ts` is the thin
 * wrapper that reads the real env and actually listens.
 */

import { Hono } from 'hono'
import { cors } from 'hono/cors'
import type { MultipartStorage, ObjectStore } from './storage.ts'
import { createUploadsRouter } from './uploads.ts'
import { createProjectsRouter } from './projects.ts'
import { createMediaRouter } from './media.ts'
import { createAuthMiddleware, createAuth0Verifier, type AuthEnv, type TokenVerifier } from './auth.ts'

export interface AppConfig {
  /** Auth0 settings used to verify the Bearer token on every request. */
  auth0: { domain: string; audience: string }
  /** Where big video uploads go — real R2 in the server, a fake in tests. */
  storage: MultipartStorage
  /** Where project JSON files go — real R2 in the server, a fake in tests. */
  objects: ObjectStore
  /** Upload chunk size in bytes. */
  partSize: number
  /**
   * How a bearer token becomes a userId. Omitted in the real server, where it
   * defaults to the Auth0 verifier built from `auth0`. Tests pass a fake so
   * routes can run without a real JWT.
   */
  verifyToken?: TokenVerifier
}

export function createApp(config: AppConfig): Hono<AuthEnv> {
  // AuthEnv tells Hono the auth middleware will put a string `userId` on every
  // request's context, so handlers can c.get('userId').
  const app = new Hono<AuthEnv>()

  /**
   * CORS — must run BEFORE the secret gate. Browsers send a preflight OPTIONS
   * request (with no secret) before any cross-origin POST/PUT or any request
   * carrying a custom header like x-demo-secret; if the gate saw that preflight
   * it would 401 it and the real request would never happen.
   *
   * Demo-permissive: any origin is allowed because the shared secret — not the
   * origin — is the gate. `x-demo-secret` is allow-listed so the browser will
   * actually send it on cross-origin calls. Tighten `origin` to specific URLs
   * when this becomes a real product.
   */
  app.use(
    '*',
    cors({
      origin: '*',
      allowMethods: ['GET', 'POST', 'PUT', 'OPTIONS'],
      allowHeaders: ['content-type', 'authorization'],
    }),
  )

  /**
   * Auth gate. Runs before every route; `/health` is exempt so uptime checks
   * work without a token. Everything else needs a valid Auth0 Bearer token —
   * the middleware verifies it and stashes `userId` on the context.
   */
  const auth = createAuthMiddleware(config.verifyToken ?? createAuth0Verifier(config.auth0))
  app.use('*', async (c, next) => {
    if (c.req.path === '/health') return next()
    return auth(c, next)
  })

  /** Liveness check — ungated. */
  app.get('/health', (c) => c.json({ ok: true, service: 'matchview-backend' }))

  /** Upload routes: POST /uploads, POST /uploads/complete (gated). */
  app.route('/', createUploadsRouter({ storage: config.storage, partSize: config.partSize }))

  /** Project sync routes: PUT /projects/:id, GET /projects, GET /projects/:id (gated). */
  app.route('/', createProjectsRouter({ objects: config.objects }))

  /** Media catalog + download routes: PUT/GET /media, GET /media/:id, GET /media/:id/url (gated). */
  app.route('/', createMediaRouter({ objects: config.objects }))

  return app
}
