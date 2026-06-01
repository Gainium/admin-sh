import { Router } from 'express'
import { listProjectContainers, type ServiceContainer } from '../docker'
import { checkForUpdate, parseImageRef } from '../registry'
import { logger } from '../logger'

export const updatesRouter = Router()

interface UpdateInfo {
  service: string
  containerId: string
  image: string
  repo: string | null
  current: string | null
  latest: string | null
  hasUpdate: boolean
  error?: string
}

async function inspectOne(c: ServiceContainer): Promise<UpdateInfo> {
  const parsed = parseImageRef(c.image)
  const base = {
    service: c.service,
    containerId: c.id,
    image: c.image,
  }
  if (!parsed) {
    return {
      ...base,
      repo: null,
      current: c.imageTag,
      latest: null,
      hasUpdate: false,
      error: 'digest-pinned image; cannot resolve registry tags',
    }
  }
  try {
    const result = await checkForUpdate(parsed.repo, parsed.tag, parsed.host)
    return { ...base, repo: parsed.repo, ...result }
  } catch (err) {
    return {
      ...base,
      repo: parsed.repo,
      current: parsed.tag,
      latest: null,
      hasUpdate: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

updatesRouter.get('/', async (_req, res) => {
  try {
    const containers = await listProjectContainers()

    // Multiple bots-* services share the same main-app image. Group by
    // (repo, tag) so we don't query the registry N times for the same repo.
    const seen = new Map<string, Promise<UpdateInfo>>()
    const results = await Promise.all(
      containers.map((c) => {
        const parsed = parseImageRef(c.image)
        const key = parsed ? `${parsed.repo}:${parsed.tag ?? ''}` : c.id
        let p = seen.get(key)
        if (!p) {
          p = inspectOne(c)
          seen.set(key, p)
        }
        // For grouped lookups we still need a per-service row; clone the
        // shared lookup result but stamp the actual container's service/id.
        return p.then((shared) => ({
          ...shared,
          service: c.service,
          containerId: c.id,
        }))
      }),
    )
    res.json(results)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger.error('updates list failed', { err: message })
    res.status(500).json({ error: message })
  }
})
