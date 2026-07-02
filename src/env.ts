// Single source of truth for runtime env. Read once at boot so missing
// vars fail fast.

import path from 'path'

function required(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`Missing required env var: ${name}`)
  return v
}

function optional(name: string, fallback: string): string {
  return process.env[name] || fallback
}

const versionsEnvPath = optional(
  'VERSIONS_ENV_PATH',
  '/etc/gainium/.versions.env',
)
// admin-sh's own (in-container) view of the bind-mounted compose project
// dir. docker-sh mounts the project dir at /workspace and points
// VERSIONS_ENV_PATH inside it, so its parent is that mount. The self-
// upgrade helper sees the *same* host dir at COMPOSE_DIR_HOST_PATH.
const workspaceDir = path.dirname(versionsEnvPath)

export const env = {
  port: Number(optional('PORT', '7507')),
  jwtSecret: required('JWT_SECRET'),
  redis: {
    host: optional('REDIS_HOST', 'redis'),
    port: Number(optional('REDIS_PORT', '6379')),
    password: process.env.REDIS_PASSWORD,
  },
  registry: {
    host: optional('DOCKER_REGISTRY_HOST', 'docker.gainium.io'),
    user: process.env.DOCKER_REGISTRY_USER,
    pass: process.env.DOCKER_REGISTRY_PASS,
  },
  // Docker compose project label admin-sh is allowed to act on. Anything
  // outside this label is invisible.
  composeProject: optional('COMPOSE_PROJECT_NAME', 'gainium-sh'),
  // Bind-mounted path where image tags managed by admin-sh are written so
  // a host-side `docker compose up -d` keeps them.
  versionsEnvPath,
  // admin-sh's in-container view of the compose project dir (parent of
  // versionsEnvPath). Used by the self-upgrade pre-flight to confirm the
  // compose file is actually mounted before it tries to recreate itself.
  workspaceDir,
  // Status file written by admin-sh (intent) and by the self-upgrade
  // helper (outcome), then read back after admin-sh is recreated so the
  // UI can surface real success/failure. Lives in the shared compose dir
  // so it survives the container swap.
  selfUpgradeStatusPath: optional(
    'SELF_UPGRADE_STATUS_PATH',
    path.join(workspaceDir, '.admin-sh-upgrade-status.json'),
  ),
  // Host-side absolute path of the docker-sh project directory (the one
  // containing docker-compose.yml). Used only for self-upgrade: admin-sh
  // can't recreate its own container, so it spawns a short-lived helper
  // container with this path bind-mounted that runs `docker compose
  // up -d admin-sh`. Set by docker-sh to e.g. /home/me/gainium/docker-sh.
  composeDirHostPath: process.env.COMPOSE_DIR_HOST_PATH,
  // Image used for the self-upgrade helper. Must include the docker
  // compose plugin; docker:27-cli does. Pulled on demand if missing.
  helperImage: optional('UPGRADE_HELPER_IMAGE', 'docker:27-cli'),
  corsOrigin: process.env.CORS_ORIGIN,
} as const
