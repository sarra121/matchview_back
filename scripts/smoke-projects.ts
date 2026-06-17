import { createApp } from '../src/app.ts'
import { createR2Storage, createR2ObjectStore } from '../src/r2.ts'
import { loadEnv } from '../src/env.ts'

const env = loadEnv()
const app = createApp({
  demoSecret: env.demoSecret,
  storage: createR2Storage(env.r2),
  objects: createR2ObjectStore(env.r2),
  partSize: env.partSize,
})
const headers = { 'content-type': 'application/json', 'x-demo-secret': env.demoSecret }

const idA = `demo-${crypto.randomUUID()}`
const idB = `demo-${crypto.randomUUID()}`

const samples = [
  { id: idA, name: 'Match A', updatedAt: 100, project: { note: 'first project' } },
  { id: idB, name: 'Match B', updatedAt: 200, project: { note: 'second project' } },
]

console.log('1/3  PUT two projects ...')
for (const s of samples) {
  const res = await app.request(`/projects/${s.id}`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({ name: s.name, updatedAt: s.updatedAt, project: s.project }),
  })
  if (res.status !== 200) {
    throw new Error(`PUT ${s.id} failed: ${res.status} ${await res.text()}`)
  }
  console.log(`     stored ${s.id} (${s.name})`)
}

console.log('2/3  GET /projects (list) ...')
const listRes = await app.request('/projects', { headers })
if (listRes.status !== 200) {
  throw new Error(`list failed: ${listRes.status} ${await listRes.text()}`)
}
const list = (await listRes.json()) as {
  projects: { id: string; name: string; updatedAt: number }[]
}
for (const p of list.projects) {
  console.log(`     - ${p.name}  (id=${p.id}, updatedAt=${p.updatedAt})`)
}

console.log('3/3  GET /projects/:id (pull one back) ...')
const getRes = await app.request(`/projects/${idA}`, { headers })
if (getRes.status !== 200) {
  throw new Error(`get failed: ${getRes.status} ${await getRes.text()}`)
}
const got = (await getRes.json()) as { id: string; project: unknown }
console.log(`     pulled ${got.id}:`, JSON.stringify(got.project))

console.log('\nDone. In your R2 bucket you should now see:')
console.log(`   projects/${idA}/project.json + meta.json`)
console.log(`   projects/${idB}/project.json + meta.json`)
