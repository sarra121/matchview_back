/**
 * Server entry point. Reads the real environment, builds the R2-backed app,
 * and listens.
 *
 * Run with `npm run dev` (auto-reloads) or `npm start`. Node loads `.env`
 * itself via the `--env-file=.env` flag in those scripts — no dotenv dependency.
 */

import { serve } from '@hono/node-server'
import { createApp } from './app.ts'
import { createR2Storage, createR2ObjectStore } from './r2.ts'
import { loadEnv } from './env.ts'

const env = loadEnv()
const storage = createR2Storage(env.r2)
const objects = createR2ObjectStore(env.r2)
const app = createApp({ demoSecret: env.demoSecret, storage, objects, partSize: env.partSize })

// hostname '0.0.0.0' = listen on all network addresses, so the server is
// reachable from outside the container (not just from inside it).
serve({ fetch: app.fetch, port: env.port, hostname: '0.0.0.0' }, (info) => {
  // eslint-disable-next-line no-console -- this is a standalone Node service, not the frontend
  console.log(`matchview-backend listening on http://localhost:${info.port}`)
})
