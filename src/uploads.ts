/**
 * Upload routes — hand the browser permission slips to upload a video directly
 * to R2 in chunks, then stitch the chunks. The backend never touches the bytes.
 *
 * The flow:
 *   1. POST /uploads          → backend starts a multipart upload and returns
 *                               one signed URL per chunk.
 *   2. browser PUTs each chunk straight to R2 (backend not involved), keeping
 *      the `ETag` R2 returns for each chunk.
 *   3. POST /uploads/complete → browser sends the parts+ETags back; backend
 *                               tells R2 to stitch them into the final file.
 *
 * Two extra routes support RESUMING an interrupted upload:
 *   • POST /uploads/status → which chunks R2 already has (so we skip them).
 *   • POST /uploads/parts  → fresh signed URLs for specific chunks (so a long
 *                            upload can re-sign chunks whose URLs expired).
 */

import { Hono } from 'hono'
import type { MultipartStorage } from './storage.ts'
import { scopeMultipart } from './scope-store.ts'
import type { AuthEnv } from './auth.ts'

export interface UploadsDeps {
  storage: MultipartStorage
  /** Chunk size in bytes; decides how many signed URLs we hand out. */
  partSize: number
}

/** Pull the file extension (including the dot) off a filename, or '' if none. */
function fileExtension(filename: string): string {
  const dot = filename.lastIndexOf('.')
  return dot > 0 ? filename.slice(dot) : ''
}

export function createUploadsRouter(deps: UploadsDeps): Hono<AuthEnv> {
  const router = new Hono<AuthEnv>()

  router.post('/uploads', async (c) => {
    const body = await c.req.json().catch(() => null)
    const filename = body?.filename
    const contentType = body?.contentType
    const size = body?.size

    if (
      typeof filename !== 'string' ||
      typeof contentType !== 'string' ||
      typeof size !== 'number' ||
      !Number.isFinite(size) ||
      size <= 0
    ) {
      return c.json(
        { error: 'filename (string), contentType (string), and size (positive number) are required' },
        400,
      )
    }

    // The `key` is the file's full path inside the bucket. Each video gets its
    // own folder via a random id so two "match.mp4"s never collide.
    const videoId = crypto.randomUUID()
    const key = `videos/${videoId}/source${fileExtension(filename)}`

    // Scope the storage to this user — bytes physically land at
    // users/<userId>/videos/... while `key` stays unprefixed for the client.
    const storage = scopeMultipart(deps.storage, c.get('userId'))
    const { uploadId } = await storage.start({ key, contentType })

    // How many chunks the file splits into, with a signed URL for each.
    const partCount = Math.max(1, Math.ceil(size / deps.partSize))
    const parts: { partNumber: number; url: string }[] = []
    for (let partNumber = 1; partNumber <= partCount; partNumber++) {
      const url = await storage.presignPart({ key, uploadId, partNumber })
      parts.push({ partNumber, url })
    }

    return c.json({ videoId, key, uploadId, partSize: deps.partSize, parts })
  })

  // Ask R2 which chunks it already holds for an in-progress upload. A resuming
  // browser calls this after a reload/interruption so it can skip finished
  // parts instead of re-uploading the whole file.
  router.post('/uploads/status', async (c) => {
    const body = await c.req.json().catch(() => null)
    const key = body?.key
    const uploadId = body?.uploadId

    if (typeof key !== 'string' || typeof uploadId !== 'string') {
      return c.json({ error: 'key (string) and uploadId (string) are required' }, 400)
    }

    const storage = scopeMultipart(deps.storage, c.get('userId'))
    const parts = await storage.listParts({ key, uploadId })
    return c.json({ parts })
  })

  // Hand out FRESH presigned URLs for a specific set of chunks. Unlike POST
  // /uploads (which signs every chunk up front, so late chunks of a long upload
  // outlive their 1-hour validity), the browser calls this on demand — right
  // before it uploads each batch, and again to replace any URL that expired.
  router.post('/uploads/parts', async (c) => {
    const body = await c.req.json().catch(() => null)
    const key = body?.key
    const uploadId = body?.uploadId
    const partNumbers = body?.partNumbers

    if (
      typeof key !== 'string' ||
      typeof uploadId !== 'string' ||
      !Array.isArray(partNumbers) ||
      partNumbers.length === 0 ||
      !partNumbers.every((n) => Number.isInteger(n) && n >= 1)
    ) {
      return c.json(
        {
          error:
            'key (string), uploadId (string), and a non-empty partNumbers array of positive integers are required',
        },
        400,
      )
    }

    const storage = scopeMultipart(deps.storage, c.get('userId'))
    const parts: { partNumber: number; url: string }[] = []
    for (const partNumber of partNumbers) {
      const url = await storage.presignPart({ key, uploadId, partNumber })
      parts.push({ partNumber, url })
    }
    return c.json({ parts })
  })

  router.post('/uploads/complete', async (c) => {
    const body = await c.req.json().catch(() => null)
    const key = body?.key
    const uploadId = body?.uploadId
    const parts = body?.parts

    if (
      typeof key !== 'string' ||
      typeof uploadId !== 'string' ||
      !Array.isArray(parts) ||
      parts.length === 0
    ) {
      return c.json({ error: 'key (string), uploadId (string), and a non-empty parts array are required' }, 400)
    }

    for (const p of parts) {
      if (typeof p?.partNumber !== 'number' || typeof p?.etag !== 'string') {
        return c.json({ error: 'each part needs a numeric partNumber and a string etag' }, 400)
      }
    }

    const storage = scopeMultipart(deps.storage, c.get('userId'))
    await storage.complete({ key, uploadId, parts })
    return c.json({ ok: true, key })
  })

  return router
}
