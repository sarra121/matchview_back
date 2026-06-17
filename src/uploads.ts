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
 */

import { Hono } from 'hono'
import type { MultipartStorage } from './storage.ts'

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

export function createUploadsRouter(deps: UploadsDeps): Hono {
  const router = new Hono()

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

    const { uploadId } = await deps.storage.start({ key, contentType })

    // How many chunks the file splits into, with a signed URL for each.
    const partCount = Math.max(1, Math.ceil(size / deps.partSize))
    const parts: { partNumber: number; url: string }[] = []
    for (let partNumber = 1; partNumber <= partCount; partNumber++) {
      const url = await deps.storage.presignPart({ key, uploadId, partNumber })
      parts.push({ partNumber, url })
    }

    return c.json({ videoId, key, uploadId, partSize: deps.partSize, parts })
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

    await deps.storage.complete({ key, uploadId, parts })
    return c.json({ ok: true, key })
  })

  return router
}
