import Redis from 'ioredis'
import { env } from './env'
import { logger } from './logger'

// Two clients: one for normal ops, one for the blocking pub/sub
// subscription. ioredis requires a dedicated client for SUBSCRIBE.

let cmd: Redis | null = null
let sub: Redis | null = null

function build(role: 'cmd' | 'sub'): Redis {
  const client = new Redis({
    host: env.redis.host,
    port: env.redis.port,
    password: env.redis.password,
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    lazyConnect: false,
  })
  client.on('error', (err) =>
    logger.error('redis error', { role, err: err.message }),
  )
  client.on('connect', () => logger.info('redis connect', { role }))
  return client
}

export function getRedis(): Redis {
  if (!cmd) cmd = build('cmd')
  return cmd
}

export function getRedisSubscriber(): Redis {
  if (!sub) sub = build('sub')
  return sub
}

// A throwaway connection for short-lived pattern subscriptions (e.g. the
// market-data feed probe). Kept separate from the shared `sub` client so a
// probe's psubscribe/punsubscribe never disturbs other subscriptions, and so
// concurrent probes don't collide. Caller MUST `.quit()` it when done.
export function createRedisConnection(): Redis {
  return build('sub')
}

export const CONFIG_CHANNEL = 'gainium:admin:config'
export const ENABLED_EXCHANGES_KEY = 'gainium:admin:enabled_exchanges'
