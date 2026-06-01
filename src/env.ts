// Single source of truth for runtime env. Read once at boot so missing
// vars fail fast.

function required(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`Missing required env var: ${name}`)
  return v
}

function optional(name: string, fallback: string): string {
  return process.env[name] || fallback
}

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
  versionsEnvPath: optional('VERSIONS_ENV_PATH', '/etc/gainium/.versions.env'),
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
