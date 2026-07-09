# JKANNEL Roadmap

Every phase requires documentation updates and a passing review for architecture, security, performance, and quality. Docker validation means `docker compose config` plus startup/health validation where the phase changes runtime behavior.

| Phase | Outcome | Dependencies | Acceptance criteria and tests | Documentation / Docker gate |
|---|---|---|---|---|
| 0 - Repository organization and project memory | Canonical structure, catalog, ADRs, memory | Supplied specifications | Inventory reconciled; no source document lost; paths audited | Catalog, state, logs updated; N/A |
| 1 - Docker baseline | Bootable web/API/Postgres/Redis baseline | Phase 0 | Backend health unit test; package builds; Compose config valid; containers healthy | Scaffold manifest and runbooks; Compose startup required |
| 2 - Backend foundation | Configuration, logging, errors, API conventions | Phase 1 | Unit/integration harness passes; validated environment and error contracts | Backend guides; backend container required |
| 3 - Database foundation | Schema, migrations, repositories, audit primitives | Phase 2 | Migration up/down and repository integration tests pass | Data catalog and migration guide; Postgres required |
| 4 - Authentication and RBAC | Secure identity, sessions/tokens, permissions | Phase 3 | Auth, authorization, lockout, audit, and security tests pass | Security/admin guides; full dependency startup |
| 5 - Frontend shell | JKANNEL navigation, layouts, auth guards, design tokens | Phases 2, 4 | Component, route, accessibility, and e2e shell tests pass | UI mapping updated; frontend/backend startup |
| 6 - Engine Adapter foundation | Generic engine contracts and lifecycle | Phases 2, 3 | Contract and fake-adapter tests pass; no Kannel leakage | Adapter developer guide; backend startup |
| 7 - Kamex Docker baseline | Official digest-pinned Kamex adapter/runtime; external Kannel remains supported | Phase 6 | Bearerbox health, smsbox startup, configuration, metrics/status, and adapter integration tests pass | Kamex runbook; `engine-kamex` Compose profile required |
| 8 - Configuration generator foundation | Versioned configuration generation/validation | Phases 3, 6, 7 | Determinism, validation, rollback, and integration tests pass | Generator guide; relevant containers required |
| 9 - SMSC manager foundation | SMSC CRUD and lifecycle | Phases 4, 6, 8 | API, permission, lifecycle, and e2e tests pass | Admin guide; full stack required |
| 10 - Routing foundation | Route rules and deterministic evaluation | Phases 3, 6, 9 | Rule, priority, validation, and performance tests pass | Routing guide; full stack required |
| 11 - Message explorer foundation | Search, trace, DLR visibility | Phases 3, 4, 6 | Query, authorization, pagination, and load tests pass | Operations guide; full stack required |
| 12 - Monitoring and alerts foundation | Metrics, health, alerts, audit visibility | Phases 6, 7, 11 | Metrics/alert integration and failure-mode tests pass | Operations runbook; monitoring profile required |
| 13 - Reporting foundation | Controlled operational reporting | Phases 4, 11 | Accuracy, authorization, export, and load tests pass | Reporting guide; full stack required |
| 14 - Plugin SDK foundation | Versioned extension contracts and sandbox policy | Phases 2, 4, 6 | Compatibility, permission, isolation, and example tests pass | SDK/developer guides; test plugin runtime |
| 15 - AI Operations foundation | Guardrailed explain/assist workflows | Phases 11-14 | Human-approval, privacy, safety, fallback, and audit tests pass | AI operations runbook; opt-in profile only |
| 16 - Production hardening | HA, DR, performance, security, release readiness | All earlier phases | Threat model, pen test, load/soak, restore, failover, and e2e acceptance pass | Complete operator docs; production-like validation |
