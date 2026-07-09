# JKANNEL Configuration Generator Engineering Specification

Version: 1.0

Status: Draft

---

# 1. Purpose

The Configuration Generator is the core of the JKANNEL platform.

Its responsibility is to convert the entire operational state stored in the JKANNEL database into valid engine configuration files.

The Configuration Generator completely replaces manual editing of:

- kannel.conf
- bearerbox.conf
- smsbox.conf
- include files
- routing files
- SMSC definitions

The database is always the single source of truth.

Configuration files are generated artifacts.

---

# 2. Philosophy

Traditional Kannel deployments require engineers to manually edit configuration files.

This approach creates problems.

- Typing mistakes
- Duplicate configuration
- Invalid syntax
- Missing dependencies
- Difficult rollbacks
- No audit history
- Poor collaboration
- Difficult automation

JKANNEL eliminates these problems.

No production configuration shall ever be edited manually.

---

# 3. Objectives

The Configuration Generator shall

Generate complete engine configuration

Validate every configuration

Preview changes

Compare versions

Maintain version history

Deploy configurations

Rollback configurations

Support multiple engines

Support future plugins

Produce deterministic output

Generate identical files for identical database content.

---

# 4. Architecture

Configuration Sources

↓

Database

↓

Object Builder

↓

Validation Engine

↓

Configuration Model

↓

Engine Adapter

↓

Configuration Renderer

↓

Generated Files

↓

Deployment Engine

↓

Health Verification

↓

Production

---

# 5. Configuration Sources

Configuration is collected from:

Global Settings

System Settings

SMSC Definitions

Routing Rules

Users

Permissions

Throttling Rules

Queue Definitions

Logging Configuration

Monitoring Configuration

Alert Configuration

Security Policies

API Settings

Docker Settings

High Availability Settings

---

# 6. Internal Configuration Model

Before rendering engine files, JKANNEL builds a complete internal configuration model.

Advantages

Independent of Kannel

Independent of Kamex

Supports future engines

Supports validation

Supports previews

Supports comparisons

Supports versioning

The internal model is never exposed directly to users.

---

# 7. Configuration Objects

Major objects include

System

SMSC

SMSBox

BearerBox

Route

Group

Throttle

User

Log

Monitor

Alert

API

Queue

Retry Policy

DLR Policy

Security Policy

---

# 8. Object Relationships

Objects reference each other.

Example

Customer

↓

Allowed Routes

↓

Allowed SMSCs

↓

Throttle Policy

↓

Queue Policy

↓

Retry Policy

↓

Logging Policy

Relationships are validated before generation.

---

# 9. Validation Pipeline

Every generation request executes:

Schema Validation

↓

Relationship Validation

↓

Dependency Validation

↓

Business Rule Validation

↓

Engine Validation

↓

Syntax Validation

↓

Generation

↓

Verification

Generation stops immediately on validation failure.

---

# 10. Business Rules

Examples

Every Route must reference an existing SMSC.

Every SMSC must belong to a valid Engine.

Disabled SMSCs cannot become primary routes.

Inactive customers cannot own routes.

Duplicate bind names are prohibited.

Circular routing is prohibited.

Undefined throttling profiles are prohibited.

---

# 11. Engine Independence

The Configuration Generator shall never contain engine-specific logic.

Instead:

Internal Objects

↓

Engine Adapter

↓

Renderer

↓

Generated Configuration

Supported Engines

Kannel

Kamex

Future engines

Each engine supplies its own renderer.

---

# 12. Rendering Engine

Each renderer converts internal objects into engine syntax.

Example

Internal SMSC Object

↓

Kannel Renderer

↓

group = smsc

smsc = smpp

host = ...

Another renderer may generate a different syntax while using the same internal object.

---

# 13. Include Files

Large configurations shall be divided automatically.

Example

Global Configuration

↓

SMSCs

↓

Routes

↓

Logging

↓

Monitoring

↓

API

↓

Security

↓

Customer Configuration

↓

Generated Include Files

Large single configuration files should be avoided.

---

# 14. Configuration Preview

Before deployment the user may preview:

Entire configuration

Individual sections

Syntax highlighting

Differences

Warnings

Errors

Generated timestamps

Renderer version

---

# 15. Difference Viewer

Compare

Current

↓

Previous

or

Any two versions

Display

Added

Removed

Modified

Moved

Renamed

Differences are colour coded.

---

# 16. Dry Run

Dry Run generates configuration without deployment.

Checks include

Validation

Relationships

Syntax

Engine Compatibility

Estimated deployment impact

Health warnings

No production changes occur.

---

# 17. Version Management

Every generation creates:

Configuration ID

Version Number

Timestamp

Author

Reason

Engine

Checksum

Deployment Status

Versions are immutable.

---

# 18. Deployment Pipeline

Generate

↓

Validate

↓

Preview

↓

Approve

↓

Backup

↓

Deploy

↓

Reload Engine

↓

Health Check

↓

Activate

↓

Audit

↓

Notify

Deployment automatically stops on failure.

---

# 19. Rollback

Rollback process

Select Version

↓

Validate

↓

Deploy

↓

Reload

↓

Verify

↓

Audit

↓

Notify

Rollback always references a previous immutable version.

---

# 20. Health Verification

After deployment JKANNEL verifies:

Bearerbox

Smsbox

Docker

SMSC Binds

Queues

API

Database

Redis

Configuration Integrity

Deployment is considered complete only after verification succeeds.

---

# 21. Audit Requirements

Every action records

User

Timestamp

Old Version

New Version

Deployment Target

Renderer

Engine

Result

Execution Time

Rollback Reference

IP Address

No deployment occurs without an audit record.

---

# 22. Acceptance Criteria (Phase 1)

The Configuration Generator is complete when:

- No production configuration is manually edited.
- All configuration is database driven.
- Generation is deterministic.
- Validation succeeds.
- Version history functions.
- Rollback functions.
- Preview functions.
- Difference viewer functions.
- Engine adapters function.
- Health verification functions.

End of Configuration Generator Engineering Specification
```

**This document is intentionally only Part 1.**

The remaining parts will cover:

- Configuration Templates
- Multi-server Configuration
- Cluster Configuration
- High Availability
- Secret Management
- Configuration Encryption
- Engine Renderer Interface
- Kannel Rendering Rules
- Kamex Rendering Rules
- Zero-Downtime Deployment
- Disaster Recovery
- Automatic Configuration Repair
- Configuration Testing Framework

This will eventually become one of the largest specifications in JKANNEL.