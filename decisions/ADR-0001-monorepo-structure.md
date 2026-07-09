# ADR-0001: Production Monorepo Structure

- Status: Accepted
- Date: 2026-07-06

## Context

JKANNEL began as loose specifications and visual references. Application, infrastructure, documentation, tests, plugins, SDK, and operational artifacts need explicit ownership without premature service fragmentation.

## Decision

Use one monorepo with top-level `backend`, `frontend`, `infrastructure`, `plugins`, `sdk`, `testing`, `deployment`, `docs`, `architecture`, `decisions`, and `progress` boundaries. Specifications remain grouped by owning capability under `docs/specifications`.

## Consequences

Atomic cross-layer changes and centralized governance are straightforward. Ownership must remain disciplined, and later independent deployments may require workspace/build tooling.

