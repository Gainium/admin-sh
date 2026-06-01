import { Router } from 'express'
import { promises as fs } from 'fs'
import path from 'path'
import {
  HttpError,
  listProjectContainers,
  pullImage,
  recreateWithImage,
  spawnRecreateHelper,
  type ServiceContainer,
} from '../docker'
import { parseImageRef } from '../registry'
import { env } from '../env'
import { logger } from '../logger'

export const upgradeRouter = Router()

// Mapping from compose service name → env var used in docker-compose.yml's
// ${VAR:-default} substitution. docker-sh exposes these per service so the
// next `docker compose up -d` doesn't snap tags back to the defaults.
//
// Keep this in sync with docker-sh/docker-compose.yml.
const SERVICE_TO_VERSION_VAR: Record<string, string> = {
  api: 'MAIN_APP_VERSION',
  stream: 'MAIN_APP_VERSION',
  'bots-dca': 'MAIN_APP_VERSION',
  'bots-grid': 'MAIN_APP_VERSION',
  'bots-combo': 'MAIN_APP_VERSION',
  'bots-hedge-dca': 'MAIN_APP_VERSION',
  'bots-hedge-combo': 'MAIN_APP_VERSION',
  indicators: 'MAIN_APP_VERSION',
  cron: 'MAIN_APP_VERSION',
  backtest: 'MAIN_APP_VERSION',
  'cli-runner': 'MAIN_APP_VERSION',
  frontend: 'FRONTEND_VERSION',
  'exchange-connector': 'EXCHANGE_CONNECTOR_VERSION',
  'paper-trading': 'PAPER_TRADING_VERSION',
  'user-update-connector': 'WEBSOCKET_CONNECTOR_VERSION',
  'price-connector': 'WEBSOCKET_CONNECTOR_VERSION',
  'admin-sh': 'ADMIN_SH_VERSION',
  updater: 'UPDATER_VERSION',
}

const ADMIN_SH_SERVICE = 'admin-sh'

async function readVersionsFile(): Promise<Record<string, string>> {
  try {
    const raw = await fs.readFile(env.versionsEnvPath, 'utf8')
    const out: Record<string, string> = {}
    for (const line of raw.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const eq = trimmed.indexOf('=')
      if (eq < 0) continue
      out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim()
    }
    return out
  } catch (err) {
    const e = err as NodeJS.ErrnoException
    if (e.code === 'ENOENT') return {}
    throw err
  }
}

async function writeVersionsFile(map: Record<string, string>): Promise<void> {
  const dir = path.dirname(env.versionsEnvPath)
  await fs.mkdir(dir, { recursive: true }).catch(() => {})
  const lines = [
    '# Managed by admin-sh — do not edit by hand. Image tags written',
    '# here are read by docker-compose.yml via ${X_VERSION:-default}.',
    ...Object.entries(map)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`),
  ]
  await fs.writeFile(env.versionsEnvPath, lines.join('\n') + '\n', 'utf8')
}

async function persistTag(service: string, tag: string): Promise<void> {
  const varName = SERVICE_TO_VERSION_VAR[service]
  if (!varName) {
    logger.warn('no version var mapped for service; skipping .versions.env', {
      service,
    })
    return
  }
  const current = await readVersionsFile()
  current[varName] = tag
  await writeVersionsFile(current)
}

async function launchSelfUpgradeHelper(targetRef: string): Promise<string> {
  if (!env.composeDirHostPath) {
    throw new HttpError(
      500,
      'Self-upgrade requires COMPOSE_DIR_HOST_PATH to be set to the host path of the docker-sh project directory.',
    )
  }
  const { helperId } = await spawnRecreateHelper({
    service: ADMIN_SH_SERVICE,
    helperImage: env.helperImage,
    composeProject: env.composeProject,
    composeDirHostPath: env.composeDirHostPath,
  })
  logger.info('self-upgrade helper launched', { targetRef, helperId })
  return helperId
}

interface UpgradeRequest {
  /** Service name (e.g. "bots-dca") or "all". */
  service: string
  /** Optional explicit tag. When absent, "latest" is implied — caller is
   *  expected to have called /api/updates first and pass the resolved tag. */
  tag?: string
}

async function upgradeOne(
  container: ServiceContainer,
  tag: string,
): Promise<{ service: string; oldId: string; newId: string }> {
  const parsed = parseImageRef(container.image)
  if (!parsed) {
    throw new HttpError(
      400,
      `Cannot upgrade ${container.service}: image is digest-pinned`,
    )
  }
  const newRef = parsed.host
    ? `${parsed.host}/${parsed.repo}:${tag}`
    : `${parsed.repo}:${tag}`
  logger.info('upgrade: pulling image', {
    service: container.service,
    newRef,
  })
  await pullImage(newRef)

  if (container.service === ADMIN_SH_SERVICE) {
    // Stopping our own container kills this process mid-call, so admin-sh
    // can't recreate itself. Instead spawn a short-lived helper container
    // that runs `docker compose up -d --force-recreate admin-sh` after a
    // 3s sleep — enough time for this HTTP response to flush. The helper
    // has AutoRemove: true so it cleans itself up.
    await persistTag(container.service, tag)
    const helperId = await launchSelfUpgradeHelper(newRef)
    return {
      service: container.service,
      oldId: container.id,
      newId: `pending-via-helper:${helperId.slice(0, 12)}`,
    }
  }

  logger.info('upgrade: recreating container', {
    service: container.service,
    newRef,
  })
  const { oldId, newId } = await recreateWithImage(container.id, newRef)
  await persistTag(container.service, tag)
  return { service: container.service, oldId, newId }
}

upgradeRouter.post('/', async (req, res) => {
  const body = req.body as UpgradeRequest
  if (!body?.service || typeof body.service !== 'string') {
    res.status(400).json({ error: 'Body must include { service: string }' })
    return
  }
  if (!body.tag || typeof body.tag !== 'string') {
    res.status(400).json({
      error:
        'Body must include { tag: string } — caller should resolve the target tag via /api/updates',
    })
    return
  }
  try {
    const all = await listProjectContainers()
    const targets =
      body.service === 'all'
        ? all
        : all.filter((c) => c.service === body.service || c.id === body.service)
    if (!targets.length) {
      res.status(404).json({
        error: `No containers match service "${body.service}" in project ${env.composeProject}`,
      })
      return
    }
    const results: Array<{
      service: string
      oldId: string
      newId: string
    }> = []
    for (const c of targets) {
      results.push(await upgradeOne(c, body.tag))
    }
    res.json({ results })
  } catch (err) {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message })
      return
    }
    const message = err instanceof Error ? err.message : String(err)
    logger.error('upgrade failed', { err: message })
    res.status(500).json({ error: message })
  }
})
