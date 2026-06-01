import jwt from 'jsonwebtoken'
import type { NextFunction, Request, Response } from 'express'
import { env } from './env'
import { logger } from './logger'

export interface AuthedRequest extends Request {
  user?: { username: string }
}

export function verifyJwt(token: string): { username: string } {
  const decoded = jwt.verify(token, env.jwtSecret) as jwt.JwtPayload
  // app-sh's user.ts signs tokens as `{ username, authorized }` — see
  // app-sh/src/graphql/handlers/user.ts. The username doubles as the
  // user's email. We don't need anything else for admin actions
  // (every authenticated user is an admin in the self-hosted model).
  const username = (decoded as { username?: string }).username
  if (!username || typeof username !== 'string') {
    throw new Error('JWT missing username')
  }
  if ((decoded as { authorized?: boolean }).authorized !== true) {
    throw new Error('JWT not marked authorized')
  }
  return { username }
}

/**
 * Pull the token from either the `Authorization: Bearer …` header or
 * a `?token=…` query param. The query fallback exists because
 * EventSource (used by the log-stream UI) can't attach custom headers
 * — it's the standard workaround for browser-native SSE auth.
 */
function extractToken(req: Request): string | null {
  const header = req.header('authorization') || req.header('Authorization')
  if (header && /^bearer /i.test(header)) {
    return header.slice('bearer '.length).trim()
  }
  const q = req.query['token']
  if (typeof q === 'string' && q.length > 0) return q
  return null
}

export function authMiddleware(
  req: AuthedRequest,
  res: Response,
  next: NextFunction,
): void {
  const token = extractToken(req)
  if (!token) {
    res.status(401).json({ error: 'Missing bearer token' })
    return
  }
  try {
    req.user = verifyJwt(token)
    next()
  } catch (err) {
    logger.warn('jwt verify failed', {
      err: err instanceof Error ? err.message : String(err),
    })
    res.status(401).json({ error: 'Invalid token' })
  }
}
