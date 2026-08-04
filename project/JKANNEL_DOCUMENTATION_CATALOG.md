# JKANNEL Documentation Catalog

This catalog is the ownership authority. A `Master` document controls its subject; `Supporting` documents add detail; `Archived` documents remain for provenance and must not drive implementation. `Gap` means the named source was absent or empty.

> **Repository structure (2026-07-10):** the canonical specifications live under `docs/`; living project documents (state, roadmap, changelog, proposals, memory, this catalog) live under `project/`; only `README.md`, `FEATURES.md`, `AGENTS.md` and the licence files remain at the repository root. The former root-level duplicate copies of the specifications were removed — the `docs/` paths below are the single source of truth.

## Current-state authorities (2026-08-05)

The specifications below say what JKANNEL *should* do. These say what it *does*, and
they take precedence over any specification when someone asks "does this work?".

> **Dating caveat.** `FEATURES.md` and `IMPLEMENTATION_VERIFICATION.md` are anchored to
> commit `eefa320`. Commit `d58a3d2` closed several gaps they still list as open, so
> they now **understate** the product. Until the verification is re-run, the current
> position lives in `progress/pending.md`, `project/PROJECT_STATE.md` and
> `docs/user-guides/`, and `/api/v1/openapi.json` — generated from the live route
> table — is the final word on which routes exist.

| Document | Current path | Class | Authority |
|---|---|---|---|
| FEATURES.md | `FEATURES.md` | Master | **The answer to "can JKANNEL do X?"** Every entry verified by tracing a non-test caller on a real request path; includes an explicit "Not yet implemented" section. |
| IMPLEMENTATION_VERIFICATION.md | `project/IMPLEMENTATION_VERIFICATION.md` | Master | File-by-file evidence for every claim in FEATURES.md, plus the honest "not implemented" list and the claims it could not substantiate. |
| SPEC_GAP_ANALYSIS.md | `project/SPEC_GAP_ANALYSIS.md` | Supporting | The audit that produced the 20-gap list and the remediation build order. Supersedes the traceability ledger wherever the two disagree. |
| requirements-traceability.md | `progress/requirements-traceability.md` | Supporting | Per-requirement ledger. **Read its correction notice first** — earlier revisions booked *capability shipped* as *capability delivered*. |

## Operator documentation

| Document | Current path | Class |
|---|---|---|
| Operator guide index | `docs/user-guides/README.md` | Master |
| Getting started and console tour | `docs/user-guides/01-getting-started.md` | Supporting |
| Connecting an SMSC | `docs/user-guides/02-connecting-an-smsc.md` | Supporting |
| Sending messages | `docs/user-guides/03-sending-messages.md` | Supporting |
| Live Queue and recovering a bad bind | `docs/user-guides/04-live-queue-and-recovery.md` | Supporting |
| Routing | `docs/user-guides/05-routing.md` | Supporting |
| Monitoring and alerts | `docs/user-guides/06-monitoring-and-alerts.md` | Supporting |
| Reports and exports | `docs/user-guides/07-reports-and-exports.md` | Supporting |
| Customers, quotas, credit and sender IDs | `docs/user-guides/08-customers-and-quotas.md` | Supporting |
| Backup and restore | `docs/user-guides/09-backup-and-restore.md` | Supporting |
| Users, roles and permissions | `docs/user-guides/10-users-and-roles.md` | Supporting |
| Troubleshooting and FAQ | `docs/user-guides/11-troubleshooting.md` | Supporting |

`docs/admin-guides/` and `docs/developer-guides/` exist but are empty. That is recorded
as a gap rather than disguised; administrator material currently lives in the operator
guides above, and developer material in `docs/handbook/` and `docs/specifications/`.

## Governance and domain

| Canonical document | Current path | Owning module | Status | Related documents | Class |
|---|---|---|---|---|---|
| SYSTEM_ENGINEERING_HANDBOOK.md | `docs/handbook/SYSTEM_ENGINEERING_HANDBOOK.md` | Engineering governance | Active | Constitution, ADRs | Master |
| JKANNEL_SYSTEM_ENGINEERING_HANDBOOK.md | `docs/handbook/JKANNEL_SYSTEM_ENGINEERING_HANDBOOK.md` | Engineering governance | Active legacy supplement | Master handbook | Supporting |
| ENGINEERING_CONSTITUTION.md | `docs/handbook/ENGINEERING_CONSTITUTION.md` | Engineering governance | Active | Master handbook | Supporting |
| DOCUMENTATION_STANDARD.md | `docs/handbook/DOCUMENTATION_STANDARD.md` | Documentation | Active | Catalog | Supporting |
| ADR_STANDARD.md | `docs/handbook/ADR_STANDARD.md` | Architecture | Active | `decisions/` | Supporting |
| PRODUCT_VISION.md | `docs/domain/PRODUCT_VISION.md` | Product | Active | Product scope | Supporting |
| PRODUCT_SCOPE.md | `docs/domain/PRODUCT_SCOPE.md` | Product | Active | Product vision | Supporting |
| SUCCESS_CRITERIA.md | `docs/domain/SUCCESS_CRITERIA.md` | Product | Active | Product scope | Supporting |
| SYSTEM_PHILOSOPHY.md | `docs/domain/SYSTEM_PHILOSOPHY.md` | Product/architecture | Active | System architecture | Supporting |
| TELECOMMUNICATIONS_DOMAIN_MODEL.md | `docs/domain/TELECOMMUNICATIONS_DOMAIN_MODEL.md` | Domain | Active | Data model, engine/SMSC/routing specs | Master |

