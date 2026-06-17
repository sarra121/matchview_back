/**
 * Project sync routes — the cloud "meeting point" that lets a project travel
 * between browsers/devices.
 *
 *   PUT  /projects/:id   → store a project's JSON + its name/timestamp
 *   GET  /projects       → list all projects in the cloud (id, name, timestamp)
 *   GET  /projects/:id   → fetch one project's JSON back
 *
 * Layout in storage, per project:
 *   projects/<id>/project.json   the full project data (the timeline/edits)
 *   projects/<id>/meta.json      { id, name, updatedAt } — cheap to list
 */

import { Hono } from 'hono'
import type { ObjectStore } from './storage.ts'

export interface ProjectsDeps {
  objects: ObjectStore
}

interface ProjectMeta {
  id: string
  name: string
  /** Milliseconds since epoch of the last edit — used to sort + (later) resolve conflicts. */
  updatedAt: number
}

const dataKey = (id: string): string => `projects/${id}/project.json`
const metaKey = (id: string): string => `projects/${id}/meta.json`

export function createProjectsRouter(deps: ProjectsDeps): Hono {
  const router = new Hono()

  router.put('/projects/:id', async (c) => {
    const id = c.req.param('id')
    const body = await c.req.json().catch(() => null)
    const name = body?.name
    const updatedAt = body?.updatedAt
    const project = body?.project

    if (
      typeof name !== 'string' ||
      typeof updatedAt !== 'number' ||
      typeof project !== 'object' ||
      project === null
    ) {
      return c.json(
        { error: 'name (string), updatedAt (number), and project (object) are required' },
        400,
      )
    }

    const meta: ProjectMeta = { id, name, updatedAt }
    await deps.objects.putJson(dataKey(id), project)
    await deps.objects.putJson(metaKey(id), meta)
    return c.json({ ok: true, id })
  })

  router.get('/projects', async (c) => {
    const keys = await deps.objects.listKeys('projects/')
    const metaKeys = keys.filter((k) => k.endsWith('/meta.json'))

    const projects: ProjectMeta[] = []
    for (const k of metaKeys) {
      const meta = await deps.objects.getJson<ProjectMeta>(k)
      if (meta) projects.push(meta)
    }

    // Newest edit first.
    projects.sort((a, b) => b.updatedAt - a.updatedAt)
    return c.json({ projects })
  })

  router.get('/projects/:id', async (c) => {
    const id = c.req.param('id')
    const project = await deps.objects.getJson(dataKey(id))
    if (!project) {
      return c.json({ error: 'not found' }, 404)
    }
    return c.json({ id, project })
  })

  return router
}
