import { describe, it, expect } from 'vitest'
import { createApp } from './app.ts'
import type { MultipartStorage, ObjectStore } from './storage.ts'

/** Test double for auth: accepts one known token, rejects everything else. */
const fakeVerify = async (token: string) => {
  if (token !== 'test-token') throw new Error('bad token')
  return { userId: 'test-user' }
}

/** Minimal stubs that do nothing — these tests only exercise the gate. */
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

const app = createApp({
  auth0: { domain: 'test.auth0', audience: 'test' },
  storage: noopStorage,
  objects: noopObjects,
  partSize: 100,
  verifyToken: fakeVerify,
})

describe('/health', () => {
  it('is reachable without a token', async () => {
    const res = await app.request('/health')
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true })
  })
})

describe('auth gate', () => {
  it('rejects a gated route when no token is sent', async () => {
    const res = await app.request('/uploads', { method: 'POST' })
    expect(res.status).toBe(401)
  })

  it('rejects a gated route when the token is invalid', async () => {
    const res = await app.request('/uploads', {
      method: 'POST',
      headers: { authorization: 'Bearer wrong' },
    })
    expect(res.status).toBe(401)
  })

  it('lets the request through when the token is valid', async () => {
    // A valid token passes the gate; the empty body then fails validation
    // (400), which still proves the gate let us reach the route.
    const res = await app.request('/uploads', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer test-token' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
  })
})
