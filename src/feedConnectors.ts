// Detects which price-feed roles are actually running, so the Diagnostics page
// can explain "no ticks" in terms of configuration — the root cause behind
// community thread 4872 was a candle-only connector never producing the
// `trade@` ticker feed that paper/live fills consume.

import { listProjectContainers, inspectContainer } from './docker'
import { logger } from './logger'

// Exchanges with NO candle producer in the websocket-connector — they stream
// ONLY via the ticker feed (`trade@`), so a candle-only deployment produces
// nothing for them at all. Derived from
// websocket-connector-sh/src/price/*.ts: as of 2026-07 every integration has a
// candle path EXCEPT coinbase (its init() runs only in ticker/all role). Keep
// in sync with that directory.
export const TICKER_ONLY_EXCHANGES = ['coinbase'] as const

export interface FeedConnector {
  service: string
  running: boolean
  /** raw PRICEROLE (candle | all | ticker | unset) */
  role: string
  /** produces the `trade@` ticker feed that paper/live fills consume */
  producesTicker: boolean
  /** produces the `*Candle` streams (charts / indicators) */
  producesCandle: boolean
  /** PRICE_CONNECTOR_EXCHANGES this connector is configured for */
  exchanges: string[]
}

function envVal(env: string[] | undefined, key: string): string | undefined {
  const hit = env?.find((e) => e.startsWith(`${key}=`))
  return hit?.slice(key.length + 1)
}

export async function detectFeedConnectors(): Promise<FeedConnector[]> {
  const containers = await listProjectContainers()
  const candidates = containers.filter((c) =>
    c.image.includes('websocket-connector'),
  )
  const out: FeedConnector[] = []
  for (const c of candidates) {
    let env: string[] | undefined
    let cmd = ''
    try {
      const info = await inspectContainer(c.id)
      env = info.Config?.Env ?? undefined
      cmd = (info.Config?.Cmd ?? []).join(' ')
    } catch (err) {
      logger.warn('feed connector inspect failed', {
        service: c.service,
        err: err instanceof Error ? err.message : String(err),
      })
    }
    // Only the PRICE connector (`npm run price`) is a market-data feed. The
    // same image also runs the user-stream connector (`npm run main`) — skip it.
    const isPriceFeed = cmd.includes('price') || !!envVal(env, 'PRICE_CONNECTOR_EXCHANGES')
    if (!isPriceFeed) continue

    const role = (envVal(env, 'PRICEROLE') ?? '').trim()
    // Mirrors websocket-connector-sh priceConnector.ts: candles run when the
    // role is 'candle' or 'all'; the `trade@` ticker feed runs when the role is
    // NOT 'candle' (i.e. 'all', 'ticker', or unset).
    out.push({
      service: c.service || c.name,
      running: c.state === 'running',
      role: role || 'unset',
      producesCandle: role === 'candle' || role === 'all',
      producesTicker: role !== 'candle',
      exchanges: (envVal(env, 'PRICE_CONNECTOR_EXCHANGES') ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    })
  }
  return out
}
