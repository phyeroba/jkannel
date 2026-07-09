# ADR-0008: Kamex as the First Containerized Engine Runtime

- Status: Accepted
- Date: 2026-07-06

## Context

Upstream Kannel does not publish an official container image. JKANNEL must not base its production path on an abandoned or unverified third-party image. Kamex publishes maintained images and supplies native health, JSON status, Prometheus metrics, structured logs, and container-oriented configuration.

## Decision

Use Kamex 1.8.3 as JKANNEL's first containerized messaging-engine runtime, pinned to the official GHCR OCI digest. Keep upstream Kannel as a separately supported adapter target for external/package-managed installations. Kamex remains a sibling adapter—not “Kannel with assumed extras”—and all enhancements remain capability-discovered.

## Consequences

The Docker baseline gains a verifiable vendor-maintained runtime and richer native observability. JKANNEL still maintains Kannel contract fixtures and may add a reproducible upstream source build later, but that build no longer blocks the primary runtime roadmap.

## Evidence

- https://kamex.dev/
- https://github.com/vaska94/Kamex
- OCI image `ghcr.io/vaska94/kamex:1.8.3@sha256:c13f0e390bf0cbadef55440a6dc584670851faf41e42a027644e984502a21d7d`

