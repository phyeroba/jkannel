# JKANNEL Engineering Constitution

Version: 1.0\
Status: Ratified

## Purpose

This document defines the engineering constitution for JKANNEL. Every
human contributor and every AI agent working on the project shall follow
this document. If another project document conflicts with this
constitution, this document takes precedence.

------------------------------------------------------------------------

## 1. Documentation Before Implementation

No major feature shall be implemented until its purpose, requirements,
architecture, data model, API, security, monitoring, and testing
expectations have been documented.

## 2. Architecture Is Intentional

Architectural changes require an Architecture Decision Record (ADR). No
architectural changes are made without updating the relevant
documentation.

## 3. Autonomous Engineering

Once a phase, specification, or implementation plan has been approved,
Codex shall execute the work autonomously. Routine engineering decisions
should be made without repeatedly asking for approval.

Codex should behave as a senior software engineer, not a code generator.

## 4. Internal Engineering Review

Before considering any task complete, Codex shall internally review the
implementation from the perspectives of:

-   Systems Architecture
-   Backend Engineering
-   Frontend Engineering
-   Database Engineering
-   DevOps
-   Security
-   QA
-   Technical Documentation

Any issues found should be corrected before presenting the work.

## 5. Escalation Policy

Codex shall interrupt autonomous work only when:

-   Requirements conflict
-   A new ADR is required
-   Credentials or external access are required
-   A production-impacting operation is requested
-   The Engineering Constitution would be violated

## 6. Docker First

Every component shall be designed for Docker deployment.

## 7. API First

Business functionality shall be exposed through documented APIs. The web
application should consume those APIs whenever practical.

## 8. Security By Default

Least privilege, encrypted secrets, audit trails, and role-based access
control are mandatory.

## 9. Single Source of Truth

Business logic shall exist in one place only. Duplicate implementations
are not acceptable.

## 10. Configuration Over Code

Values likely to change shall be configurable instead of hardcoded.

## 11. Observability

Every important operation should produce logs, metrics, and audit
events.

## 12. Testing

Every module shall define unit, integration, and acceptance testing
expectations.

## 13. Documentation Is Deliverable

A feature is not complete until the documentation has been updated.

## 14. Project Memory

PROJECT_MEMORY.md, PROJECT_STATE.md, ADRs, progress logs, pending work,
and task tracking documents shall always be updated as implementation
progresses.

## 15. Implementation Completeness

A task is complete only when:

-   Code builds successfully
-   Tests pass
-   Documentation is updated
-   Project memory is updated
-   Progress tracking is updated
-   The next recommended task is recorded

The project shall always remain in a state where autonomous work can
resume after interruption without losing context.
