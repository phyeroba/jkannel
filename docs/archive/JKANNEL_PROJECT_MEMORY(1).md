# JKANNEL Project Memory

## Project Name

JKANNEL

## Project Location

The intended local development location is:

```text
D:\JKANNEL
```

## Project Purpose

JKANNEL is a modern GUI and management interface for Kannel SMS Gateway and compatible engines such as Kamex.

The product exists to make Kannel easier to deploy, configure, monitor, operate, troubleshoot, and commercialize for technical and semi-technical users.

JKANNEL must reduce direct dependence on manually editing Kannel configuration files, reading raw logs, manually checking binds, and manually interpreting gateway status output.

## Product Vision

JKANNEL should become an SMS Gateway Management Platform and eventually an SMS Infrastructure Operating System.

If Kannel or Kamex is the SMS engine, JKANNEL is the cockpit, control panel, API shield, monitoring layer, configuration manager, business layer, and operational brain around it.

## Core System Scope

JKANNEL must provide a modern web-based admin interface for:

- SMSC gateway connections
- Bearerbox configuration
- Smsbox configuration
- SMS routes
- Throttling rules
- Live binds
- Bind health
- Throughput monitoring
- Incoming SMS visibility
- Outgoing SMS visibility
- Delivery reports
- Queues
- Logs
- Alerts
- System health
- Configuration generation
- Docker lifecycle management
- Backup and restore of configuration
- Role-based administration
- API access for external systems
- Future customer, vendor, billing, reseller, and tenant features

## Kannel / Kamex Strategy

JKANNEL should be designed with an SMS engine adapter architecture.

The first supported engines should be:

1. Kannel
2. Kamex

Kannel is the original mature SMS gateway.

Kamex is a modernized Kannel-compatible fork with features useful for JKANNEL, including Docker support, JSON APIs, health checks, Prometheus metrics, JSON logs, Redis/Valkey support, and improved observability.

JKANNEL must not be hardcoded in a way that prevents future support for other SMS gateway engines.

## Docker Strategy

Kannel or Kamex must run inside Docker.

JKANNEL must also run through Docker during development and production packaging.

The system should use separate services/containers rather than one large container.

Planned containers:

- jkannel-frontend
- jkannel-backend
- jkannel-engine
- postgres
- redis
- nginx
- prometheus
- grafana

During the first foundation phase, only starter Docker files are required. Do not assume production credentials.

## UI Direction

The UI must feel like a modern network operations and SMS operations dashboard.

It should expose everything Kannel produces or controls, including:

- Logs
- Binds
- Throughput
- Routing
- Delivery reports
- Queues
- Health
- Configuration
- SMSC state
- Docker state

The `design_spec/` folder exists in the project folder on the owner's laptop. Codex must treat that folder as a visual reference and adaptation source, not as code to blindly paste into JKANNEL.

## API Direction

External systems must consume JKANNEL's API, not raw Kannel endpoints directly.

The JKANNEL API should provide:

- Authentication
- API keys
- Rate limiting
- Message submission
- Bulk message submission
- Message status lookup
- DLR callback handling
- Webhooks
- Route selection
- Sender ID validation
- Customer/vendor permissions
- Reporting endpoints

## Preferred Technical Direction

The backend stack is not permanently decided at the foundation stage.

Candidate backend options:

- Laravel
- Node.js / NestJS
- Django

Preferred database:

- PostgreSQL

Likely supporting infrastructure:

- Redis for queues, cache, rate limiting, live monitoring, and job processing
- Docker Compose for local and initial production deployment
- Prometheus and Grafana for observability

## Codex Memory Requirement

The project owner wants Codex to behave like an engineer with persistent project memory.

Codex must always read the memory/context files before working and update them after meaningful work.

Key memory files:

- AGENTS.md
- PROJECT_MEMORY.md
- PROJECT_STATE.md
- ROADMAP.md
- TASKS.md
- CHANGELOG.md
- progress/session-log.md
- progress/completed.md
- progress/pending.md
- progress/blockers.md
- progress/next-actions.md
- decisions/ADR-*.md

## Documentation First Rule

Before building the full backend or frontend, JKANNEL must have a strong documentation foundation.

Every major module must eventually have:

- Purpose
- Scope
- User roles
- Data model
- API requirements
- UI requirements
- Validation rules
- Security rules
- Logging requirements
- Testing requirements

## Phase 0 Intent

The first Codex task is not to build the full app.

The first Codex task is to create the complete project folder structure, memory/context system, starter documentation, and safe Docker baseline files.

## Guiding Principle

JKANNEL must make Kannel less technical without hiding important operational details from engineers.

It must be simple enough for operators, but deep enough for SMS gateway administrators.
