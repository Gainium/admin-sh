# @gainium/admin-sh

Self-hosted Gainium admin API. Ships inside [`docker-sh`](https://github.com/Gainium/docker-sh) so the operator can:

- See compose services + their state and start/stop/restart them.
- Choose which exchanges (granular: spot vs USD-M vs Coin-M etc.) the platform connects to.
- See current image versions and upgrade them with one click.

Backed by `/var/run/docker.sock` via dockerode. Only ever touches containers labelled with `com.docker.compose.project=$COMPOSE_PROJECT_NAME` so it can't reach outside the gainium-sh project.

## API surface

All routes (except `/health`) require a `Bearer` JWT signed with the same `JWT_SECRET` the main app uses — the dashboard simply forwards the user's existing token.

| Method | Path | Description |
|---|---|---|
| `GET`  | `/health` | Unauthenticated health probe. |
| `GET`  | `/api/containers` | List compose services + their state. |
| `POST` | `/api/containers/:name/start` | Start a container or service. |
| `POST` | `/api/containers/:name/stop` | Stop a container or service. |
| `POST` | `/api/containers/:name/restart` | Restart a container or service. |
| `GET`  | `/api/exchanges` | Get `{ known, enabled }`. `enabled: null` ⇒ all enabled. |
| `PUT`  | `/api/exchanges` | Set `{ enabled: string[] \| null }`. Publishes a Redis pubsub event so connectors hot-reload. |
| `GET`  | `/api/updates` | Per-container `{ current, latest, hasUpdate }` from the configured registry. |
| `POST` | `/api/upgrade` | Body `{ service: string \| "all", tag: string }`. Pulls + recreates; persists the new tag to `.versions.env`. For `admin-sh` itself, enqueues a self-upgrade job for the `updater` sidecar. |

## Env

| Var | Required | Default | Description |
|---|---|---|---|
| `JWT_SECRET` | yes | — | Shared with the main app. |
| `REDIS_HOST` | no | `redis` | |
| `REDIS_PORT` | no | `6379` | |
| `REDIS_PASSWORD` | no | — | |
| `DOCKER_REGISTRY_HOST` | no | `docker.gainium.io` | |
| `DOCKER_REGISTRY_USER` | no | — | Basic-auth for `/v2/<repo>/tags/list`. |
| `DOCKER_REGISTRY_PASS` | no | — | |
| `COMPOSE_PROJECT_NAME` | no | `gainium-sh` | Container-action scope. |
| `VERSIONS_ENV_PATH` | no | `/etc/gainium/.versions.env` | Where new image tags get written. |
| `COMPOSE_DIR_HOST_PATH` | self-upgrade only | — | Host absolute path of the docker-sh project directory. Needed only when admin-sh upgrades itself — admin-sh spawns a short-lived `docker:27-cli` helper container with this path bind-mounted, which runs `docker compose up -d admin-sh`. |
| `UPGRADE_HELPER_IMAGE` | no | `docker:27-cli` | Image used for the self-upgrade helper. Must contain the docker compose plugin. Pulled on demand if not present. |
| `CORS_ORIGIN` | no | — | Comma-separated list of allowed origins. |
| `PORT` | no | `7507` | |

## Local development

```sh
npm install
cp .env.example .env  # set JWT_SECRET at minimum
npm run start:dev
```

`/var/run/docker.sock` must be readable by the process. For non-Docker dev, mock the docker calls or run inside a container with the socket mounted.

## Docker

```sh
docker build -t docker.gainium.io/gainium/admin-sh:dev .
```

Run with the socket + a versions.env mount:

```sh
docker run --rm -p 7507:7507 \
  -e JWT_SECRET=… -e REDIS_HOST=… -e REDIS_PASSWORD=… \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v $(pwd)/.versions.env:/etc/gainium/.versions.env \
  docker.gainium.io/gainium/admin-sh:dev
```

## Notes

Cloud (`main-dash-redesign`) does **not** ship this image. Self-hosted-only.
