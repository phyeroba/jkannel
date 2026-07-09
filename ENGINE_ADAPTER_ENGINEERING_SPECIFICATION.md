# JKANNEL Engine Adapter Engineering Specification

Version: 1.0

Status: Draft

---

# 1. Purpose

The Engine Adapter Layer separates JKANNEL from the underlying SMS gateway engine.

This is one of the most important architectural components in the system.

Business modules shall never communicate directly with Kannel, Kamex, or any future SMS engine.

Instead, every interaction passes through the Engine Adapter Layer.

This allows JKANNEL to support multiple engines without changing business logic.

---

# 2. Objectives

The Engine Adapter shall:

• Abstract engine differences

• Support multiple SMS engines

• Provide a common interface

• Hide engine-specific implementation

• Allow engine replacement

• Support future plugin engines

• Maintain compatibility

• Simplify testing

---

# 3. Supported Engines

Initial support

Kannel

Kamex

Future

Jasmin

Custom SMPP Engines

Cloud SMS Platforms

REST SMS Providers

RCS Platforms

---

# 4. Philosophy

Business Modules

↓

Engine Adapter

↓

Engine

NOT

Business Modules

↓

Kannel

Business modules must never know which engine is installed.

---

# 5. Adapter Responsibilities

Configuration Generation

Configuration Deployment

Configuration Validation

Engine Health

Message Submission

Queue Monitoring

Route Monitoring

DLR Collection

Log Collection

Statistics Collection

Version Detection

Capability Detection

Engine Lifecycle

---

# 6. Engine Discovery

On startup JKANNEL shall determine:

Installed Engine

↓

Version

↓

Capabilities

↓

Supported Features

↓

Configuration Renderer

↓

Health Endpoints

↓

Metrics Provider

This allows one JKANNEL installation to manage different engines.

---

# 7. Adapter Interface

Every adapter must implement:

Initialize()

Shutdown()

Reload()

GenerateConfiguration()

DeployConfiguration()

RollbackConfiguration()

ValidateConfiguration()

Health()

Statistics()

Messages()

Queues()

Routes()

Logs()

Capabilities()

Version()

---

# 8. Configuration Services

Every adapter shall provide

Generate Configuration

Deploy

Reload

Validate

Backup

Restore

Rollback

Preview

Diff

Verification

---

# 9. Message Services

Submit Message

Retry Message

Cancel Message

Search Message

Message Status

Message History

Replay

Queue Message

Delete Message

---

# 10. SMSC Services

Create

Modify

Delete

Enable

Disable

Test

Health

Metrics

Reconnect

Statistics

---

# 11. Queue Services

Outgoing Queue

Incoming Queue

Retry Queue

DLR Queue

Dead Letter Queue

Queue Metrics

Queue Statistics

Queue Purge

Queue Replay

---

# 12. Logging Services

Retrieve Logs

Search Logs

Tail Logs

Structured Logs

JSON Logs

Log Levels

Export Logs

Archive Logs

---

# 13. Monitoring Services

CPU

Memory

Connections

Throughput

Latency

TPS

Queue Depth

Error Rate

Reconnect Count

Availability

Health Score

---

# 14. Health Services

The adapter reports

Healthy

Warning

Critical

Offline

Unknown

Health shall include

Reason

Recommendation

Affected Components

Timestamp

---

# 15. Capability Detection

Every engine exposes capabilities.

Example

Supports JSON Logs

Yes

Supports REST API

Yes

Supports Hot Reload

No

Supports Metrics

Yes

Supports Redis

Yes

Business modules use capabilities instead of engine names.

---

# 16. Renderer Selection

Each engine registers

Configuration Renderer

Validation Engine

Deployment Handler

Health Checker

Metrics Provider

Log Provider

JKANNEL automatically selects the correct implementation.

---

# 17. Engine Lifecycle

Install

↓

Discover

↓

Configure

↓

Deploy

↓

Validate

↓

Operate

↓

Monitor

↓

Upgrade

↓

Rollback

↓

Retire

---

# 18. Upgrade Support

Adapters shall support

Version Detection

Compatibility Checks

Migration

Backup

Rollback

Upgrade Validation

Health Verification

Upgrade Audit

---

# 19. Error Handling

Every adapter shall normalize errors.

Instead of exposing engine-specific messages,

JKANNEL returns

Error Code

Severity

Description

Recommendation

Documentation Link

Underlying engine errors remain available for engineers.

---

# 20. Performance Requirements

Configuration Generation

<5 seconds

Health Check

<2 seconds

Statistics

<2 seconds

Queue Queries

<2 seconds

Message Submission

Negligible adapter overhead

---

# 21. Security

Engine credentials are encrypted.

Secrets never appear in logs.

Temporary files are securely deleted.

Configuration backups are encrypted.

Engine communication is authenticated.

---

# 22. Testing

Every adapter shall pass:

Configuration Tests

Deployment Tests

Rollback Tests

Message Tests

Health Tests

Performance Tests

Compatibility Tests

Upgrade Tests

---

# 23. Future Plugin Model

Future adapters shall be installable as plugins.

Plugin Package

↓

Discovery

↓

Validation

↓

Registration

↓

Activation

↓

Capability Detection

↓

Available to JKANNEL

Plugins shall not require recompilation of JKANNEL.

---

# 24. Acceptance Criteria

The Engine Adapter layer is complete when:

- Business modules never reference engine-specific code.
- Multiple engines can coexist.
- Engine capabilities are detected automatically.
- Configuration rendering is adapter-driven.
- Health reporting functions.
- Deployment functions.
- Rollback functions.
- Monitoring functions.
- Logging functions.
- Future adapters can be added without modifying existing modules.

End of Engine Adapter Engineering Specification v1.0
```

This document is a cornerstone of the architecture. Combined with the Configuration Generator, it ensures JKANNEL remains an **SMS management platform** rather than a Kannel-only application. This will make it straightforward to add engines like Jasmin or cloud SMS providers in the future without redesigning the rest of the system.