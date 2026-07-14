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

/**
 * Emit a copy-friendly, deduped-by-image summary of what the update check
 * just found to admin-sh's stdout logs. Self-hosted operators can open the
 * admin-sh logs in the dashboard (Services → admin-sh → View logs, which has
 * a Download button) and paste this line when reporting "I always have
 * updates" — it shows, per image, the running tag vs. the newest tag the
 * registry offers, so we can tell at a glance whether it's a real gap (their
 * pins lag the published images) or a checker bug. Runs on every /api/updates
 * call, but the dashboard only refetches on mount + manual refresh
 * (staleTime 60s), so this isn't chatty.
 */
function logUpdateCheck(results: UpdateInfo[]): void {
  // Collapse the per-container rows to one per image — the bots-* services
  // all share the main-app image, so without this the log repeats it ~11x.
  const byImage = new Map<
    string,
    {
      image: string
      repo: string | null
      current: string | null
      latest: string | null
      hasUpdate: boolean
      error?: string
      services: string[]
    }
  >()
  for (const r of results) {
    const key = r.repo ? `${r.repo}:${r.current ?? ''}` : r.image
    const existing = byImage.get(key)
    if (existing) {
      existing.services.push(r.service)
      continue
    }
    byImage.set(key, {
      image: r.image,
      repo: r.repo,
      current: r.current,
      latest: r.latest,
      hasUpdate: r.hasUpdate,
      ...(r.error ? { error: r.error } : {}),
      services: [r.service],
    })
  }
  const images = [...byImage.values()]
  logger.info('update check', {
    updatesAvailable: images.filter((i) => i.hasUpdate).length,
    imagesChecked: images.length,
    images: images.map((i) => ({
      image: i.image,
      current: i.current,
      latest: i.latest,
      hasUpdate: i.hasUpdate,
      ...(i.error ? { error: i.error } : {}),
      services: i.services.sort(),
    })),
  })
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
    logUpdateCheck(results)
    res.json(results)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger.error('updates list failed', { err: message })
    res.status(500).json({ error: message })
  }
})
