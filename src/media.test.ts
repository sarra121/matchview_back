import { describe, it, expect } from 'vitest'
import { createApp } from './app.ts'
import type { MultipartStorage, ObjectStore } from './storage.ts'

/** Test double for auth: accepts one known token, rejects everything else. */
const fakeVerify = async (token: string) => {
  if (token !== 'test-token') throw new Error('bad token')
  return { userId: 'test-user' }
}

/** Uploads aren't exercised here. */
const noopStorage: MultipartStorage = {
  async start() {
    return { uploadId: 'x' }
  },
  async presignPart() {
    return 'https://r2.example/x'
  },
  async listParts() {
    return []
  },
  async complete() {},
}

/** In-memory ObjectStore backed by a Map, so media routes need no real R2. */
function makeMemoryStore(): ObjectStore {
  const map = new Map<string, unknown>()
  return {
    putJson: async (key, value) => {
      map.set(key, value)
    },
    getJson: async <T>(key: string): Promise<T | null> => {
      return map.has(key) ? (map.get(key) as T) : null
    },
    listKeys: async (prefix) => [...map.keys()].filter((k) => k.startsWith(prefix)),
    // Echo the key back so the test can assert the right object was signed.
    presignGet: async (key) => `https://r2.example/${key}?signed`,
  }
}

function appWith(objects: ObjectStore) {
  return createApp({
    auth0: { domain: 'test.auth0', audience: 'test' },
    storage: noopStorage,
    objects,
    partSize: 100,
    verifyToken: fakeVerify,
  })
}

const auth = { 'content-type': 'application/json', authorization: 'Bearer test-token' }

const sampleBody = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    fileName: 'match.mp4',
    size: 1024,
    contentType: 'video/mp4',
    r2Key: 'videos/v1/source.mp4',
    updatedAt: 100,
    ...over,
  })

describe('media sync', () => {
  it('stores media, lists newest-first, and reads one back', async () => {
    const app = appWith(makeMemoryStore())

    const putA = await app.request('/media/aaa', {
      method: 'PUT',
      headers: auth,
      body: sampleBody({ fileName: 'a.mp4', r2Key: 'videos/a/source.mp4', updatedAt: 100 }),
    })
    expect(putA.status).toBe(200)

    await app.request('/media/bbb', {
      method: 'PUT',
      headers: auth,
      body: sampleBody({ fileName: 'b.mp4', r2Key: 'videos/b/source.mp4', updatedAt: 200 }),
    })

    const listRes = await app.request('/media', { headers: auth })
    expect(listRes.status).toBe(200)
    const list = (await listRes.json()) as { media: { id: string; updatedAt: number }[] }
    // bbb has the newer updatedAt (200 > 100), so it sorts first.
    expect(list.media.map((m) => m.id)).toEqual(['bbb', 'aaa'])

    const getRes = await app.request('/media/aaa', { headers: auth })
    expect(getRes.status).toBe(200)
    const got = (await getRes.json()) as { media: { id: string; r2Key: string } }
    expect(got.media.r2Key).toBe('videos/a/source.mp4')
  })

  it('returns a presigned download URL for the stored r2Key', async () => {
    const app = appWith(makeMemoryStore())
    await app.request('/media/ccc', {
      method: 'PUT',
      headers: auth,
      body: sampleBody({ r2Key: 'videos/c/source.mp4' }),
    })

    const res = await app.request('/media/ccc/url', { headers: auth })
    expect(res.status).toBe(200)
    const { url } = (await res.json()) as { url: string }
    // The stored r2Key is signed through the per-user-scoped store.
    expect(url).toBe('https://r2.example/users/test-user/videos/c/source.mp4?signed')
  })

  it('returns 404 for an unknown media record (meta and url)', async () => {
    const app = appWith(makeMemoryStore())
    expect((await app.request('/media/nope', { headers: auth })).status).toBe(404)
    expect((await app.request('/media/nope/url', { headers: auth })).status).toBe(404)
  })

  it('rejects a PUT that is missing r2Key', async () => {
    const res = await appWith(makeMemoryStore()).request('/media/x', {
      method: 'PUT',
      headers: auth,
      body: JSON.stringify({ fileName: 'a.mp4', size: 1, contentType: 'video/mp4', updatedAt: 1 }),
    })
    expect(res.status).toBe(400)
  })
})
