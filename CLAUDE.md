# admin-sh (`@gainium/admin-sh`)

## 📚 Platform knowledge base

A curated, auto-updated AI-agent knowledge base for the **whole Gainium platform** lives in the
private repo **`gainium-0-knowledge`** (`github.com/aressanch/gainium-0-knowledge`).
Local checkouts — Mac: `~/Git/Gainium Local/0-knowledge` · VPS: `/root/git/0-knowledge`.

Consult it before non-trivial work: `ARCHITECTURE.md` (service graph + danger boundaries),
`subsystems/<area>.md` (how each area works & breaks), `bug-patterns/`, `runbooks/`,
`domain/glossary.md`. Query 3.7k historical bugs by symptom:
`python3 <kb>/_raw/scripts/bugs.py find "<terms>"`. It is auto-enriched daily from agent session digests.

**Self-hosted control plane.** Manages the docker-compose stack and writes the Redis **`admin-config`** that
the connector/ws cores consume. Port **7507** (`PORT`/`ADMIN_PORT`), CORS to the dashboard (`:7500`).
Not deployed on prod (admin-app covers admin there). Map: [`../0-knowledge/ARCHITECTURE.md`](../0-knowledge/ARCHITECTURE.md).

## Run / test
- Install · run `src/index.ts` (ts-node, dotenv) · build per package.json scripts

## What it OWNS / EMITS (change → breaks consumers)
- **Redis `admin-config`** (`src/config.ts`, `src/redis.ts`): key `gainium:admin:enabled_exchanges`
  (JSON string[] or absent = all) + pub/sub channel `gainium:admin:config` (`{type:'enabled_exchanges_changed',ts}`).
  **Consumers: exchange-connector-sh & websocket-connector-sh cores** (flag-gated). Renaming the key/channel
  or changing the payload silently breaks enabled-exchange gating on self-hosted installs.
- REST `/api/exchanges` (GET/PUT), `/api/containers/*` (docker control + log streams), `/api/updates`,
  self-upgrade (`COMPOSE_DIR_HOST_PATH`, docker-sh). Consumed by admin-dash in self-hosted mode.

## Rules
- This is the **writer** side of the `admin-config` contract (root Danger List §8) — keep key/channel names
  and the `KNOWN_EXCHANGES` set in sync with the connector/ws consumers.
- Container/upgrade endpoints mutate the host's docker stack — destructive; self-hosted ops only.
