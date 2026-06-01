import {
  CONFIG_CHANNEL,
  ENABLED_EXCHANGES_KEY,
  getRedis,
} from './redis'
import { logger } from './logger'

// Source-of-truth: a JSON-encoded array of ExchangeEnum strings stored
// under ENABLED_EXCHANGES_KEY. Absent ⇒ all enabled (backward compat
// with deployments that predate this feature).

/**
 * Canonical list of exchange variants the admin UI exposes as
 * checkboxes. These are the **wire values** that the connectors and
 * exchange-routing code use at runtime — NOT the TypeScript enum keys.
 * The bybit futures entries are the headline case: `ExchangeEnum
 * .bybitCoinm` has wire value `'bybitInverse'` and `.bybitUsdm` has
 * `'bybitLinear'`. Get the keys here and the exchange-connector will
 * 503 every futures request because the Redis set wouldn't match.
 *
 * Keep this list in sync with the right-hand side of each entry in
 * websocket-connector-sh/src/utils/common.ts → ExchangeEnum. Paper
 * variants intentionally excluded — they shadow the real ones and the
 * operator doesn't toggle them independently.
 */
export const KNOWN_EXCHANGES = [
  'binance',
  'binanceUS',
  'binanceCoinm',
  'binanceUsdm',
  'kucoin',
  'kucoinLinear',
  'kucoinInverse',
  'bybit',
  'bybitLinear',
  'bybitInverse',
  'okx',
  'okxLinear',
  'okxInverse',
  'bitget',
  'bitgetUsdm',
  'bitgetCoinm',
  'coinbase',
  'hyperliquid',
  'hyperliquidLinear',
  'kraken',
  'krakenUsdm',
  'mexc',
] as const

export type KnownExchange = (typeof KNOWN_EXCHANGES)[number]

/**
 * Maps a `PRICE_CONNECTOR_EXCHANGES` env-style family token (e.g.
 * 'binance', 'binanceus') to the per-variant ExchangeEnum members the
 * websocket-connector spawns per family worker. Used to expand the
 * legacy env config into the granular Redis set on first boot.
 *
 * Mirrors FAMILY_VARIANTS in websocket-connector-sh/src/priceConnector
 * .ts. 'binanceus' is intentionally separate because the websocket
 * connector treats it as its own env token even though it shares the
 * binance family worker.
 */
const FAMILY_TOKEN_TO_VARIANTS: Record<string, KnownExchange[]> = {
  binance: ['binance', 'binanceCoinm', 'binanceUsdm'],
  binanceus: ['binanceUS'],
  bybit: ['bybit', 'bybitInverse', 'bybitLinear'],
  kucoin: ['kucoin', 'kucoinInverse', 'kucoinLinear'],
  okx: ['okx', 'okxInverse', 'okxLinear'],
  bitget: ['bitget', 'bitgetCoinm', 'bitgetUsdm'],
  hyperliquid: ['hyperliquid', 'hyperliquidLinear'],
  kraken: ['kraken', 'krakenUsdm'],
  coinbase: ['coinbase'],
  mexc: ['mexc'],
}

export async function getEnabledExchanges(): Promise<string[] | null> {
  const raw = await getRedis().get(ENABLED_EXCHANGES_KEY)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return null
    return parsed.filter((x): x is string => typeof x === 'string')
  } catch (err) {
    logger.warn('enabled_exchanges parse failed; treating as null', {
      err: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}

export async function setEnabledExchanges(
  list: string[] | null,
): Promise<void> {
  const r = getRedis()
  if (list === null) {
    await r.del(ENABLED_EXCHANGES_KEY)
  } else {
    // Dedupe + sort for stable storage.
    const unique = Array.from(new Set(list)).sort()
    await r.set(ENABLED_EXCHANGES_KEY, JSON.stringify(unique))
  }
  // Notify connectors so they can hot-reload without a recompose.
  await r.publish(
    CONFIG_CHANNEL,
    JSON.stringify({ type: 'enabled_exchanges_changed', ts: Date.now() }),
  )
}

/**
 * First-boot seed. If `gainium:admin:enabled_exchanges` doesn't exist,
 * write a sensible default so connectors that read Redis (and not the
 * legacy `PRICE_CONNECTOR_EXCHANGES` env) have something to work with:
 *
 *   - If `PRICE_CONNECTOR_EXCHANGES` is set on admin-sh's env, expand
 *     each family token into its variants. Operators upgrading from a
 *     deployment that used the legacy env get the same effective
 *     restrictions out of the box.
 *   - Otherwise, write the full KNOWN_EXCHANGES list. This is a no-op
 *     functionally (the absent-key fallback is also "all enabled") but
 *     gives operators an explicit set to see + edit in the Admin UI.
 *
 * Idempotent: if the key already exists (operator has already toggled
 * something), we don't overwrite their choices.
 */
export async function seedDefaultEnabledExchanges(): Promise<void> {
  const existing = await getRedis().exists(ENABLED_EXCHANGES_KEY)
  if (existing) {
    logger.info('enabled_exchanges already present; skipping seed')
    return
  }

  const envValue = (process.env.PRICE_CONNECTOR_EXCHANGES ?? '').trim()
  let seeded: KnownExchange[]
  let source: string

  if (envValue) {
    const tokens = envValue
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
    const expanded = new Set<KnownExchange>()
    const unknown: string[] = []
    for (const t of tokens) {
      const variants = FAMILY_TOKEN_TO_VARIANTS[t]
      if (!variants) {
        unknown.push(t)
        continue
      }
      for (const v of variants) expanded.add(v)
    }
    if (unknown.length) {
      logger.warn('seed: unknown PRICE_CONNECTOR_EXCHANGES tokens skipped', {
        unknown,
      })
    }
    seeded = Array.from(expanded).sort() as KnownExchange[]
    source = `PRICE_CONNECTOR_EXCHANGES=${envValue}`
  } else {
    seeded = [...KNOWN_EXCHANGES].sort() as KnownExchange[]
    source = 'KNOWN_EXCHANGES (all)'
  }

  await setEnabledExchanges(seeded)
  logger.info('seeded enabled_exchanges', {
    source,
    count: seeded.length,
    seeded,
  })
}
