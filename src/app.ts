/**
 * The Hono application — all routes and middleware, but no server.
 *
 * Built via a factory (`createApp`) that takes its config as an argument so
 * tests can spin up an app with a known secret and FAKE storage, then call
 * `app.request(...)` without a real port or real R2. `server.ts` is the thin
 * wrapper that reads the real env and actually listens.
 */

import { Hono } from 'hono'
import type { MultipartStorage, ObjectStore } from './storage.ts'
import { createUploadsRouter } from './uploads.ts'
import { createProjectsRouter } from './projects.ts'

export interface AppConfig {
  /** The value an incoming request must send in `x-demo-secret`. */
  demoSecret: string
  /** Where big video uploads go — real R2 in the server, a fake in tests. */
  storage: MultipartStorage
  /** Where project JSON files go — real R2 in the server, a fake in tests. */
  objects: ObjectStore
  /** Upload chunk size in bytes. */
  partSize: number
}

export function createApp(config: AppConfig): Hono {
  const app = new Hono()

  /**
   * Shared-secret gate. Runs before every route; `/health` is exempt so uptime
   * checks work without a secret. Everything else is 401 unless the header
   * matches exactly. When we add real accounts later, only this changes.
   */
  app.use('*', async (c, next) => {
    if (c.req.path === '/health') return next()

    const provided = c.req.header('x-demo-secret')
    if (provided !== config.demoSecret) {
      return c.json({ error: 'unauthorized' }, 401)
    }

    return next()
  })

  /** Liveness check — ungated. */
  app.get('/health', (c) => c.json({ ok: true, service: 'matchview-backend' }))

  /** Upload routes: POST /uploads, POST /uploads/complete (gated). */
  app.route('/', createUploadsRouter({ storage: config.storage, partSize: config.partSize }))

  /** Project sync routes: PUT /projects/:id, GET /projects, GET /projects/:id (gated). */
  app.route('/', createProjectsRouter({ objects: config.objects }))

  return app
}
