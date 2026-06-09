import 'dotenv/config'
import cors from 'cors'
import express from 'express'
import { env } from './env'
import { logger } from './logger'
import { authMiddleware } from './auth'
import { seedDefaultEnabledExchanges } from './config'
import { containersRouter } from './routes/containers'
import { exchangesRouter } from './routes/exchanges'
import { updatesRouter } from './routes/updates'
import { upgradeRouter } from './routes/upgrade'

const app = express()

app.disable('x-powered-by')
app.use(express.json({ limit: '256kb' }))

if (env.corsOrigin) {
  // Comma-separated origins → array; single value stays string.
  const origins = env.corsOrigin.includes(',')
    ? env.corsOrigin.split(',').map((s) => s.trim())
    : env.corsOrigin
  app.use(cors({ origin: origins, credentials: false }))
}

// Health endpoint is intentionally unauthenticated so docker healthcheck
// + load balancers can probe without a token.
app.get('/health', (_req, res) => {
  res.json({ ok: true, ts: Date.now() })
})

// Everything else under /api requires a valid JWT.
app.use('/api', authMiddleware)
app.use('/api/containers', containersRouter)
app.use('/api/exchanges', exchangesRouter)
app.use('/api/updates', updatesRouter)
app.use('/api/upgrade', upgradeRouter)

// Errors that escape a route handler (rare; routes handle their own).
// Express detects error-handling middleware by ARITY === 4. Do NOT drop
// the `_next` parameter even though it's unused — Express will then
// treat this as ordinary middleware where arg[0] is `req`, blowing up
// at `res.status` (which is actually `req.status`).
app.use(
  (
    err: Error,
    _req: express.Request,
    res: express.Response,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _next: express.NextFunction,
  ) => {
    logger.error('unhandled error', { err: err.message, stack: err.stack })
    res.status(500).json({ error: err.message || 'Internal server error' })
  },
)

const server = app.listen(env.port, () => {
  logger.info('admin-sh listening', {
    port: env.port,
    composeProject: env.composeProject,
  })
})

// Seed the enabled-exchanges Redis key on first boot. Runs in the
// background so it doesn't block the HTTP listener — if Redis isn't up
// yet, the underlying client retries on its own schedule. The seed is
// idempotent (skips if the key already exists), so any retries from
// repeated admin-sh restarts won't clobber operator changes.
void seedDefaultEnabledExchanges().catch((err) => {
  logger.warn('seed failed; will retry on next admin-sh restart', {
    err: err instanceof Error ? err.message : String(err),
  })
})

function shutdown(signal: string) {
  logger.info('shutdown', { signal })
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(1), 10_000).unref()
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
