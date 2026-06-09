# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
