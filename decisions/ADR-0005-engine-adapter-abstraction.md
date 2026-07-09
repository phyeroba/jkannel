# ADR-0005: Generic Engine Adapter

- Status: Accepted
- Date: 2026-07-06

## Context

Direct Kannel coupling would embed gateway-specific commands and configuration semantics throughout JKANNEL.

## Decision

Define a generic Engine Adapter contract for lifecycle, configuration, health, capabilities, and operational actions. Implement Kannel as the first adapter. No application module may bypass this boundary.

## Consequences

The platform can support future engines and test against fakes. Adapter contracts require explicit capability negotiation and careful error normalization.

