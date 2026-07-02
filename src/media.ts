/**
 * Media sync routes — the cloud catalog of uploaded media, plus download links.
 *
 * The bytes themselves go to R2 via the multipart upload flow (see uploads.ts);
 * THIS router only tracks lightweight metadata so any device can learn what
 * media exists in the cloud and fetch a file when it doesn't have the bytes
 * locally.
 *
 *   PUT  /media/:id      → store a media record (filename, size, r2Key, …)
 *   GET  /media          → list every media record in the cloud
 *   GET  /media/:id      → fetch one media record
 *   GET  /media/:id/url  → a temporary signed URL to download the bytes from R2
 *
 * Layout in storage, per media:
 *   media/<id>/meta.json   { id, fileName, size, contentType, r2Key, updatedAt }
 *
 * There is no `data.json` here (unlike projects): the actual bytes live at
 * `r2Key` (e.g. videos/<videoId>/source.mp4), written by the upload flow.
 */

import { Hono } from 'hono'
import type { ObjectStore } from './storage.ts'
import { scopeStore } from './scope-store.ts'
import type { AuthEnv } from './auth.ts'

export interface MediaDeps {
  objects: ObjectStore
}

interface MediaMeta {
  id: string
  fileName: string
  /** Byte size of the source file. */
  size: number
  contentType: string
  /** Where the bytes live in the bucket — the `key` returned by POST /uploads. */
  r2Key: string
  /** Milliseconds since epoch of the last change — used to sort + (later) resolve conflicts. */
  updatedAt: number
}

const metaKey = (id: string): string => `media/${id}/meta.json`

export function createMediaRouter(deps: MediaDeps): Hono<AuthEnv> {
  const router = new Hono<AuthEnv>()

  router.put('/media/:id', async (c) => {
    const id = c.req.param('id')
    const body = await c.req.json().catch(() => null)
    const fileName = body?.fileName
    const size = body?.size
    const contentType = body?.contentType
    const r2Key = body?.r2Key
    const updatedAt = body?.updatedAt

    if (
      typeof fileName !== 'string' ||
      typeof size !== 'number' ||
      !Number.isFinite(size) ||
      size <= 0 ||
      typeof contentType !== 'string' ||
      typeof r2Key !== 'string' ||
      typeof updatedAt !== 'number'
    ) {
      return c.json(
        {
          error:
            'fileName (string), size (positive number), contentType (string), r2Key (string), and updatedAt (number) are required',
        },
        400,
      )
    }

    const meta: MediaMeta = { id, fileName, size, contentType, r2Key, updatedAt }
    const store = scopeStore(deps.objects, c.get('userId'))
    await store.putJson(metaKey(id), meta)
    return c.json({ ok: true, id })
  })

  router.get('/media', async (c) => {
    const store = scopeStore(deps.objects, c.get('userId'))
    const keys = await store.listKeys('media/')
    const metaKeys = keys.filter((k) => k.endsWith('/meta.json'))

    const media: MediaMeta[] = []
    for (const k of metaKeys) {
      const meta = await store.getJson<MediaMeta>(k)
      if (meta) media.push(meta)
    }

    // Newest change first.
    media.sort((a, b) => b.updatedAt - a.updatedAt)
    return c.json({ media })
  })

  router.get('/media/:id', async (c) => {
    const id = c.req.param('id')
    const store = scopeStore(deps.objects, c.get('userId'))
    const meta = await store.getJson<MediaMeta>(metaKey(id))
    if (!meta) {
      return c.json({ error: 'not found' }, 404)
    }
    return c.json({ media: meta })
  })

  router.get('/media/:id/url', async (c) => {
    const id = c.req.param('id')
    const store = scopeStore(deps.objects, c.get('userId'))
    const meta = await store.getJson<MediaMeta>(metaKey(id))
    if (!meta) {
      return c.json({ error: 'not found' }, 404)
    }
    const url = await store.presignGet(meta.r2Key)
    return c.json({ url })
  })

  return router
}
