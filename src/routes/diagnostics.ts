import { Router } from 'express'
import { listProjectContainers } from '../docker'
import { getRedis } from '../redis'
import { getEnabledExchanges, KNOWN_EXCHANGES } from '../config'
import { probeFeeds } from '../feeds'
import { logger } from '../logger'

// One-stop ops-health snapshot for the self-hosted Diagnostics page:
//   - every compose service's up/health state
//   - Redis reachability + latency
//   - live market-data feed liveness per exchange (the "enabled but no ticks"
//     check that catches the paper-not-filling class of bug)

export const diagnosticsRouter = Router()

const DEFAULT_WINDOW_MS = 2500
const MIN_WINDOW_MS = 500
const MAX_WINDOW_MS = 8000

function clampWindow(raw: unknown): number {
  const n = Number(raw)
  if (!Number.isFinite(n)) return DEFAULT_WINDOW_MS
  return Math.min(Math.max(n, MIN_WINDOW_MS), MAX_WINDOW_MS)
}

async function pingRedis(): Promise<{ ok: boolean; latencyMs?: number; error?: string }> {
  const start = Date.now()
  try {
    await getRedis().ping()
    return { ok: true, latencyMs: Date.now() - start }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

// GET /api/diagnostics — full snapshot. `?window=<ms>` tunes the feed probe.
diagnosticsRouter.get('/', async (req, res) => {
  const windowMs = clampWindow(req.query.window)
  try {
    const [services, enabled, redis] = await Promise.all([
      listProjectContainers().catch((err) => {
        logger.warn('diagnostics: container list failed', {
          err: err instanceof Error ? err.message : String(err),
        })
        return []
      }),
      getEnabledExchanges().catch(() => null),
      pingRedis(),
    ])

    const feeds = await probeFeeds(windowMs, enabled, KNOWN_EXCHANGES)

    res.json({
      ts: Date.now(),
      services: services.map((s) => ({
        service: s.service,
        state: s.state,
        status: s.status,
        health: s.health,
        imageTag: s.imageTag,
        up: s.state === 'running',
      })),
      redis,
      feeds,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger.error('diagnostics snapshot failed', { err: message })
    res.status(500).json({ error: message })
  }
})

// GET /api/diagnostics/feeds — just the market-data probe (lighter/pollable).
diagnosticsRouter.get('/feeds', async (req, res) => {
  const windowMs = clampWindow(req.query.window)
  try {
    const enabled = await getEnabledExchanges().catch(() => null)
    const feeds = await probeFeeds(windowMs, enabled, KNOWN_EXCHANGES)
    res.json(feeds)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger.error('diagnostics feed probe failed', { err: message })
    res.status(500).json({ error: message })
  }
})
