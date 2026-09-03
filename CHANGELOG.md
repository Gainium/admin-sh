# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.4.1] - 2026-09-03

### Added
- CI now runs a real `npm test` (mocha) on every PR. This repo had no test
  runner before; `test/placeholder.spec.ts` is a stand-in until real
  coverage lands.

## [1.4.0] - 2026-08-05

### Added
- `/api/encryption-key` — reports whether this installation has an encryption
  key of its own for the exchange API credentials its users store, and can
  generate one. `POST` writes a fresh 32-byte key to `ENCRYPT_KEY` in the host
  `.env` (atomically, mode `0600`) and returns it once so the operator can save
  a copy; the value is never logged. It refuses to overwrite a key that is
  already set, and refuses outright when the compose project directory is not
  mounted, pointing at `./setupEncryptKey.sh` instead. The stack picks the key
  up on its next `docker compose up -d` — admin-sh does not recreate anything
  by itself.

## [1.3.1] - 2026-07-14

### Added
- `/api/updates` now logs a copy-friendly `update check` summary to stdout on
  every check — one line, deduped per image, showing the running tag vs. the
  newest registry tag and how many updates are available. Lets self-hosted
  operators paste their admin-sh logs (Services → admin-sh → View logs →
  Download) when reporting persistent "update available" prompts, so we can
  tell whether their pins simply lag the published images or the check is
  misbehaving.

## [1.3.0] - 2026-07-02

### Added
- `/api/diagnostics` now reports the running **price-feed connectors** and their
  role: `feedConnectors` (service, role, producesTicker/producesCandle,
  exchanges), `tickerRoleRunning`, and `tickerOnlyExchanges`. Lets the dashboard
  show which feed mode is running and flag exchanges that can't work in the
  current mode (e.g. Coinbase is ticker-only) — the config cause behind
  "enabled but no ticks". Detected by inspecting the `websocket-connector`
  containers' `PRICEROLE`/`PRICE_CONNECTOR_EXCHANGES`.

## [1.2.0] - 2026-07-02

### Added
- `GET /api/upgrade/self-status`: reports the real outcome of the last
  admin-sh self-upgrade. Because admin-sh dies mid-swap while recreating
  its own container, the `POST /api/upgrade` response can only say the
  recreate is *pending*; this endpoint — served by the freshly-recreated
  admin-sh — reconciles the intent record + the helper's compose exit code
  against the tag actually running now, so the dashboard can show a true
  success/failure instead of a premature "success".

### Fixed
- Self-upgrading admin-sh no longer silently leaves the operator on the old
  container (community thread 4872). Before recreating itself admin-sh now
  pre-flights the requirements (`COMPOSE_DIR_HOST_PATH` set, the compose
  file visible via the bind mount, the Docker daemon reachable) and returns
  a clear, actionable error — including the manual fallback command
  (`docker compose pull admin-sh && docker compose up -d --force-recreate
  admin-sh`) — instead of reporting success. The self-upgrade helper now
  records its compose exit code + log so failures are attributable.

## [1.1.0] - 2026-07-01

### Added
- `/api/diagnostics` (+ `/api/diagnostics/feeds`): ops-health snapshot —
  per-service up/health state, Redis reachability + latency, and a live
  market-data feed probe that pattern-subscribes to the websocket-connector
  channels (`trade@{sym}@{exchange}`, `{sym}@{exchange}@{interval}Candle`) for
  a short window and reports live-tick counts per exchange, flagging enabled
  exchanges that are receiving no data.

## [1.0.1] - 2026-06-09

### Fixed
- Express error handling middleware

## [1.0.0] - 2026-05-28

### Added
- Initial release. Express + dockerode service.
- `/api/containers` list / start / stop / restart, scoped by the
  `com.docker.compose.project` label.
- `/api/exchanges` GET / PUT with Redis persistence + pubsub on
  `gainium:admin:config` so connectors hot-reload without recompose.
- `/api/updates` queries the configured registry's `tags/list` and reports
  per-service current vs latest stable.
- `/api/upgrade` pulls + recreates containers with new image refs and
  persists the new tag to `.versions.env` for compose substitution. For
  self-upgrade (admin-sh upgrading admin-sh), it spawns a short-lived
  helper container (`docker:27-cli`, AutoRemove) that runs
  `docker compose up -d --force-recreate admin-sh` after a 3s sleep —
  outliving admin-sh's own recreate.
- JWT auth middleware (`JWT_SECRET` shared with app-sh).
- Multi-stage Dockerfile (`node:20-alpine` runtime, tini PID-1).
- First-boot seed for `gainium:admin:enabled_exchanges`: if the key
  doesn't exist, expand `PRICE_CONNECTOR_EXCHANGES` env (family tokens
  → variants) and write the result; if the env is unset, write the
  full known-exchange list. Idempotent — won't clobber operator
  changes on subsequent restarts.
