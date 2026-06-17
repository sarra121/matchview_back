/**
 * Smoke test against a RUNNING server over the network (real HTTP), used to
 * verify the containerized backend. Unlike the other smokes, this does NOT
 * build the app in-process — it talks to whatever is listening at BASE_URL.
 *
 * Run (with the container up): npm run smoke:http
 */

const base = process.env.BASE_URL ?? 'http://localhost:8787'
const secret = process.env.DEMO_SECRET
if (!secret) {
  throw new Error('DEMO_SECRET required — run via `npm run smoke:http` so .env is loaded.')
}
const headers = { 'content-type': 'application/json', 'x-demo-secret': secret }

console.log(`Testing ${base}`)

const health = await fetch(`${base}/health`)
console.log('GET  /health            ->', health.status, await health.text())

const noSecret = await fetch(`${base}/projects`)
console.log('GET  /projects (no key) ->', noSecret.status, '(expect 401)')

const id = `container-${crypto.randomUUID()}`
const put = await fetch(`${base}/projects/${id}`, {
  method: 'PUT',
  headers,
  body: JSON.stringify({
    name: 'Container Test',
    updatedAt: Date.now(),
    project: { hello: 'from the container' },
  }),
})
console.log(`PUT  /projects/${id} ->`, put.status, '(expect 200)')

const list = await fetch(`${base}/projects`, { headers })
const listJson = (await list.json()) as { projects: { id: string; name: string }[] }
console.log('GET  /projects          ->', list.status, `(count=${listJson.projects.length})`)

const got = await fetch(`${base}/projects/${id}`, { headers })
console.log(`GET  /projects/${id} ->`, got.status, JSON.stringify(await got.json()))

console.log('\nContainer smoke OK.')
