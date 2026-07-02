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

/** In-memory ObjectStore backed by a Map, so project routes need no real R2. */
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

describe('project sync', () => {
  it('stores projects, lists them newest-first, and reads one back', async () => {
    const app = appWith(makeMemoryStore())

    const putA = await app.request('/projects/aaa', {
      method: 'PUT',
      headers: auth,
      body: JSON.stringify({ name: 'Match A', updatedAt: 100, project: { foo: 1 } }),
    })
    expect(putA.status).toBe(200)

    await app.request('/projects/bbb', {
      method: 'PUT',
      headers: auth,
      body: JSON.stringify({ name: 'Match B', updatedAt: 200, project: { bar: 2 } }),
    })

    const listRes = await app.request('/projects', { headers: auth })
    expect(listRes.status).toBe(200)
    const list = (await listRes.json()) as {
      projects: { id: string; name: string; updatedAt: number }[]
    }
    // bbb has the newer updatedAt (200 > 100), so it sorts first.
    expect(list.projects.map((p) => p.id)).toEqual(['bbb', 'aaa'])

    const getRes = await app.request('/projects/aaa', { headers: auth })
    expect(getRes.status).toBe(200)
    const got = (await getRes.json()) as { id: string; project: { foo: number } }
    expect(got.project).toEqual({ foo: 1 })
  })

  it('returns 404 for an unknown project', async () => {
    const res = await appWith(makeMemoryStore()).request('/projects/nope', { headers: auth })
    expect(res.status).toBe(404)
  })

  it('rejects a PUT that is missing the name', async () => {
    const res = await appWith(makeMemoryStore()).request('/projects/x', {
      method: 'PUT',
      headers: auth,
      body: JSON.stringify({ updatedAt: 1, project: {} }),
    })
    expect(res.status).toBe(400)
  })
})
