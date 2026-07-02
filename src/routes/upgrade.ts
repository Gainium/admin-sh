import { Router } from 'express'
import { promises as fs } from 'fs'
import path from 'path'
import {
  HttpError,
  listProjectContainers,
  ping,
  pullImage,
  recreateWithImage,
  spawnRecreateHelper,
  type ServiceContainer,
} from '../docker'
import { parseImageRef } from '../registry'
import { env } from '../env'
import { logger } from '../logger'
import {
  MANUAL_FALLBACK,
  logFileName,
  reconcile,
  statusFileName,
  writeInProgress,
} from '../selfUpgrade'

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

/**
 * Fail fast, *before* persisting the tag or reporting success, when the
 * environment can't actually complete a self-upgrade. Each error names the
 * misconfiguration and the manual fallback so the operator isn't left on a
 * silently-stale container (community thread 4872).
 */
async function assertSelfUpgradePossible(): Promise<void> {
  if (!env.composeDirHostPath) {
    throw new HttpError(
      501,
      `Cannot self-upgrade admin-sh: COMPOSE_DIR_HOST_PATH is not set, so admin-sh can't spawn the helper that recreates its own container. Set it to the host path of the docker-sh project dir and recreate admin-sh, or upgrade manually: ${MANUAL_FALLBACK}`,
    )
  }
  // The helper recreates via ${COMPOSE_DIR_HOST_PATH}/docker-compose.yml on
  // the host; admin-sh sees that same dir at workspaceDir. If the compose
  // file isn't visible there, the bind mount is missing or points
  // elsewhere and the helper would fail after admin-sh is already gone.
  const composeFile = path.join(env.workspaceDir, 'docker-compose.yml')
  try {
    await fs.access(composeFile)
  } catch {
    throw new HttpError(
      501,
      `Cannot self-upgrade admin-sh: docker-compose.yml is not visible at ${composeFile} (expected the docker-sh project dir bind-mounted there). Check the admin-sh volume mount and COMPOSE_DIR_HOST_PATH, or upgrade manually: ${MANUAL_FALLBACK}`,
    )
  }
  if (!(await ping())) {
    throw new HttpError(
      500,
      `Cannot self-upgrade admin-sh: the Docker daemon is unreachable. Upgrade manually once it's back: ${MANUAL_FALLBACK}`,
    )
  }
}

async function launchSelfUpgradeHelper(
  targetRef: string,
  targetTag: string,
): Promise<string> {
  // composeDirHostPath is guaranteed set by assertSelfUpgradePossible().
  const { helperId } = await spawnRecreateHelper({
    service: ADMIN_SH_SERVICE,
    helperImage: env.helperImage,
    composeProject: env.composeProject,
    composeDirHostPath: env.composeDirHostPath as string,
    targetTag,
    statusFileName: statusFileName(),
    logFileName: logFileName(),
  })
  logger.info('self-upgrade helper launched', {
    targetRef,
    targetTag,
    helperId,
  })
  return helperId
}

interface UpgradeRequest {
  /** Service name (e.g. "bots-dca") or "all". */
  service: string
  /** Optional explicit tag. When absent, "latest" is implied — caller is
   *  expected to have called /api/updates first and pass the resolved tag. */
  tag?: string
}

interface UpgradeResult {
  service: string
  oldId: string
  newId: string
  /** Present only for admin-sh: the recreate is async (admin-sh dies
   *  mid-swap), so the caller must poll `statusUrl` for the real outcome. */
  selfUpgrade?: {
    pending: true
    targetTag: string
    statusUrl: string
    manualFallback: string
  }
}

async function upgradeOne(
  container: ServiceContainer,
  tag: string,
): Promise<UpgradeResult> {
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

  // For a self-upgrade, verify the environment can actually complete the
  // swap before we even pull — no point downloading an image we can't
  // apply, and the operator gets a fast, clear error.
  if (container.service === ADMIN_SH_SERVICE) {
    await assertSelfUpgradePossible()
  }

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
    //
    // Pre-flight already ran above (before the pull), so we know the swap
    // is viable and haven't persisted anything yet. Record intent so the
    // recreated admin-sh can reconcile the real outcome (thread 4872).
    await writeInProgress({ targetTag: tag, fromTag: container.imageTag })
    await persistTag(container.service, tag)
    const helperId = await launchSelfUpgradeHelper(newRef, tag)
    return {
      service: container.service,
      oldId: container.id,
      newId: `pending-via-helper:${helperId.slice(0, 12)}`,
      selfUpgrade: {
        pending: true,
        targetTag: tag,
        statusUrl: '/api/upgrade/self-status',
        manualFallback: MANUAL_FALLBACK,
      },
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
    const results: UpgradeResult[] = []
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

// Real outcome of the last admin-sh self-upgrade. The dashboard polls this
// after triggering one: the POST returns while the recreate is still in
// flight (admin-sh dies mid-swap), so this endpoint — served by the
// freshly-recreated admin-sh — is where success/failure actually surfaces.
// Tag-match against the live container is the source of truth.
upgradeRouter.get('/self-status', async (_req, res) => {
  try {
    const containers = await listProjectContainers()
    const self = containers.find((c) => c.service === ADMIN_SH_SERVICE)
    res.json(await reconcile(self?.imageTag ?? null))
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger.error('self-status failed', { err: message })
    res.status(500).json({ error: message })
  }
})
