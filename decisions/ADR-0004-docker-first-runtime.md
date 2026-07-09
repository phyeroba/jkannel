# ADR-0004: Docker-First Runtime

- Status: Accepted
- Date: 2026-07-06

## Context

JKANNEL requires reproducible local and server environments across the API, UI, PostgreSQL, Redis, and eventually Kannel and observability services.

## Decision

Use Docker Compose as the initial development and deployment baseline. Services expose health checks, configuration comes from environment variables, state uses named volumes, and container design remains compatible with future Kubernetes deployment.

## Consequences

Local parity improves, but Compose is not itself the final HA orchestrator. Images, startup ordering, persistence, and secret injection require continuous validation.

