# JKANNEL Telecommunications Domain Model

- Version: 1.0
- Status: Master domain specification

## Domain boundary

JKANNEL is a communications operations platform that manages messaging engines, SMSC connectivity, routing, message lifecycle, delivery reports, configuration, monitoring, and audited runtime control. The model is engine-independent; Kannel and Kamex are adapter implementations.

## Ubiquitous language

| Term | Meaning |
|---|---|
| Engine instance | One registered messaging-engine runtime managed through an adapter |
| SMSC | Logical upstream/downstream messaging connection, independent of engine syntax |
| Bind/session | Observed protocol connection between an engine and SMSC |
| MT | Mobile-terminated message submitted toward a handset |
| MO | Mobile-originated message received from a handset |
| DLR | Delivery status event associated with an originating message |
| Route | Versioned policy selecting an SMSC or group for a message |
| Configuration deployment | Audited transition of validated desired configuration to an engine |
| Capability snapshot | Evidence-backed statement of what one engine/build can currently support |

## Bounded contexts

- **Engine Operations:** engine registrations, adapters, capabilities, health, runtime snapshots and lifecycle actions.
- **SMSC Management:** logical SMSCs, credentials references, protocol settings, connections, health and throughput.
- **Routing:** policies, rules, conditions, priorities, failover, cost and simulation traces.
- **Messaging:** immutable message identity, payload metadata, submission, state transitions and SMSC trace.
- **Delivery Reports:** raw/normalized DLR events, matching, state application and callbacks.
- **Configuration:** models, generation, validation, versions, deployment and rollback.
- **Identity/Audit:** tenant, user, role, permission, approval and append-only audit events.
- **Observability:** metrics, logs, alerts, incidents and freshness.

## Core invariants

- PostgreSQL is JKANNEL's system of record; engine-owned SQLBox/message/DLR stores are external observations.
- Every message, route decision, configuration deployment, capability observation and runtime mutation is traceable by tenant and correlation ID.
- Raw inbound payloads/events remain immutable; normalization and state transitions create linked records.
- Credentials are secret references, never plaintext domain attributes.
- Business modules branch on capabilities, not engine names.
- Route evaluation is deterministic for a policy version and recorded inputs.
- DLR updates never erase the original message or raw DLR event.
- Traffic-affecting runtime actions require authorization, current capability evidence, approval where configured, and audit.

## Aggregate relationships

Tenant owns engine instances, SMSCs, routes, messages and users. An engine instance selects one adapter build and has many capability/runtime snapshots. An SMSC has many observed connections and metrics. A message has one immutable identity, many lifecycle events, routing traces, SMSC attempts and DLR events. Configuration versions produce deployments targeting engine instances.

Physical tables and constraints are defined by `SYSTEM_DATA_MODEL_ENGINEERING_SPECIFICATION.md` and `ENGINE_OBSERVABILITY_DATA_MODEL.md`; those specifications must preserve these domain invariants.

