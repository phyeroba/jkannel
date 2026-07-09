# JKANNEL Database Engineering Specification

Version: 1.0

Status: Draft

---

# 1. Purpose

The Database is the authoritative source of truth for the JKANNEL platform.

No business logic shall depend directly on configuration files.

Every configuration, message, event, metric, audit record and operational object shall be represented in the database before being rendered into engine-specific configuration.

The database is the heart of JKANNEL.

---

# 2. Objectives

The database shall:

• Store all platform configuration

• Store operational history

• Store audit records

• Store monitoring data

• Store reporting data

• Store user information

• Store message history

• Store routing information

• Store deployment history

• Support rollback

• Support high availability

• Support future clustering

---

# 3. Database Technology

Primary Database

PostgreSQL

Reason

Enterprise stability

Excellent indexing

JSON support

Full-text search

Partitioning

Replication

Mature tooling

Excellent Docker support

---

# 4. Database Principles

Database First

Every business object exists in the database.

Configuration Generated

Configuration files are generated from database objects.

No Manual Editing

Generated files are never the primary source.

Version Everything

Configuration changes are version controlled.

Audit Everything

Every important change is recorded.

Soft Delete Preferred

Operational history should never be lost.

---

# 5. Major Domains

Identity

Configuration

Routing

Messaging

Monitoring

Alerting

Reporting

Security

Infrastructure

Audit

Administration

---

# 6. Identity Schema

Core Tables

users

roles

permissions

role_permissions

user_roles

sessions

api_keys

login_history

password_history

mfa_devices

service_accounts

---

# 7. SMSC Schema

smsc

smsc_groups

smsc_versions

smsc_metrics

smsc_health

smsc_events

smsc_templates

smsc_tags

smsc_deployments

---

# 8. Routing Schema

routes

route_rules

route_groups

route_conditions

route_actions

route_versions

route_history

route_tags

---

# 9. Messaging Schema

messages

message_parts

message_status

message_events

message_retries

message_errors

message_tags

message_metadata

---

# 10. Delivery Report Schema

delivery_reports

dlr_events

dlr_status

dlr_history

---

# 11. Monitoring Schema

system_metrics

smsc_metrics

docker_metrics

api_metrics

database_metrics

queue_metrics

performance_metrics

resource_metrics

health_checks

---

# 12. Alert Schema

alerts

alert_events

alert_comments

alert_assignments

alert_notifications

alert_rules

alert_suppressions

alert_escalations

---

# 13. Reporting Schema

report_templates

report_jobs

report_results

scheduled_reports

report_exports

---

# 14. Configuration Schema

configuration_versions

configuration_files

deployment_history

deployment_targets

deployment_results

rollback_history

---

# 15. Audit Schema

audit_log

audit_categories

audit_actions

audit_entities

audit_sessions

Audit records shall never be modified.

---

# 16. Infrastructure Schema

docker_hosts

docker_containers

docker_images

docker_events

server_inventory

network_interfaces

ssl_certificates

---

# 17. Relationships

Every table shall define

Primary Key

Foreign Keys

Unique Constraints

Indexes

Check Constraints

Retention Policy

Archive Policy

Audit Policy

---

# 18. Naming Standards

Tables

snake_case

Columns

snake_case

Primary Keys

id

Foreign Keys

object_id

Boolean

is_enabled

is_deleted

is_locked

Date Fields

created_at

updated_at

deleted_at

---

# 19. Indexing Strategy

Index

Foreign Keys

Search Fields

Phone Numbers

Message IDs

Customer IDs

SMSC IDs

Status

Created Date

Updated Date

Route IDs

Composite indexes shall be used where beneficial.

---

# 20. Partitioning

The following tables shall support partitioning.

messages

delivery_reports

audit_log

system_metrics

performance_metrics

Historical partitions shall be archived automatically.

---

# 21. Transactions

Business operations shall execute within transactions.

Configuration deployment

Message submission

User creation

Permission changes

Route deployment

Rollback

Audit creation

Transactions shall guarantee consistency.

---

# 22. Versioning

Version controlled objects include

Configurations

Routes

SMSC Definitions

Templates

Global Settings

Permissions

Deployment Plans

Rollback shall always reference a previous version.

---

# 23. Data Retention

Retention shall be configurable.

Examples

Messages

180 Days

DLRs

180 Days

Audit Logs

7 Years

Metrics

365 Days

Alerts

3 Years

Configuration History

Permanent

---

# 24. Backup Strategy

Logical Backup

Physical Backup

Incremental Backup

Point-in-Time Recovery

Encrypted Backup

Off-site Replication

Automated Backup Verification

---

# 25. Performance Requirements

Message Inserts

<10 ms

Search

<2 seconds

Configuration Generation

<5 seconds

Route Lookup

<50 ms

Dashboard Queries

<2 seconds

---

# 26. Acceptance Criteria

The database layer is complete when:

- All entities are normalized.
- Relationships are enforced.
- Foreign keys are valid.
- Versioning functions correctly.
- Rollback functions correctly.
- Audit history is complete.
- Performance targets are met.
- Backup and restore are verified.
- Partitioning operates correctly.
- Retention policies function automatically.

End of Database Engineering Specification v1.0