## Platform, database, and API

| Canonical document | Current path | Owning module | Status | Related documents | Class |
|---|---|---|---|---|---|
| SYSTEM_ARCHITECTURE.md | `docs/specifications/platform/SYSTEM_ARCHITECTURE.md` | Platform | Active | Backend, Docker, adapters | Supporting |
| BACKEND_ARCHITECTURE_ENGINEERING_SPECIFICATION.md | `docs/specifications/platform/BACKEND_ARCHITECTURE_ENGINEERING_SPECIFICATION.md` | Backend | Active | API, data model | Master |
| DOCKER_DEPLOYMENT_ENGINEERING_SPECIFICATION.md | `docs/specifications/platform/DOCKER_DEPLOYMENT_ENGINEERING_SPECIFICATION.md` | Platform operations | Active; typo corrected | Docker architecture | Master |
| DOCKER_ARCHITECTURE.md | `docs/specifications/platform/DOCKER_ARCHITECTURE.md` | Platform operations | Active | Docker deployment | Supporting |
| PHASE_1_SCAFFOLDING_MANIFEST.md | `docs/specifications/platform/PHASE_1_SCAFFOLDING_MANIFEST.md` | Platform delivery | Active | Roadmap | Supporting |
| SYSTEM_DATA_MODEL_ENGINEERING_SPECIFICATION.md | `docs/specifications/database/SYSTEM_DATA_MODEL_ENGINEERING_SPECIFICATION.md` | Database/domain | Active | Database engineering | Master |
| DATABASE_ENGINEERING_SPECIFICATION.md | `docs/specifications/database/DATABASE_ENGINEERING_SPECIFICATION.md` | Database | Active | Data model | Master |
| DATABASE_ARCHITECTURE.md | `docs/specifications/database/DATABASE_ARCHITECTURE.md` | Database | Active | Database engineering | Supporting |
| REST_API_ENGINEERING_STANDARD.md | `docs/specifications/api/REST_API_ENGINEERING_STANDARD.md` | API | Active | API Gateway | Master |
| API_GATEWAY_ENGINEERING_SPECIFICATION.md | `docs/specifications/api/API_GATEWAY_ENGINEERING_SPECIFICATION.md` | API Gateway | Active; typo corrected | REST standard | Master |
| API_ARCHITECTURE.md | `docs/specifications/api/API_ARCHITECTURE.md` | API | Active | REST standard | Supporting |

## UI, engine, AI, SDK, and security

