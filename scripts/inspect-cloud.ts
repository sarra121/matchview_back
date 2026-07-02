/**
 * Read-only diagnostic: dump what's actually stored in R2 so we can see whether
 * each project.json is a self-contained bundle ({ doc, media }) or a bare doc.
 *
 * Run: npm run inspect
 */

import { createR2ObjectStore } from '../src/r2.ts'
import { loadEnv } from '../src/env.ts'

const env = loadEnv()
const objects = createR2ObjectStore(env.r2)

const projectJsons = (await objects.listKeys('projects/')).filter((k) => k.endsWith('/project.json'))
console.log(`Found ${projectJsons.length} project.json file(s) in R2:\n`)

for (const key of projectJsons) {
  const data = await objects.getJson<Record<string, unknown>>(key)
  if (!data) {
    console.log(`${key}: (empty)`)
    continue
  }
  const topKeys = Object.keys(data)
  const isBundle = 'doc' in data && 'media' in data
  const media = (data as { media?: unknown[] }).media
  const mediaCount = Array.isArray(media) ? media.length : '— (no media array)'
  console.log(key)
  console.log(`   top-level keys : ${topKeys.join(', ')}`)
  console.log(`   bundle?        : ${isBundle ? 'YES ({ doc, media })' : 'NO (bare doc — pull cannot recreate media)'}`)
  console.log(`   media in bundle: ${mediaCount}\n`)
}

const mediaMetas = (await objects.listKeys('media/')).filter((k) => k.endsWith('/meta.json'))
console.log(`media/<id>/meta.json records in R2: ${mediaMetas.length}`)
