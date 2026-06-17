import { describe, it, expect } from 'vitest'
import { createApp } from './app.ts'
import type { MultipartStorage, ObjectStore } from './storage.ts'

const SECRET = 'test-secret'

/** Minimal stubs that do nothing — these tests only exercise the gate. */
const noopStorage: MultipartStorage = {
  async start() {
    return { uploadId: 'x' }
  },
  async presignPart() {
    return 'https://r2.example/x'
  },
  async complete() {},
}

const noopObjects: ObjectStore = {
  async putJson() {},
  async getJson() {
    return null
  },
  async listKeys() {
    return []
  },
}

const app = createApp({ demoSecret: SECRET, storage: noopStorage, objects: noopObjects, partSize: 100 })

describe('/health', () => {
  it('is reachable without a secret', async () => {
    const res = await app.request('/health')
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true })
  })
})

describe('shared-secret gate', () => {
  it('rejects a gated route when no secret is sent', async () => {
    const res = await app.request('/uploads', { method: 'POST' })
    expect(res.status).toBe(401)
  })

  it('rejects a gated route when the secret is wrong', async () => {
    const res = await app.request('/uploads', {
      method: 'POST',
      headers: { 'x-demo-secret': 'wrong' },
    })
    expect(res.status).toBe(401)
  })

  it('lets the request through when the secret matches', async () => {
    // The right secret passes the gate; the empty body then fails validation
    // (400), which still proves the gate let us reach the route.
    const res = await app.request('/uploads', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-demo-secret': SECRET },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
  })
})