| Canonical document | Current path | Owning module | Status | Related documents | Class |
|---|---|---|---|---|---|
| UI_SCREEN_ENGINEERING_SPECIFICATION.md | `docs/specifications/ui/UI_SCREEN_ENGINEERING_SPECIFICATION.md` | Frontend/UI | Active | Design authority | Master |
| FRONTEND_ENGINEERING_SPECIFICATION.md | `docs/specifications/ui/FRONTEND_ENGINEERING_SPECIFICATION.md` | Frontend | Active; React choice superseded by ADR-0003 | UI specification | Master requirements |
| DASHBOARD_ENGINEERING_SPECIFICATION_2.md | `docs/specifications/ui/DASHBOARD_ENGINEERING_SPECIFICATION_2.md` | Dashboard | Active | Dashboard series | Master |
| DASHBOARD_SPEC_01..03 | `docs/specifications/ui/DASHBOARD_SPEC_*.md` | Dashboard | Active | Dashboard master | Supporting series |
| KANNEL_ENGINE_ADAPTER_SPECIFICATION.md | `docs/specifications/engine/KANNEL_ENGINE_ADAPTER_SPECIFICATION.md` | Kannel adapter | Active | Generic adapter | Master |
| ENGINE_ADAPTER_ENGINEERING_SPECIFICATION.md | `docs/specifications/engine/ENGINE_ADAPTER_ENGINEERING_SPECIFICATION.md` | Engine adapter | Active | Kannel adapter | Master |
| ENGINE_ADAPTER_ARCHITECTURE.md | `docs/specifications/engine/ENGINE_ADAPTER_ARCHITECTURE.md` | Engine adapter | Active | Adapter engineering | Supporting |
| ENGINE_ADAPTER_CONTRACT.md | `docs/specifications/engine/ENGINE_ADAPTER_CONTRACT.md` | Engine adapter | Active | Capability registry, ADR-0007 | Master contract addendum |
| ENGINE_CAPABILITY_REGISTRY.md | `docs/specifications/engine/ENGINE_CAPABILITY_REGISTRY.md` | Engine adapter | Active | Adapter contract, Kamex assessment | Master |
| ENGINE_OBSERVABILITY_DATA_MODEL.md | `docs/specifications/engine/ENGINE_OBSERVABILITY_DATA_MODEL.md` | Engine observability | Active | System data model, capability registry | Master data-model addendum |
| KAMEX_ENGINE_CAPABILITY_ASSESSMENT.md | `docs/specifications/engine/KAMEX_ENGINE_CAPABILITY_ASSESSMENT.md` | Kamex adapter | Evidence baseline | ADR-0007, capability registry | Supporting assessment |
| CONFIGURATION_GENERATOR_ENGINEERING_SPECIFICATION.md | `docs/specifications/engine/CONFIGURATION_GENERATOR_ENGINEERING_SPECIFICATION.md` | Configuration generator | Active | Generator series | Master |
| CONFIGURATION_GENERATOR_SPEC_01..10 | `docs/specifications/engine/CONFIGURATION_GENERATOR_SPEC_*.md` | Configuration generator | Active | Generator master | Supporting series |
| SMSC_MANAGER_CATALOG.md | `docs/specifications/engine/SMSC_MANAGER_CATALOG.md` | SMSC manager | Active | SMSC series | Supporting |
| SMSC_MANAGER_SPEC_01..06,10 | `docs/specifications/engine/SMSC_MANAGER_SPEC_*.md` | SMSC manager | Active | Engine adapter | Supporting series |
| ROUTING_ENGINE_SPEC_01..09 | `docs/specifications/engine/ROUTING_ENGINE_SPEC_*.md` | Routing | Active | SMSC manager | Supporting series |
| AI_OPERATIONS_ENGINE_SPECIFICATION.md | `docs/specifications/ai/AI_OPERATIONS_ENGINE_SPECIFICATION.md` | AI Operations | Active; restored source | Audit/security | Master |
| PLUGIN_AND_EXTENSION_FRAMEWORK_ENGINEERING_SPECIFICATION.md | `docs/specifications/sdk/PLUGIN_AND_EXTENSION_FRAMEWORK_ENGINEERING_SPECIFICATION.md` | Plugins/SDK | Active | Plugin SDK | Master |
| PLUGIN_DEVELOPMENT_SDK.md | `docs/specifications/sdk/PLUGIN_DEVELOPMENT_SDK.md` | SDK | Active; reconciled with restored master and governing specifications | Plugin framework, REST API, security, engine adapter contract | Master |
| SECURITY_ENGINEERING_SPECIFICATION.md | `docs/specifications/security/SECURITY_ENGINEERING_SPECIFICATION.md` | Security | Active | User management | Master |
| USER_MANAGEMENT_ENGINEERING_SPECIFICATION.md | `docs/specifications/security/USER_MANAGEMENT_ENGINEERING_SPECIFICATION.md` | Identity/RBAC | Active | User series | Master |
| USER_MANAGEMENT_SPEC_01..04 | `docs/specifications/security/USER_MANAGEMENT_SPEC_*.md` | Identity/RBAC | Active | User management master | Supporting series |

## Operations

