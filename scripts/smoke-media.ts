/**
 * Live smoke test for the media routes against REAL R2.
 *
 * Proves the genuinely-new piece — presignGet — actually works by fetching the
 * signed download URL over the network and checking the bytes come back.
 *
 * Run: npm run smoke:media   (loads .env so real R2 credentials are present)
 */

import { createApp } from '../src/app.ts'
import { createR2Storage, createR2ObjectStore } from '../src/r2.ts'
import { loadEnv } from '../src/env.ts'

const env = loadEnv()
// We keep our own handle to the object store so we can plant a real object at
// the r2Key (standing in for uploaded video bytes) before asking for a
// download URL.
const objects = createR2ObjectStore(env.r2)
const app = createApp({
  demoSecret: env.demoSecret,
  storage: createR2Storage(env.r2),
  objects,
  partSize: env.partSize,
})
const headers = { 'content-type': 'application/json', 'x-demo-secret': env.demoSecret }

const mediaId = `media-smoke-${crypto.randomUUID()}`
const r2Key = `videos/smoke-${crypto.randomUUID()}/source.json`
const marker = { marker: 'matchview-smoke', mediaId }

console.log('1/5  Plant fake "uploaded bytes" at the r2Key ...')
await objects.putJson(r2Key, marker)
console.log(`     wrote ${r2Key}`)

console.log('2/5  PUT /media/:id (register the media record) ...')
const putRes = await app.request(`/media/${mediaId}`, {
  method: 'PUT',
  headers,
  body: JSON.stringify({
    fileName: 'match.json',
    size: JSON.stringify(marker).length,
    contentType: 'application/json',
    r2Key,
    updatedAt: Date.now(),
  }),
})
if (putRes.status !== 200) {
  throw new Error(`PUT failed: ${putRes.status} ${await putRes.text()}`)
}
console.log(`     registered ${mediaId}`)

console.log('3/5  GET /media (list) ...')
const listRes = await app.request('/media', { headers })
if (listRes.status !== 200) throw new Error(`list failed: ${listRes.status}`)
const list = (await listRes.json()) as { media: { id: string; fileName: string }[] }
const found = list.media.find((m) => m.id === mediaId)
console.log(`     ${list.media.length} record(s); ours present: ${found ? 'yes' : 'NO'}`)
if (!found) throw new Error('our media record was not in the list')

console.log('4/5  GET /media/:id/url (presigned download URL) ...')
const urlRes = await app.request(`/media/${mediaId}/url`, { headers })
if (urlRes.status !== 200) throw new Error(`url failed: ${urlRes.status} ${await urlRes.text()}`)
const { url } = (await urlRes.json()) as { url: string }
console.log(`     got signed URL (${url.slice(0, 60)}...)`)

console.log('5/5  Fetch the signed URL over the network and verify bytes ...')
const download = await fetch(url)
if (!download.ok) throw new Error(`download failed: ${download.status} ${await download.text()}`)
const body = (await download.json()) as typeof marker
if (body.marker !== marker.marker) {
  throw new Error(`downloaded bytes did not match: ${JSON.stringify(body)}`)
}
console.log('     downloaded bytes match the planted marker ✓')

console.log('\nDone. presignGet is signing correctly against real R2.')
console.log('Leftover test object you can delete later:')
console.log(`   ${r2Key}`)
console.log(`   media/${mediaId}/meta.json`)
