import semver from 'semver'
import { env } from './env'
import { logger } from './logger'

// Skip pre-release / build-channel tags when picking "latest stable".
const PRERELEASE_RE = /-(rc|beta|alpha|dev|pre|snapshot|nightly)/i

interface TagsListResponse {
  name?: string
  tags?: string[]
}

/**
 * Docker Hub uses different hostnames for the index (login + token) vs.
 * the actual registry API (`registry-1.docker.io`). When an image ref
 * has no host we route to the registry endpoint.
 */
const DOCKER_HUB_REGISTRY = 'registry-1.docker.io'
const DOCKER_HUB_HOSTS = new Set([
  '',
  'docker.io',
  'index.docker.io',
  DOCKER_HUB_REGISTRY,
])

function isDockerHub(host: string | null): boolean {
  return DOCKER_HUB_HOSTS.has(host ?? '')
}

function registryHostFor(parsedHost: string | null): string {
  if (parsedHost === null) return DOCKER_HUB_REGISTRY
  if (isDockerHub(parsedHost)) return DOCKER_HUB_REGISTRY
  return parsedHost
}

/**
 * Docker Hub stores official images (e.g. `redis`) under the
 * `library/` prefix. Image refs commonly omit it.
 */
function normalizeHubRepo(host: string, repo: string): string {
  if (host === DOCKER_HUB_REGISTRY && !repo.includes('/')) {
    return `library/${repo}`
  }
  return repo
}

/**
 * If the registry we're hitting matches the one admin-sh is configured
 * for, send its Basic creds during the token-exchange request. Otherwise
 * exchange anonymously — Docker Hub returns anonymous tokens for public
 * repos like `bitnamilegacy/redis`.
 */
function basicAuthFor(host: string): Record<string, string> {
  if (host === env.registry.host && env.registry.user && env.registry.pass) {
    const token = Buffer.from(
      `${env.registry.user}:${env.registry.pass}`,
    ).toString('base64')
    return { authorization: `Basic ${token}` }
  }
  return {}
}

interface BearerChallenge {
  realm: string
  service?: string
  scope?: string
}

/**
 * Parse a `WWW-Authenticate: Bearer realm="…",service="…",scope="…"`
 * header into its parts. Returns null for non-Bearer challenges.
 */
function parseBearerChallenge(header: string | null): BearerChallenge | null {
  if (!header) return null
  if (!/^Bearer /i.test(header)) return null
  const body = header.replace(/^Bearer /i, '')
  const parts: Record<string, string> = {}
  // Match `key="value"` pairs, comma-separated.
  for (const m of body.matchAll(/(\w+)="([^"]*)"/g)) {
    parts[m[1]] = m[2]
  }
  if (!parts['realm']) return null
  const out: BearerChallenge = { realm: parts['realm'] }
  if (parts['service']) out.service = parts['service']
  if (parts['scope']) out.scope = parts['scope']
  return out
}

/**
 * Fetch a Bearer token via the v2 registry's token-exchange endpoint.
 * Returns the token string ready to drop into `Authorization: Bearer …`.
 */
async function fetchBearerToken(
  challenge: BearerChallenge,
  fallbackScope: string,
  host: string,
): Promise<string | null> {
  const url = new URL(challenge.realm)
  if (challenge.service) url.searchParams.set('service', challenge.service)
  url.searchParams.set('scope', challenge.scope ?? fallbackScope)
  const resp = await fetch(url.toString(), { headers: basicAuthFor(host) })
  if (!resp.ok) {
    logger.warn('registry token exchange failed', {
      url: url.toString(),
      status: resp.status,
    })
    return null
  }
  const body = (await resp.json()) as { token?: string; access_token?: string }
  return body.token ?? body.access_token ?? null
}

/**
 * GET /v2/<repo>/tags/list with automatic Bearer-token negotiation on 401.
 * Returns the parsed tag list or [] on failure (logged).
 *
 * `repo` is just the "namespace/name" portion — the host comes from the
 * second arg (parsed off the image ref by parseImageRef), defaulting to
 * the registry admin-sh is configured for.
 */
export async function listTags(
  repo: string,
  host: string | null = null,
): Promise<string[]> {
  const registryHost = registryHostFor(host)
  const effectiveRepo = normalizeHubRepo(registryHost, repo)
  const url = `https://${registryHost}/v2/${effectiveRepo}/tags/list`
  const scope = `repository:${effectiveRepo}:pull`

  // First attempt — anonymous. Most registries 401 here and give us a
  // challenge header that tells us where to get a token.
  let resp = await fetch(url)

  if (resp.status === 401) {
    const challenge = parseBearerChallenge(resp.headers.get('www-authenticate'))
    if (challenge) {
      const bearer = await fetchBearerToken(challenge, scope, registryHost)
      if (bearer) {
        resp = await fetch(url, {
          headers: { authorization: `Bearer ${bearer}` },
        })
      }
    } else if (env.registry.user && env.registry.pass) {
      // Some older registries do accept Basic — try that as a last resort.
      resp = await fetch(url, { headers: basicAuthFor(registryHost) })
    }
  }

  if (!resp.ok) {
    logger.warn('registry tags/list failed', {
      repo: effectiveRepo,
      host: registryHost,
      status: resp.status,
      statusText: resp.statusText,
    })
    return []
  }
  const body = (await resp.json()) as TagsListResponse
  return Array.isArray(body.tags) ? body.tags : []
}

/**
 * Pick the highest semver tag from a list, skipping prereleases.
 * Returns null if nothing in the list is a valid stable semver.
 */
export function pickLatestStable(tags: string[]): string | null {
  const stable = tags
    .filter((t) => !PRERELEASE_RE.test(t))
    .map((t) => ({ raw: t, parsed: semver.coerce(t) }))
    .filter((x): x is { raw: string; parsed: semver.SemVer } => !!x.parsed)
    .sort((a, b) => semver.rcompare(a.parsed, b.parsed))
  return stable[0]?.raw ?? null
}

/**
 * Extract "namespace/name" + ":tag" from a full image ref. Returns null
 * for digest-pinned refs (we can't compare digests against a tag list).
 */
export function parseImageRef(
  ref: string,
): { repo: string; tag: string | null; host: string | null } | null {
  if (ref.includes('@')) return null
  const slash = ref.indexOf('/')
  // Detect a registry host (first segment contains a dot or a port).
  const firstSeg = slash >= 0 ? ref.slice(0, slash) : ''
  const hasHost = firstSeg.includes('.') || firstSeg.includes(':')
  const withoutHost = hasHost ? ref.slice(slash + 1) : ref
  const host = hasHost ? firstSeg : null

  const innerColon = withoutHost.lastIndexOf(':')
  const repo = innerColon >= 0 ? withoutHost.slice(0, innerColon) : withoutHost
  const tag = innerColon >= 0 ? withoutHost.slice(innerColon + 1) : null
  return { repo, tag, host }
}

/**
 * Compare current and available tags for a repo and return a summary.
 * `current` is the tag the running container has.
 */
export async function checkForUpdate(
  repo: string,
  current: string | null,
  host: string | null = null,
): Promise<{
  current: string | null
  latest: string | null
  hasUpdate: boolean
}> {
  const tags = await listTags(repo, host)
  const latest = pickLatestStable(tags)
  if (!latest) return { current, latest: null, hasUpdate: false }
  if (!current) return { current, latest, hasUpdate: true }
  const cur = semver.coerce(current)
  const lat = semver.coerce(latest)
  const hasUpdate = !!cur && !!lat && semver.gt(lat, cur)
  return { current, latest, hasUpdate }
}
