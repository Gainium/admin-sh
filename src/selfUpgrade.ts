// Self-upgrade status tracking.
//
// admin-sh can't recreate its own container from inside the running
// process — the `docker compose up -d --force-recreate admin-sh` that a
// helper container runs kills this process mid-request. That makes the
// outcome invisible to the HTTP call that started it. To close that gap we
// persist a small status file in the shared compose dir (bind-mounted into
// both admin-sh and the helper). admin-sh writes an `in_progress` record
// before handing off; the helper overwrites it with the compose exit code;
// the freshly-recreated admin-sh reads it back and reconciles against the
// actually-running container tag. The dashboard polls the reconciled view.

import { promises as fs } from 'fs'
import path from 'path'
import { env } from './env'
import { logger } from './logger'

// The manual escape hatch surfaced everywhere self-upgrade can't complete
// on its own. Kept as one string so the UI, the error messages, and the
// runbook stay in lockstep.
export const MANUAL_FALLBACK =
  'docker compose pull admin-sh && docker compose up -d --force-recreate admin-sh'

// If the helper never writes an outcome (e.g. it failed to start, or the
// daemon died), an `in_progress` record older than this is treated as a
// failed attempt rather than hanging "in progress" forever.
const IN_PROGRESS_TIMEOUT_MS = 180_000

export type SelfUpgradeState = 'idle' | 'in_progress' | 'success' | 'failed'

// On-disk shape. admin-sh writes {state:'in_progress',...}; the helper
// overwrites with {state, exitCode, targetTag, finishedAt}. Fields are
// optional because the two writers populate different subsets.
interface RawSelfUpgradeStatus {
  state?: SelfUpgradeState
  targetTag?: string | null
  fromTag?: string | null
  startedAt?: number | null
  finishedAt?: number | null
  exitCode?: number | null
  error?: string | null
}

// Reconciled shape returned to the dashboard.
export interface SelfUpgradeStatus {
  state: SelfUpgradeState
  targetTag: string | null
  fromTag: string | null
  currentTag: string | null
  startedAt: number | null
  finishedAt: number | null
  exitCode: number | null
  error: string | null
  manualFallback: string
}

/** Basename of the status file — the helper writes it under the host
 *  compose dir, so it must match what admin-sh reads under workspaceDir. */
export function statusFileName(): string {
  return path.basename(env.selfUpgradeStatusPath)
}

/** Basename of the helper's raw compose-output log, alongside the status
 *  file. Plain text so the helper needn't JSON-escape compose output. */
export function logFileName(): string {
  return statusFileName().replace(/\.json$/, '') + '.log'
}

/** Record intent, just before handing off to the helper. Clears any prior
 *  outcome so a stale success/failure can't be misread as this attempt. */
export async function writeInProgress(opts: {
  targetTag: string
  fromTag: string | null
}): Promise<void> {
  const record: RawSelfUpgradeStatus = {
    state: 'in_progress',
    targetTag: opts.targetTag,
    fromTag: opts.fromTag,
    startedAt: Date.now(),
    finishedAt: null,
    exitCode: null,
    error: null,
  }
  await fs
    .mkdir(path.dirname(env.selfUpgradeStatusPath), { recursive: true })
    .catch(() => {})
  await fs.writeFile(
    env.selfUpgradeStatusPath,
    JSON.stringify(record) + '\n',
    'utf8',
  )
}

async function readRaw(): Promise<RawSelfUpgradeStatus | null> {
  try {
    const raw = await fs.readFile(env.selfUpgradeStatusPath, 'utf8')
    return JSON.parse(raw) as RawSelfUpgradeStatus
  } catch (err) {
    const e = err as NodeJS.ErrnoException
    if (e.code === 'ENOENT') return null
    logger.warn('self-upgrade status unreadable', {
      err: e.message,
      path: env.selfUpgradeStatusPath,
    })
    return null
  }
}

async function readHelperLog(): Promise<string | null> {
  try {
    const p = path.join(env.workspaceDir, logFileName())
    const raw = await fs.readFile(p, 'utf8')
    // Only the tail is useful; keep the surfaced error compact.
    return raw.trim().split('\n').slice(-8).join('\n') || null
  } catch {
    return null
  }
}

/**
 * Reconcile the on-disk record against the tag admin-sh is *actually*
 * running now. Tag-match is the source of truth: if the running container
 * is on the target tag the upgrade succeeded, whatever the helper wrote;
 * if the helper reported a non-zero compose exit, or an `in_progress`
 * record has aged past the timeout without the tag flipping, it failed.
 */
export async function reconcile(
  currentTag: string | null,
): Promise<SelfUpgradeStatus> {
  const raw = await readRaw()
  const base: SelfUpgradeStatus = {
    state: 'idle',
    targetTag: raw?.targetTag ?? null,
    fromTag: raw?.fromTag ?? null,
    currentTag,
    startedAt: raw?.startedAt ?? null,
    finishedAt: raw?.finishedAt ?? null,
    exitCode: raw?.exitCode ?? null,
    error: raw?.error ?? null,
    manualFallback: MANUAL_FALLBACK,
  }
  if (!raw || !raw.targetTag) return base

  // Goal reached — running the intended tag is success regardless of what
  // the helper recorded (it may not have written yet).
  if (currentTag && currentTag === raw.targetTag) {
    return { ...base, state: 'success' }
  }

  // Helper reported a compose failure.
  if (typeof raw.exitCode === 'number' && raw.exitCode !== 0) {
    return {
      ...base,
      state: 'failed',
      error:
        raw.error ??
        (await readHelperLog()) ??
        `Self-upgrade helper's \`docker compose up\` exited ${raw.exitCode}. Run the manual fallback.`,
    }
  }

  // Not yet confirmed on the new tag and no compose error: still pending
  // while inside the timeout window. Gate on the window (not the literal
  // `in_progress` marker) so a helper that reported `exit 0` a moment
  // before the new container becomes visible isn't mis-flagged as failed.
  const startedAt = raw.startedAt ?? 0
  if (Date.now() - startedAt < IN_PROGRESS_TIMEOUT_MS) {
    return { ...base, state: 'in_progress' }
  }
  return {
    ...base,
    state: 'failed',
    error:
      raw.error ??
      (await readHelperLog()) ??
      'Self-upgrade did not complete: admin-sh is still on the old tag and the helper never confirmed. Run the manual fallback.',
  }
}
