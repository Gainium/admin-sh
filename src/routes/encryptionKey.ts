import crypto from 'crypto'
import fs from 'fs/promises'
import path from 'path'
import { Router } from 'express'
import { env } from '../env'
import { logger } from '../logger'

/**
 * Generates this installation's ENCRYPT_KEY and writes it to the host `.env`.
 *
 * The key protects the exchange API credentials users store. Without one the
 * stack falls back to a key compiled into the image, which is identical in
 * every installation — so a copy of the database is enough to read the
 * credentials out of it. Setting a key is a one-line change to `.env`, but it
 * is a line nobody discovers on their own, hence this endpoint.
 *
 * Two things it deliberately does NOT do:
 *
 *  - It does not store the key anywhere but `.env`. Keeping a copy in the
 *    database or in a volume we manage would make it travel with exactly the
 *    thing it protects, and would leave the operator unaware that they hold
 *    the only copy of something unrecoverable.
 *  - It does not recreate the stack. Containers read their environment at
 *    creation, so the key only takes effect on the next `docker compose up
 *    -d`. Deciding when to bounce a trading stack belongs to the operator.
 */
export const encryptionKeyRouter = Router()

const ENV_FILE = '.env'
const VAR = 'ENCRYPT_KEY'

/** `KEY=value`, ignoring comments and leading whitespace. */
const assignmentRe = new RegExp(`^\\s*${VAR}\\s*=(.*)$`)

function envPath(): string {
  return path.join(env.workspaceDir, ENV_FILE)
}

interface EnvState {
  /** File is readable — i.e. the compose dir really is bind-mounted. */
  present: boolean
  /** A non-empty ENCRYPT_KEY assignment exists. */
  configured: boolean
  /** Index of the assignment line, or -1 when there is none. */
  lineIndex: number
  lines: string[]
}

async function readEnv(): Promise<EnvState> {
  let raw: string
  try {
    raw = await fs.readFile(envPath(), 'utf8')
  } catch {
    return { present: false, configured: false, lineIndex: -1, lines: [] }
  }
  const lines = raw.split('\n')
  const lineIndex = lines.findIndex(
    (l) => !l.trimStart().startsWith('#') && assignmentRe.test(l),
  )
  const value =
    lineIndex >= 0 ? (assignmentRe.exec(lines[lineIndex])?.[1] ?? '') : ''
  return {
    present: true,
    // Quotes are legal in a compose env file, so an operator's `""` is still
    // an unset key as far as the stack is concerned.
    configured: value.trim().replace(/^['"]|['"]$/g, '') !== '',
    lineIndex,
    lines,
  }
}

/**
 * Replaces the file in one step so a crash cannot leave a half-written `.env`
 * — that file configures every service in the stack, and a truncated one
 * would take the whole installation down on the next `up`.
 */
async function writeEnvAtomic(lines: string[]): Promise<void> {
  const target = envPath()
  const tmp = path.join(env.workspaceDir, `.env.tmp-${process.pid}`)
  // 0600 from the moment it exists — it now holds a credential-grade secret,
  // and the same tightening setupEncryptKey.sh applies on the host.
  await fs.writeFile(tmp, lines.join('\n'), { encoding: 'utf8', mode: 0o600 })
  try {
    await fs.rename(tmp, target)
    await fs.chmod(target, 0o600)
  } catch (err) {
    await fs.unlink(tmp).catch(() => {})
    throw err
  }
}

encryptionKeyRouter.get('/', async (_req, res) => {
  try {
    const state = await readEnv()
    res.json({
      configured: state.configured,
      // The UI offers the button only when we can actually deliver — the
      // alternative is a button that fails on click for a reason the
      // operator cannot see.
      canGenerate: state.present && !state.configured,
      envFileWritable: state.present,
      envFilePath: envPath(),
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger.error('encryption key status failed', { err: message })
    res.status(500).json({ error: message })
  }
})

encryptionKeyRouter.post('/', async (_req, res) => {
  try {
    const state = await readEnv()

    if (!state.present) {
      res.status(409).json({
        error:
          `Cannot read ${ENV_FILE} — the compose project directory does not ` +
          'appear to be mounted into admin-sh. Run ./setupEncryptKey.sh on ' +
          'the host instead.',
      })
      return
    }

    // Never overwrite. A second key would make every value written under the
    // first one unreadable, and this endpoint has no way to know whether any
    // exist.
    if (state.configured) {
      res.status(409).json({
        error:
          `${VAR} is already set in ${ENV_FILE}. Changing it is a planned ` +
          'operation, not a click — see "Encryption key" in DEPLOYMENT.md.',
      })
      return
    }

    // 32 bytes, same as ./setupEncryptKey.sh and `openssl rand -hex 32`.
    const key = crypto.randomBytes(32).toString('hex')
    const assignment = `${VAR}=${key}`

    const lines = [...state.lines]
    if (state.lineIndex >= 0) {
      // Keep the operator's own placement and any comment above it.
      lines[state.lineIndex] = assignment
    } else if (lines.length && lines[lines.length - 1] === '') {
      lines[lines.length - 1] = assignment
      lines.push('')
    } else {
      lines.push(assignment)
    }

    await writeEnvAtomic(lines)

    // The value is never logged — this line exists so an operator reading
    // admin-sh's log can see that the key was created and when.
    logger.info('encryption key generated and written to .env')

    res.json({
      // Returned once, so the operator can put it somewhere safe. It is also
      // in .env on the host, so closing the dialog does not lose it.
      key,
      envFilePath: envPath(),
      // Containers capture their environment when they are created, so the
      // key is inert until the stack is recreated.
      applyCommand: 'docker compose up -d',
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger.error('encryption key generation failed', { err: message })
    res.status(500).json({ error: message })
  }
})
