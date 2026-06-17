import { describe, it, expect } from 'vitest'
import { createApp } from './app.ts'
import type { MultipartStorage, ObjectStore, UploadPartRef } from './storage.ts'

const SECRET = 'test-secret'

/** Projects aren't exercised here, so a do-nothing object store is fine. */
const noopObjects: ObjectStore = {
  async putJson() {},
  async getJson() {
    return null
  },
  async listKeys() {
    return []
  },
}

/** An in-memory stand-in for R2 that records what it was asked to do. */
function makeFakeStorage() {
  const calls = {
    started: [] as { key: string; contentType: string }[],
    presigned: [] as { key: string; uploadId: string; partNumber: number }[],
    completed: [] as { key: string; uploadId: string; parts: UploadPartRef[] }[],
  }
  const storage: MultipartStorage = {
    async start({ key, contentType }) {
      calls.started.push({ key, contentType })
      return { uploadId: `upload-for-${key}` }
    },
    async presignPart({ key, uploadId, partNumber }) {
      calls.presigned.push({ key, uploadId, partNumber })
      return `https://r2.example/${key}?uploadId=${uploadId}&part=${partNumber}`
    },
    async complete({ key, uploadId, parts }) {
      calls.completed.push({ key, uploadId, parts })
    },
  }
  return { storage, calls }
}

function appWith(storage: MultipartStorage, partSize = 100) {
  return createApp({ demoSecret: SECRET, storage, objects: noopObjects, partSize })
}

const auth = { 'content-type': 'application/json', 'x-demo-secret': SECRET }

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
    expect(json.uploadId).toBe(`upload-for-${json.key}`)
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
