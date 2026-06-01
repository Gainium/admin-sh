import { Router } from 'express'
import {
  getEnabledExchanges,
  KNOWN_EXCHANGES,
  setEnabledExchanges,
} from '../config'
import { logger } from '../logger'

export const exchangesRouter = Router()

exchangesRouter.get('/', async (_req, res) => {
  try {
    const enabled = await getEnabledExchanges()
    res.json({
      known: KNOWN_EXCHANGES,
      // null ⇒ "all enabled" (no key set). Surface that to the client.
      enabled,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger.error('exchanges get failed', { err: message })
    res.status(500).json({ error: message })
  }
})

exchangesRouter.put('/', async (req, res) => {
  const body = req.body as { enabled?: string[] | null }
  if (body.enabled !== null && !Array.isArray(body.enabled)) {
    res.status(400).json({
      error: 'Body must be { enabled: string[] | null }',
    })
    return
  }
  // Reject unknown exchange names so frontend bugs don't poison the
  // Redis state with typos.
  if (Array.isArray(body.enabled)) {
    const bad = body.enabled.filter(
      (x) => !KNOWN_EXCHANGES.includes(x as (typeof KNOWN_EXCHANGES)[number]),
    )
    if (bad.length) {
      res
        .status(400)
        .json({ error: `Unknown exchange names: ${bad.join(', ')}` })
      return
    }
  }
  try {
    await setEnabledExchanges(body.enabled ?? null)
    res.json({ ok: true })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger.error('exchanges set failed', { err: message })
    res.status(500).json({ error: message })
  }
})
