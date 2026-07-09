# JKANNEL

JKANNEL is a Docker-first telecommunications operations platform for managing SMS gateway engines through a generic Engine Adapter. Kannel is the first adapter implementation.

## Repository status

Phase 0 repository organization is complete. Phase 1 provides the initial backend and frontend health-check scaffold with PostgreSQL and Redis dependencies. See `PROJECT_STATE.md`, `ROADMAP.md`, and `TASKS.md`.

## Quick start

1. Copy `.env.example` to `.env` and replace the development-only values.
2. Run `docker compose config`.
3. Run `docker compose up --build`.
4. Open the frontend at `http://localhost:5173` and backend health endpoint at `http://localhost:3000/api/v1/health`.

Canonical engineering documentation is indexed in `JKANNEL_DOCUMENTATION_CATALOG.md`.
