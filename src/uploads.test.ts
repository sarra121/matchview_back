import { describe, it, expect } from 'vitest'
import { createApp } from './app.ts'
import type { MultipartStorage, ObjectStore, UploadPartRef, UploadedPart } from './storage.ts'

/** Test double for auth: accepts one known token, rejects everything else. */
const fakeVerify = async (token: string) => {
  if (token !== 'test-token') throw new Error('bad token')
  return { userId: 'test-user' }
}

/** Projects aren't exercised here, so a do-nothing object store is fine. */
const noopObjects: ObjectStore = {
  async putJson() {},
  async getJson() {
    return null
  },
  async listKeys() {
    return []
  },
  async presignGet() {
    return 'https://r2.example/x?signed'
  },
}

/** An in-memory stand-in for R2 that records what it was asked to do. */
function makeFakeStorage() {
  const calls = {
    started: [] as { key: string; contentType: string }[],
    presigned: [] as { key: string; uploadId: string; partNumber: number }[],
    listed: [] as { key: string; uploadId: string }[],
    completed: [] as { key: string; uploadId: string; parts: UploadPartRef[] }[],
  }
  // What the fake pretends R2 already holds; a test can push parts here to
  // exercise the resume path.
  const partsOnServer: UploadedPart[] = []
  const storage: MultipartStorage = {
    async start({ key, contentType }) {
      calls.started.push({ key, contentType })
      return { uploadId: `upload-for-${key}` }
    },
    async presignPart({ key, uploadId, partNumber }) {
      calls.presigned.push({ key, uploadId, partNumber })
      return `https://r2.example/${key}?uploadId=${uploadId}&part=${partNumber}`
    },
    async listParts({ key, uploadId }) {
      calls.listed.push({ key, uploadId })
      return partsOnServer
    },
    async complete({ key, uploadId, parts }) {
      calls.completed.push({ key, uploadId, parts })
    },
  }
  return { storage, calls, partsOnServer }
}

function appWith(storage: MultipartStorage, partSize = 100) {
  return createApp({
    auth0: { domain: 'test.auth0', audience: 'test' },
    storage,
    objects: noopObjects,
    partSize,
    verifyToken: fakeVerify,
  })
}

const auth = { 'content-type': 'application/json', authorization: 'Bearer test-token' }

describe('POST /uploads', () => {
  it('splits the file into the right number of chunks', async () => {
    const { storage, calls } = makeFakeStorage()
    const app = appWith(storage, 100) // 100-byte chunks

    const res = await app.request('/uploads', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ filename: 'match.mp4', contentType: 'video/mp4', size: 250 }),
    })

    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      parts: { partNumber: number }[]
      key: string
      uploadId: string
    }
    // 250 bytes / 100-byte chunks = 3 chunks (rounding up)
    expect(json.parts).toHaveLength(3)
    expect(json.parts.map((p) => p.partNumber)).toEqual([1, 2, 3])
    expect(json.key).toMatch(/^videos\/.+\/source\.mp4$/)
    // The client sees an unscoped key, but storage was called with the
    // per-user-scoped key (users/<userId>/…), so the fake's uploadId reflects it.
    expect(json.uploadId).toBe(`upload-for-users/test-user/${json.key}`)
    expect(calls.presigned).toHaveLength(3)
  })

  it('rejects a body with no size', async () => {
    const { storage } = makeFakeStorage()
    const res = await appWith(storage).request('/uploads', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ filename: 'match.mp4', contentType: 'video/mp4' }),
    })
    expect(res.status).toBe(400)
  })
})

describe('POST /uploads/status', () => {
  it('returns the parts storage says R2 already holds', async () => {
    const { storage, calls, partsOnServer } = makeFakeStorage()
    // Pretend R2 already received parts 1 and 2.
    partsOnServer.push({ partNumber: 1, etag: 'e1', size: 100 }, { partNumber: 2, etag: 'e2', size: 100 })

    const res = await appWith(storage).request('/uploads/status', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ key: 'videos/abc/source.mp4', uploadId: 'u1' }),
    })

    expect(res.status).toBe(200)
    const json = (await res.json()) as { parts: UploadedPart[] }
    expect(json.parts.map((p) => p.partNumber)).toEqual([1, 2])
    // Storage was asked about the right upload — with the per-user-scoped key.
    expect(calls.listed).toEqual([{ key: 'users/test-user/videos/abc/source.mp4', uploadId: 'u1' }])
  })

  it('rejects a body with no uploadId', async () => {
    const { storage } = makeFakeStorage()
    const res = await appWith(storage).request('/uploads/status', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ key: 'videos/abc/source.mp4' }),
    })
    expect(res.status).toBe(400)
  })
})

describe('POST /uploads/parts', () => {
  it('signs a fresh URL for each requested part number', async () => {
    const { storage, calls } = makeFakeStorage()
    const res = await appWith(storage).request('/uploads/parts', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ key: 'videos/abc/source.mp4', uploadId: 'u1', partNumbers: [2, 5] }),
    })

    expect(res.status).toBe(200)
    const json = (await res.json()) as { parts: { partNumber: number; url: string }[] }
    expect(json.parts.map((p) => p.partNumber)).toEqual([2, 5])
    expect(json.parts.every((p) => typeof p.url === 'string' && p.url.length > 0)).toBe(true)
    // Only the two asked-for parts were signed.
    expect(calls.presigned.map((p) => p.partNumber)).toEqual([2, 5])
  })

  it('rejects an empty partNumbers array', async () => {
    const { storage } = makeFakeStorage()
    const res = await appWith(storage).request('/uploads/parts', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ key: 'k', uploadId: 'u', partNumbers: [] }),
    })
    expect(res.status).toBe(400)
  })
})

describe('POST /uploads/complete', () => {
  it('forwards the stitched parts to storage', async () => {
    const { storage, calls } = makeFakeStorage()
    const res = await appWith(storage).request('/uploads/complete', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        key: 'videos/abc/source.mp4',
        uploadId: 'u1',
        parts: [{ partNumber: 1, etag: 'e1' }],
      }),
    })
    expect(res.status).toBe(200)
    expect(calls.completed).toHaveLength(1)
    expect(calls.completed[0]?.parts).toEqual([{ partNumber: 1, etag: 'e1' }])
  })

  it('rejects an empty parts array', async () => {
    const { storage } = makeFakeStorage()
    const res = await appWith(storage).request('/uploads/complete', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ key: 'k', uploadId: 'u', parts: [] }),
    })
    expect(res.status).toBe(400)
  })
})
