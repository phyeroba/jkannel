# Docker Runtime

The root `docker-compose.yml` is the canonical Phase 1 runtime definition. Copy `.env.example` to the untracked `.env`, validate with `docker compose config`, then start with `docker compose up --build`.

Phase 1 runs PostgreSQL, Redis, the NestJS health API, and the Vue development server. Kannel is deliberately excluded until Phase 7.

