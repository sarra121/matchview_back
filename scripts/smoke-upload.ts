import { createApp } from '../src/app.ts'
import { createR2Storage } from '../src/r2.ts'
import { loadEnv } from '../src/env.ts'

const env = loadEnv()
const storage = createR2Storage(env.r2)
const app = createApp({ demoSecret: env.demoSecret, storage, partSize: env.partSize })
const headers = { 'content-type': 'application/json', 'x-demo-secret': env.demoSecret }

const body = new TextEncoder().encode(`MatchView R2 smoke test — uploaded ${new Date().toISOString()}\n`)

console.log('1/3  POST /uploads ...')
const startRes = await app.request('/uploads', {
  method: 'POST',
  headers,
  body: JSON.stringify({ filename: 'smoke-test.txt', contentType: 'text/plain', size: body.length }),
})
if (startRes.status !== 200) {
  throw new Error(`/uploads failed: ${startRes.status} ${await startRes.text()}`)
}
const start = (await startRes.json()) as {
  key: string
  uploadId: string
  parts: { partNumber: number; url: string }[]
}
console.log(`     key=${start.key}  parts=${start.parts.length}`)

console.log('2/3  PUT the chunk(s) straight to R2 ...')
const uploaded: { partNumber: number; etag: string }[] = []
for (const part of start.parts) {
  const offset = (part.partNumber - 1) * env.partSize
  const chunk = body.slice(offset, offset + env.partSize)
  const put = await fetch(part.url, { method: 'PUT', body: chunk })
  if (!put.ok) {
    throw new Error(`chunk ${part.partNumber} PUT failed: ${put.status} ${await put.text()}`)
  }
  const etag = put.headers.get('etag')
  if (!etag) throw new Error(`chunk ${part.partNumber} returned no ETag`)
  console.log(`     part ${part.partNumber} uploaded`)
  uploaded.push({ partNumber: part.partNumber, etag })
}

console.log('3/3  POST /uploads/complete ...')
const doneRes = await app.request('/uploads/complete', {
  method: 'POST',
  headers,
  body: JSON.stringify({ key: start.key, uploadId: start.uploadId, parts: uploaded }),
})
if (doneRes.status !== 200) {
  throw new Error(`/uploads/complete failed: ${doneRes.status} ${await doneRes.text()}`)
}

console.log(`\nDone. Open your R2 bucket and look for:\n   ${start.key}`)
