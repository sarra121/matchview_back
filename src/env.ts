/**
 * Reads and validates the environment the server needs to boot.
 *
 * Kept as a pure function (takes the env object as an argument) so tests can
 * pass a fake env instead of mutating `process.env`. Tests don't call this at
 * all — they build the app with a fake storage — so R2 creds are only needed
 * to run the real server.
 */

export interface R2Env {
  accountId: string
  accessKeyId: string
  secretAccessKey: string
  bucket: string
}

export interface Env {
  /** Shared secret that gates every route except /health. */
  demoSecret: string
  /** TCP port the HTTP server listens on. */
  port: number
  /** Cloudflare R2 connection settings. */
  r2: R2Env
  /** Upload chunk size in bytes. */
  partSize: number
}

const DEFAULT_PART_SIZE = 100 * 1024 * 1024 // 100 MB
const MIN_PART_SIZE = 5 * 1024 * 1024 // 5 MB — an S3/R2 rule for multipart uploads

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const demoSecret = source.DEMO_SECRET
  if (!demoSecret) {
    throw new Error('DEMO_SECRET is required — copy .env.example to .env and set it.')
  }

  const port = Number(source.PORT ?? 8787)
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`PORT must be a positive integer, got: ${source.PORT}`)
  }

  const r2: R2Env = {
    accountId: required(source, 'R2_ACCOUNT_ID'),
    accessKeyId: required(source, 'R2_ACCESS_KEY_ID'),
    secretAccessKey: required(source, 'R2_SECRET_ACCESS_KEY'),
    bucket: required(source, 'R2_BUCKET'),
  }

  const partSize = Number(source.PART_SIZE ?? DEFAULT_PART_SIZE)
  if (!Number.isInteger(partSize) || partSize < MIN_PART_SIZE) {
    throw new Error(`PART_SIZE must be an integer of at least ${MIN_PART_SIZE} bytes (5 MB), got: ${source.PART_SIZE}`)
  }

  return { demoSecret, port, r2, partSize }
}

function required(source: NodeJS.ProcessEnv, name: string): string {
  const value = source[name]
  if (!value) {
    throw new Error(`${name} is required — see .env.example.`)
  }
  return value
}