| Canonical document | Current path | Owning module | Status | Related documents | Class |
|---|---|---|---|---|---|
| ALERTS_ENGINEERING_SPECIFICATION.md | `docs/specifications/operations/ALERTS_ENGINEERING_SPECIFICATION.md` | Alerts | Active; newer source selected | Monitoring series | Master |
| REPORTING_ENGINEERING_SPECIFICATION.md | `docs/specifications/operations/REPORTING_ENGINEERING_SPECIFICATION.md` | Reporting | Active | Message explorer | Master |
| MESSAGE_EXPLORER_ENGINEERING_SPECIFICATION.md | `docs/specifications/operations/MESSAGE_EXPLORER_ENGINEERING_SPECIFICATION.md` | Message explorer | Active | Explorer series | Master |
| MESSAGE_EXPLORER_SPEC_01..04 | `docs/specifications/operations/MESSAGE_EXPLORER_SPEC_*.md` | Message explorer | Active | Explorer master | Supporting series |
| MONITORING_SPEC_01..03 | `docs/specifications/operations/MONITORING_SPEC_*.md` | Monitoring | Active | Alerts, logging | Supporting series |
| LOGGING_AND_AUDIT_ENGINEERING_SPECIFICATION.md | `docs/specifications/operations/LOGGING_AND_AUDIT_ENGINEERING_SPECIFICATION.md` | Logging/audit | Active | Security, monitoring | Master |
| HIGH_AVAILABILITY_ENGINEERING_SPECIFICATION.md | `docs/specifications/operations/HIGH_AVAILABILITY_ENGINEERING_SPECIFICATION.md` | Reliability | Active | Backup, performance | Master |
| TESTING_AND_QUALITY_ASSURANCE_ENGINEERING_SPECIFICATION.md | `docs/specifications/operations/TESTING_AND_QUALITY_ASSURANCE_ENGINEERING_SPECIFICATION.md` | Quality | Active | All modules | Master |
| BACKUP_AND_DISASTER_RECOVERY_ENGINEERING_SPECIFICATION.md | `docs/specifications/operations/BACKUP_AND_DISASTER_RECOVERY_ENGINEERING_SPECIFICATION.md` | Reliability | Active; restored source | HA, database | Master |
| PERFORMANCE_AND_SCALABILITY_ENGINEERING_SPECIFICATION.md | `docs/specifications/operations/PERFORMANCE_AND_SCALABILITY_ENGINEERING_SPECIFICATION.md` | Performance | Active; restored source | HA, testing | Master |

## Architecture decision records

ADRs live in two directories. Both are canonical.

| ADR | Current path | Subject |
|---|---|---|
| ADR-0001 | `decisions/ADR-0001-monorepo-structure.md` | Monorepo structure |
| ADR-0002 | `decisions/ADR-0002-backend-stack.md` | Backend stack |
| ADR-0003 | `decisions/ADR-0003-frontend-stack.md` | Frontend stack (supersedes the React choice in the frontend specification) |
| ADR-0004 | `decisions/ADR-0004-docker-first-runtime.md` | Docker-first runtime |
| ADR-0005 | `decisions/ADR-0005-engine-adapter-abstraction.md` | Engine Adapter abstraction |
| ADR-0006 | `decisions/ADR-0006-design-spec-as-visual-authority.md` | `design/design_spec/` as visual authority |
| ADR-0007 | `decisions/ADR-0007-KANNEL-VS-KAMEX.md` | Kannel and Kamex as independently assessed siblings |
| ADR-0008 | `decisions/ADR-0008-kamex-first-container-runtime.md` | Kamex as the first containerized runtime |
| ADR-0008 | `docs/adr/ADR-0008-control-plane-boundary.md` | **JKANNEL is a control plane; the engine owns the data plane** |

> **Known defect: the number 0008 is used twice.** The control-plane-boundary ADR was
> authored in `docs/adr/` without checking `decisions/`. Both documents are accepted and
> in force; neither is superseded. Cite them by path or by title, never by number alone.
> Renumbering is deferred rather than done silently, because the control-plane ADR is
> already referenced by number from `FEATURES.md`, `README.md`, the operator guides and
> `backend/src/queue-console/`.

## Visual authority

| Canonical document | Current path | Owning module | Status | Related documents | Class |
|---|---|---|---|---|---|
| Visual design reference set | `design/design_spec/` | Frontend/design | Preserved unchanged | UI screen specification, ADR-0006 | Master visual reference |

## Retired

| Document | Retired | Why | Superseded by |
|---|---|---|---|
| `project/SUPERVISOR_HANDOVER_SUMMARY.md` | 2026-08-04 | A point-in-time status memo written for a single review on 2026-07-09. Its capability claims and test counts were nine cycles out of date, and its "honest limitations" section had been overtaken by the spec-gap audit. Keeping a stale second answer to "what works?" invites the reader to trust the wrong one. | `FEATURES.md` (capability), `project/IMPLEMENTATION_VERIFICATION.md` (evidence), `docs/user-guides/` (how to operate it), `README.md` (how to run it) |

## Archive inventory

The following are intentionally non-canonical: `docs/archive/ALERTS_ENGINEERING_SPECIFICATION.md` (older duplicate), `JKANNEL_DOCUMENTATION_CATALOG(1|2|3|4|5|7).md` (superseded catalogs), `JKANNEL_CODEX_FOUNDATION_PROMPT.md`, `JKANNEL_CODEX_WORKFLOW_ADAPTATION(1).md`, `JKANNEL_FOLDER_SCAFFOLDING(1).md`, and `JKANNEL_PROJECT_MEMORY(1).md` (superseded prompt/planning drafts). Their status is **Archived** and class is **duplicate or superseded supporting material**.
