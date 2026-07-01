// Market-data feed probe.
//
// The websocket-connector publishes live prices over Redis pub/sub:
//   trade@{symbol}@{exchange}                 (per tick)
//   {symbol}@{exchange}@{interval}Candle      (per closed candle)
// (producer: websocket-connector-sh/src/price/common.ts)
//
// paper-trading consumes those exact channels to fill simulated orders. So if
// an exchange is enabled but nothing is publishing on its channels, paper (and
// live) fills silently never trigger — the failure mode behind community
// thread 4872 ("DCA buys on Coinbase simulation not buying"): Coinbase was
// enabled but its feed wasn't ticking.
//
// This probe briefly pattern-subscribes and tallies traffic per exchange, so
// the Diagnostics page can flag "enabled but no ticks" before a user has to
// notice their bot isn't trading.

import { createRedisConnection } from './redis'
import { logger } from './logger'

const TRADE_PATTERN = 'trade@*@*'
const CANDLE_PATTERN = '*Candle'

export interface ExchangeFeed {
  exchange: string
  enabled: boolean
  tradeMsgs: number
  candleMsgs: number
  lastSymbol: string | null
  /** true if any trade or candle arrived during the window */
  live: boolean
}

export interface FeedProbeResult {
  windowMs: number
  perExchange: ExchangeFeed[]
  /** enabled exchanges that produced zero traffic — the actionable list */
  stalled: string[]
  liveCount: number
}

interface Tally {
  trade: number
  candle: number
  lastSymbol: string | null
}

/** Extract the exchange token from a market-data channel name. */
function exchangeOf(channel: string): { exchange: string; symbol: string; kind: 'trade' | 'candle' } | null {
  if (channel.startsWith('trade@')) {
    // trade@SYMBOL@EXCHANGE
    const [, symbol, exchange] = channel.split('@')
    if (!exchange) return null
    return { exchange, symbol: symbol ?? '', kind: 'trade' }
  }
  if (channel.endsWith('Candle')) {
    // SYMBOL@EXCHANGE@INTERVALCandle
    const [symbol, exchange] = channel.replace(/Candle$/, '').split('@')
    if (!exchange) return null
    return { exchange, symbol: symbol ?? '', kind: 'candle' }
  }
  return null
}

/**
 * Subscribe to the market-data patterns for `windowMs`, tally per exchange,
 * then cross-reference the enabled-exchanges set.
 *
 * @param enabled  the configured enabled list, or null = "all enabled"
 * @param known    the full known-exchange set (so we can list enabled ones
 *                 that produced nothing, even if they never appeared)
 */
export async function probeFeeds(
  windowMs: number,
  enabled: string[] | null,
  known: readonly string[],
): Promise<FeedProbeResult> {
  const sub = createRedisConnection()
  const tally = new Map<string, Tally>()

  const onMessage = (_pattern: string, channel: string, _message: string) => {
    const parsed = exchangeOf(channel)
    if (!parsed) return
    const t = tally.get(parsed.exchange) ?? { trade: 0, candle: 0, lastSymbol: null }
    if (parsed.kind === 'trade') t.trade += 1
    else t.candle += 1
    if (parsed.symbol) t.lastSymbol = parsed.symbol
    tally.set(parsed.exchange, t)
  }

  try {
    sub.on('pmessage', onMessage)
    await sub.psubscribe(TRADE_PATTERN, CANDLE_PATTERN)
    await new Promise((resolve) => setTimeout(resolve, windowMs))
  } catch (err) {
    logger.error('feed probe failed', {
      err: err instanceof Error ? err.message : String(err),
    })
  } finally {
    sub.off('pmessage', onMessage)
    // quit() also tears down the subscription; ignore teardown errors.
    await sub.quit().catch(() => undefined)
  }

  // An exchange is "enabled" if the set is null (all) or contains it.
  const isEnabled = (ex: string) => enabled === null || enabled.includes(ex)

  // Report every enabled exchange (so stalled ones surface) plus any exchange
  // that produced traffic but isn't in the enabled set (unexpected — worth
  // seeing).
  const base = enabled === null ? [...known] : enabled
  const universe = new Set<string>([...base, ...tally.keys()])

  const perExchange: ExchangeFeed[] = [...universe]
    .map((exchange) => {
      const t = tally.get(exchange) ?? { trade: 0, candle: 0, lastSymbol: null }
      return {
        exchange,
        enabled: isEnabled(exchange),
        tradeMsgs: t.trade,
        candleMsgs: t.candle,
        lastSymbol: t.lastSymbol,
        live: t.trade > 0 || t.candle > 0,
      }
    })
    .sort((a, b) => a.exchange.localeCompare(b.exchange))

  const stalled = perExchange
    .filter((f) => f.enabled && !f.live)
    .map((f) => f.exchange)

  return {
    windowMs,
    perExchange,
    stalled,
    liveCount: perExchange.filter((f) => f.live).length,
  }
}
