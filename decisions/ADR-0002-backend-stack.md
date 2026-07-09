# ADR-0002: Backend Stack

- Status: Accepted
- Date: 2026-07-06

## Context

The system needs modular APIs, dependency injection, validation, background processing, adapter boundaries, and strong typing. The master handbook explicitly selects NestJS, PostgreSQL, and Redis.

## Decision

Use Node.js with NestJS and TypeScript. PostgreSQL is the system of record; Redis is limited to cache, queues, locks, and real-time coordination. Begin as a modular monolith and split deployables only with measured operational need.

## Consequences

Module boundaries and contracts become enforceable early. The project must control dependency upgrades, event-loop blocking, validation, and graceful shutdown.

