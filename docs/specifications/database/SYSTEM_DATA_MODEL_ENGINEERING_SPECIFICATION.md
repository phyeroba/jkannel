# JKANNEL System Data Model Engineering Specification

Version: 1.0

Status: Master Engineering Specification

Document Owner: System Architecture

Classification: Internal Engineering

Related Documents

- JKANNEL_SYSTEM_ENGINEERING_HANDBOOK.md
- DATABASE_ENGINEERING_SPECIFICATION.md
- REST_API_ENGINEERING_STANDARD.md
- CONFIGURATION_GENERATOR_ENGINEERING_SPECIFICATION.md
- ENGINE_ADAPTER_ENGINEERING_SPECIFICATION.md

---

# Chapter 1

# Introduction

## Purpose

The JKANNEL System Data Model defines the canonical representation of every business object within the platform.

Every module implemented throughout JKANNEL shall persist its operational state through this model.

No module may introduce independent storage models without architectural approval.

The purpose of this document is to ensure that every engineer, every AI coding agent and every future contributor understands the relationships between every entity in the system before implementation begins.

This document intentionally describes the platform independently of any programming language or ORM.

The database model represents the business.

The application merely manipulates the model.

---

## Scope

This specification defines

• Entity domains

• Tables

• Relationships

• Keys

• Constraints

• Naming conventions

• Versioning strategy

• Archiving strategy

• Retention strategy

• Multi-tenancy preparation

• Partitioning strategy

• Data ownership

• Referential integrity

• Audit requirements

• Performance strategy

---

## Design Goals

The data model shall satisfy the following objectives.

Enterprise scalability.

Engine independence.

Long-term maintainability.

Operational transparency.

Historical traceability.

High-performance querying.

Complete auditability.

Future extensibility.

Support for plugin architecture.

Support for clustering.

Support for future billing.

Support for future AI.

---

# Chapter 2

# Data Architecture Philosophy

JKANNEL follows a Database First Architecture.

Every business object originates inside the database.

Configuration files are generated.

Dashboard widgets read from the database.

Reports read from the database.

Monitoring stores metrics inside the database.

Alerts reference database entities.

APIs expose database entities through domain services.

The only exception shall be temporary runtime cache stored in Redis.

Redis is never considered the system of record.

---

## Single Source of Truth

Every business object shall exist once.

For example

Customer

↓

Routes

↓

SMSC

↓

Configuration

↓

Generated Configuration

The generated configuration file is not authoritative.

If manually edited it shall be overwritten by the next deployment.

---

## Object Identity

Every major entity shall possess

Internal Integer ID

UUID

Human Readable Name

Creation Timestamp

Update Timestamp

Version Number

Enabled Status

Archive Status

Checksum (where applicable)

This guarantees stable references regardless of implementation language.

---

# Chapter 3

# Domain Driven Data Model

The database is divided into independent business domains.

Each domain owns its entities.

Cross-domain communication occurs only through defined foreign keys.

The domains are

SYSTEM

IDENTITY

CUSTOMERS

SMSC

ROUTING

MESSAGING

DELIVERY REPORTS

CONFIGURATION

MONITORING

ALERTING

REPORTING

AUDIT

INFRASTRUCTURE

DOCKER

PLUGIN FRAMEWORK

NOTIFICATION

SECURITY

BACKUP

SCHEDULER

Each domain shall eventually become an independent backend module.

---

# Chapter 4

# Global Naming Standards

Consistency is mandatory.

Every table follows identical naming.

Examples

users

roles

permissions

smsc

routes

messages

alerts

reports

Never use

tblUsers

tbl_routes

RouteTable

UserMaster

---

## Column Naming

All columns use

snake_case

Examples

created_at

updated_at

deleted_at

customer_id

smsc_id

route_id

message_id

alert_id

deployment_id

---

## Boolean Naming

Boolean fields begin with

is_

Examples

is_enabled

is_default

is_deleted

is_archived

is_locked

is_active

is_system

is_template

Avoid ambiguous names like

enabled

deleted

locked

---

## Timestamp Naming

Every entity shall support

created_at

updated_at

Optionally

deleted_at

activated_at

disabled_at

last_seen_at

deployed_at

verified_at

processed_at

completed_at

resolved_at

expired_at

---

## UUID Strategy

Every major entity shall include

uuid

UUIDs become the preferred external identifier.

Sequential IDs remain internal.

Example

Internal

id = 2417

External

uuid =

4b22ec8a-c203-4c62-a30c-4fc52f2b281d

External APIs shall expose UUIDs wherever practical.

---

# Chapter 5

# Primary Keys

Every table uses

BIGINT

Auto Increment

Named

id

Example

users.id

messages.id

alerts.id

routes.id

smsc.id

Never use compound primary keys.

Composite uniqueness belongs in indexes.

---

# Chapter 6

# Foreign Keys

Foreign keys always reference

table_name.id

Examples

customer_id

references

customers.id

route_id

references

routes.id

smsc_id

references

smsc.id

Never reference names.

Never reference UUIDs internally.

Always reference numeric IDs.

UUIDs exist for external systems.

---

# Chapter 7

# Versioning Strategy

Versioning is fundamental.

Objects supporting version history include

Configurations

Routes

SMSC Definitions

Templates

Permissions

Alert Rules

Monitoring Rules

Notification Policies

Every version record contains

Version Number

Author

Timestamp

Reason

Checksum

Deployment Reference

Previous Version

Rollback Reference

Versions are immutable.

Updates create new versions.

---

# Chapter 8

# Soft Delete Policy

Operational history shall never disappear.

Deleting a Route shall not erase

Audit

Deployments

Reports

Historical Messages

Instead

is_deleted = true

deleted_at

deleted_by

Soft delete is mandatory for operational entities.

Hard delete is reserved for temporary objects only.

---

# Chapter 9

# Audit Integration

Every entity shall support auditing.

Audit records reference

Entity

↓

Action

↓

Old Value

↓

New Value

↓

User

↓

Timestamp

↓

Reason

↓

Correlation ID

No business entity is exempt from auditing.

---

# Chapter 10

# SYSTEM DOMAIN

The System Domain contains the global configuration and operational information that affects the entire JKANNEL platform.

This domain owns platform-wide settings and is intentionally isolated from customer, routing and messaging data.

The System Domain shall contain the following entities.

system_settings

system_information

system_parameters

system_environment

system_features

system_versions

system_licenses (Future)

system_announcements

system_preferences

system_timezones

system_languages

system_regions

system_currencies (Future)

system_theme

system_variables

No business logic shall directly modify these tables without going through the System Service.

---

## Table

system_settings

Purpose

Stores configurable platform settings.

Columns

id

uuid

setting_group

setting_name

setting_value

setting_type

description

is_encrypted

is_system

is_readonly

default_value

validation_rule

display_order

created_at

updated_at

created_by

updated_by

Indexes

setting_group

setting_name

Unique

(setting_group, setting_name)

---

## Examples

SYSTEM

PlatformName

JKANNEL

SYSTEM

DefaultTimezone

UTC

SYSTEM

DefaultLanguage

English

API

DefaultPageSize

50

API

MaximumPageSize

1000

SECURITY

JWTExpiration

3600

SECURITY

PasswordLength

14

DOCKER

ContainerRestartPolicy

unless-stopped

---

# Chapter 11

# IDENTITY DOMAIN

The Identity Domain manages authentication and authorization.

Authentication determines

Who are you?

Authorization determines

What are you allowed to do?

The Identity Domain is independent from all business modules.

Modules request authorization through this domain.

Identity Tables

users

roles

permissions

role_permissions

user_roles

groups

group_members

api_keys

sessions

login_history

password_history

mfa_devices

service_accounts

personal_access_tokens

trusted_devices

future_sso_accounts

future_ldap_accounts

---

# USERS TABLE

Purpose

Represents every human operator.

Columns

id

uuid

username

display_name

first_name

middle_name

last_name

email

phone_number

department

job_title

employee_number

status

timezone

language

avatar

notes

password_hash

password_algorithm

password_changed_at

password_expires_at

last_login_at

last_activity_at

failed_login_count

lockout_until

must_change_password

require_mfa

email_verified

phone_verified

is_enabled

is_locked

is_deleted

created_at

updated_at

deleted_at

created_by

updated_by

deleted_by

---

Indexes

username

email

phone_number

department

status

last_login_at

created_at

---

Unique

username

email

uuid

---

Relationships

One User

↓

Many Sessions

Many API Keys

Many Login Records

Many Roles

Many MFA Devices

Many Audit Records

Many Deployments

Many Reports

Many Comments

Many Alerts Assigned

---

# ROLES TABLE

Purpose

Defines security roles.

Columns

id

uuid

name

display_name

description

priority

is_system

is_default

is_enabled

created_at

updated_at

created_by

updated_by

---

Default Roles

Super Administrator

Administrator

Network Engineer

Operations Engineer

Support Engineer

Auditor

Read Only

API Client

Automation

---

# PERMISSIONS TABLE

Purpose

Defines atomic permissions.

Columns

id

uuid

permission_key

display_name

description

module

category

risk_level

is_system

created_at

updated_at

---

Examples

dashboard.view

dashboard.edit

messages.view

messages.delete

messages.export

smsc.create

smsc.edit

smsc.delete

smsc.deploy

routes.create

routes.deploy

configuration.generate

configuration.rollback

alerts.acknowledge

alerts.resolve

reports.generate

reports.schedule

docker.restart

docker.deploy

users.manage

roles.manage

permissions.manage

plugins.install

plugins.remove

backup.restore

system.shutdown

---

Permission Naming Standard

module.operation

Examples

users.create

users.edit

users.delete

routes.deploy

messages.export

Never use

canCreateUser

DeleteMessagesPermission

ManageUsersRole

---

# ROLE_PERMISSIONS TABLE

Purpose

Many-to-many relationship.

Columns

id

role_id

permission_id

granted_by

granted_at

Indexes

role_id

permission_id

Unique

(role_id, permission_id)

---

# USER_ROLES TABLE

Purpose

Assigns roles to users.

Columns

id

user_id

role_id

assigned_by

assigned_at

expires_at

Indexes

user_id

role_id

Unique

(user_id, role_id)

Users may possess multiple roles.

---

# API_KEYS TABLE

Purpose

Stores API credentials.

Columns

id

uuid

user_id

key_name

api_key_hash

prefix

last_used_at

expires_at

allowed_ips

allowed_origins

rate_limit

daily_limit

monthly_limit

is_enabled

created_at

updated_at

created_by

Indexes

user_id

prefix

last_used_at

expires_at

API keys are never stored in plaintext.

Only hashes are stored.

---

# MFA_DEVICES TABLE

Purpose

Stores MFA registrations.

Columns

id

user_id

device_name

secret

algorithm

digits

period

backup_codes

last_used_at

is_enabled

created_at

updated_at

Secrets shall always be encrypted.

---

# LOGIN_HISTORY TABLE

Purpose

Complete authentication history.

Columns

id

user_id

username

ip_address

country

city

browser

operating_system

device

login_method

mfa_used

success

failure_reason

session_id

user_agent

created_at

Indexes

user_id

created_at

success

ip_address

country

Login history is immutable.

It shall never be modified after insertion.

---

# SERVICE_ACCOUNTS TABLE

Purpose

Represents non-human identities.

Examples

Scheduler

Monitoring

CI/CD

Backup Service

Configuration Generator

Docker Manager

Columns

id

uuid

name

description

token_hash

permissions

expires_at

last_used_at

is_enabled

created_at

updated_at

Service Accounts authenticate without passwords.

Only signed tokens.

---

# Chapter 12

# CUSTOMER DOMAIN

## Purpose

The Customer Domain represents every organization, business unit, client or tenant that consumes messaging services through JKANNEL.

Although the first implementation of JKANNEL may operate in a single-tenant environment, the architecture shall be designed from the beginning to support true multi-tenancy.

The Customer Domain shall therefore remain independent of the SMS engine.

Customers own business resources.

They do not own platform resources.

Examples

Customers own

Routes

Sender IDs

API Keys

Users (Future)

Reports

Alerts

Usage Statistics

Quotas

Limits

Customers do not own

Docker

PostgreSQL

Redis

Engine

Monitoring

Platform Settings

---

# Customer Domain Entities

customers

customer_groups

customer_contacts

customer_addresses

customer_settings

customer_api_limits

customer_rate_limits

customer_statistics

customer_tags

customer_notes

customer_documents

customer_sender_ids

customer_routes

customer_smsc_permissions

customer_alert_rules

customer_report_profiles

customer_usage

customer_quota

customer_history

---

# CUSTOMERS TABLE

Purpose

Represents every organization using the platform.

Columns

id

uuid

customer_code

legal_name

display_name

short_name

registration_number

tax_number

email

phone

website

industry

country

city

address

postal_code

timezone

language

currency

status

customer_type

account_manager

default_route_id

default_sender_id

default_smsc_group

default_priority

notes

is_enabled

is_deleted

created_at

updated_at

deleted_at

created_by

updated_by

---

Indexes

customer_code

legal_name

display_name

status

country

created_at

---

Unique

customer_code

uuid

---

Relationships

One Customer

↓

Many Sender IDs

Many Routes

Many Messages

Many Reports

Many Alerts

Many API Keys

Many Quotas

Many Statistics

Many Contacts

---

# CUSTOMER_CONTACTS TABLE

Purpose

Stores operational contacts.

Examples

Technical Contact

Billing Contact

Operations Contact

Emergency Contact

Columns

id

customer_id

contact_type

full_name

email

phone

department

is_primary

notes

created_at

updated_at

---

# CUSTOMER_GROUPS TABLE

Purpose

Allows grouping customers.

Examples

Enterprise

Government

Banking

Telecommunications

Healthcare

Education

Wholesale

Retail

MVNO

ISP

One customer may belong to multiple groups.

---

# CUSTOMER_SETTINGS TABLE

Purpose

Stores customer-specific overrides.

Examples

Default Route

Default SMSC

Maximum TPS

Maximum Daily Messages

Allowed Sender IDs

Allowed Countries

Maximum API Rate

Retry Policy

Delivery Policy

Retention Policy

---

# CUSTOMER_QUOTA TABLE

Purpose

Future billing support.

Columns

Daily Message Limit

Monthly Message Limit

Current Usage

Maximum TPS

Maximum Concurrent Connections

Maximum Routes

Maximum Sender IDs

Maximum API Keys

Maximum Users

Soft Limit

Hard Limit

Reset Policy

---

# CUSTOMER_STATISTICS TABLE

Purpose

Pre-aggregated statistics.

Examples

Messages Today

Messages This Month

Success Rate

Failure Rate

DLR Success

Average TPS

Peak TPS

Most Used Route

Most Used SMSC

Average Latency

Total Retries

Storage Consumption

Statistics are regenerated continuously.

---

# CUSTOMER_HISTORY TABLE

Purpose

Immutable business history.

Examples

Customer Created

Customer Disabled

Quota Changed

Default Route Changed

Sender ID Added

Route Added

Contract Updated

Every record includes

Timestamp

User

Reason

Old Value

New Value

Correlation ID

---

# Chapter 13

# SMSC DOMAIN

The SMSC Domain is one of the most important domains within JKANNEL.

It represents every upstream or downstream messaging connection managed by the platform.

The SMSC Domain is intentionally independent of Kannel.

It represents messaging concepts rather than engine syntax.

---

# SMSC Entities

smsc

smsc_groups

smsc_templates

smsc_bind_profiles

smsc_connections

smsc_metrics

smsc_statistics

smsc_events

smsc_health

smsc_capabilities

smsc_versions

smsc_tags

smsc_labels

smsc_configuration

smsc_deployment

smsc_failover

smsc_load_balancing

smsc_logs

smsc_certificates

---

# SMSC TABLE

Purpose

Represents one logical SMSC.

Columns

id

uuid

name

display_name

description

protocol

vendor

version

host

port

system_id

system_type

bind_type

priority

weight

maximum_tps

maximum_sessions

window_size

bind_timeout

response_timeout

heartbeat_interval

reconnect_interval

retry_interval

throughput_profile

certificate_id

default_route

health_profile

monitoring_profile

configuration_template

notes

is_primary

is_enabled

is_template

is_deleted

created_at

updated_at

deleted_at

created_by

updated_by

---

Indexes

name

protocol

vendor

host

status

created_at

---

Unique

name

uuid

---

Relationships

One SMSC

↓

Many Routes

Many Connections

Many Metrics

Many Deployments

Many Health Checks

Many Statistics

Many Messages

Many DLRs

Many Logs

Many Events

---

# SMSC_GROUPS TABLE

Purpose

Groups SMSCs together.

Examples

Primary Providers

Backup Providers

International

Domestic

Promotional

Transactional

Banking

Premium

Emergency

Government

A Route may reference a Group instead of a single SMSC.

---

# SMSC_TEMPLATES TABLE

Purpose

Reusable SMSC definitions.

Example Templates

Generic SMPP

Infobip

Twilio SMPP

CM Telecom

Vonage SMPP

Africa's Talking

Local Operator

Custom REST Gateway

Creating a new SMSC from a template automatically populates recommended values.

---

# SMSC_CONNECTIONS TABLE

Purpose

Tracks live sessions.

Columns

Connection ID

SMSC

Engine

Session Number

Bind Type

Status

Connected At

Disconnected At

Disconnect Reason

Remote IP

Local IP

TLS Version

Cipher

Reconnect Count

Average Latency

Health Score

Current TPS

Messages Submitted

Messages Delivered

Messages Failed

---

Live connection data feeds

Dashboard

Monitoring

Alerts

Reporting

---

# SMSC_METRICS TABLE

Purpose

Stores time-series operational metrics.

Metrics

CPU

Memory

TPS

Latency

Window Usage

Reconnects

Failures

Queue Depth

Errors

DLR Success

Average Submit Time

Maximum Submit Time

Metrics shall be partitioned by time.

---

# SMSC_HEALTH TABLE

Purpose

Stores health snapshots.

Health States

Healthy

Warning

Critical

Offline

Unknown

Each snapshot includes

Timestamp

Status

Reason

Recommendation

Measured By

Response Time


---

# Chapter 14

# ROUTING DOMAIN

## Purpose

The Routing Domain determines how every message traverses the JKANNEL platform.

Unlike traditional Kannel configurations where routing logic exists inside configuration files, JKANNEL models routing as structured, version-controlled business objects.

Every routing decision shall be explainable.

Every routing decision shall be reproducible.

Every routing decision shall be auditable.

Every routing decision shall be simulatable before deployment.

The Routing Domain is completely engine independent.

---

# Routing Philosophy

Routing shall never be represented as plain text.

Instead

Database Objects

↓

Validation

↓

Simulation

↓

Versioning

↓

Configuration Generator

↓

Engine Adapter

↓

Generated Engine Configuration

↓

Deployment

This allows

• Rollback

• Change Tracking

• Simulation

• Impact Analysis

• Conflict Detection

• Multi-user editing

---

# Routing Domain Entities

routes

route_groups

route_rules

route_conditions

route_actions

route_priorities

route_costs

route_prefixes

route_country_rules

route_operator_rules

route_load_balancing

route_failover

route_retry_policy

route_blacklist

route_whitelist

route_schedules

route_statistics

route_versions

route_history

route_simulations

route_deployments

route_dependencies

route_tags

route_labels

---

# ROUTES TABLE

Purpose

Represents one logical routing policy.

Columns

id

uuid

route_code

name

description

customer_id

route_group_id

priority

status

default_smsc_id

default_sender_id

retry_policy_id

load_balancer_id

failover_policy_id

schedule_id

cost_profile_id

validation_profile_id

simulation_profile_id

maximum_tps

maximum_queue

maximum_retry

notes

is_default

is_enabled

is_system

is_deleted

created_at

updated_at

deleted_at

created_by

updated_by

---

Indexes

route_code

customer_id

priority

status

default_smsc_id

created_at

---

Unique

route_code

uuid

---

Relationships

One Route

↓

Many Rules

Many Conditions

Many Actions

Many Simulations

Many Deployments

Many Statistics

Many Versions

Many Messages

---

# ROUTE_GROUPS TABLE

Purpose

Organize related routes.

Examples

International

Domestic

Banking

Transactional

Marketing

Government

Emergency

Premium

USSD

Testing

Customer Specific

Group priorities determine evaluation order.

---

# ROUTE_RULES TABLE

Purpose

Represents individual routing logic.

Each Route contains one or more ordered rules.

Columns

id

route_id

sequence

rule_name

description

condition_logic

action_logic

priority

continue_processing

stop_processing

enabled

created_at

updated_at

Rules are always evaluated in sequence.

---

# ROUTE_CONDITIONS TABLE

Purpose

Stores reusable routing conditions.

Supported Condition Types

Sender

Recipient

Country

Operator

Network

Message Class

Message Length

Customer

Account

Time

Day

Date

Priority

Encoding

Alphabet

Protocol

SMSC Status

Queue Depth

Current TPS

Cost

Availability

Health Score

Custom Expression

---

Example

Recipient starts with 256

Customer = Bank A

Current TPS < 500

Current Time between 08:00 and 20:00

SMSC Health = Healthy

Route to Primary Banking SMSC

---

# ROUTE_ACTIONS TABLE

Purpose

Defines actions performed after conditions evaluate successfully.

Supported Actions

Route to SMSC

Route to SMSC Group

Retry

Drop

Reject

Queue

Delay

Log

Generate Alert

Change Sender ID

Modify Priority

Apply Throttling

Apply Cost Rule

Apply Retry Policy

Invoke Plugin

Invoke Webhook

Execute Script (Future)

Actions are reusable objects.

---

# ROUTE_PRIORITIES TABLE

Purpose

Defines evaluation priority.

Priority Levels

Critical

High

Normal

Low

Background

Priorities affect evaluation order only.

They do not affect message priority.

---

# ROUTE_PREFIXES TABLE

Purpose

Stores routing prefixes.

Columns

Country

Country Code

Operator

Prefix

Description

Priority

Route

SMSC

Cost

Status

Examples

25670

MTN Uganda

25675

Airtel Uganda

25471

Safaricom

25574

Vodacom Tanzania

23480

EE UK

Prefix matching shall use longest-prefix matching.

---

# ROUTE_COUNTRY_RULES TABLE

Purpose

Country-specific routing.

Examples

Uganda

↓

Primary Local SMSC

Kenya

↓

Kenya SMSC Cluster

Nigeria

↓

West Africa Provider

International

↓

Global Provider

---

# ROUTE_OPERATOR_RULES TABLE

Purpose

Operator-specific routing.

Examples

Safaricom

↓

Route A

MTN

↓

Route B

Vodacom

↓

Route C

Orange

↓

Route D

Operator routing overrides country routing.

---

# ROUTE_COSTS TABLE

Purpose

Supports least-cost routing.

Columns

Route

Country

Operator

Cost Per SMS

Currency

Effective Date

Expiry Date

Priority

Preferred

Cost Source

Last Updated

The routing engine may choose the lowest-cost route when multiple routes are valid.

---

# ROUTE_LOAD_BALANCING TABLE

Purpose

Defines traffic distribution.

Algorithms

Round Robin

Weighted Round Robin

Least Connections

Least Cost

Least Latency

Weighted Priority

Percentage Split

Health-Based

Custom Plugin

Example

Provider A

60%

Provider B

30%

Provider C

10%

Traffic allocation is continuously monitored.

---

# ROUTE_FAILOVER TABLE

Purpose

Defines failover strategy.

Policies

Immediate

Progressive

Health Based

Manual

Timed Retry

Priority Escalation

Automatic Recovery

Failback

Example

Primary

↓

Backup 1

↓

Backup 2

↓

Emergency Route

Every failover event is audited.

---

# ROUTE_RETRY_POLICY TABLE

Purpose

Defines retry behaviour.

Columns

Maximum Attempts

Retry Interval

Backoff Algorithm

Maximum Age

Retry Conditions

Dead Letter Queue

Notification Policy

Retry algorithms

Constant

Linear

Exponential

Custom Plugin

---

# ROUTE_BLACKLIST TABLE

Purpose

Numbers that must never receive messages.

Blacklist Types

Recipient

Country

Operator

Customer

Sender ID

Pattern

Temporary

Permanent

---

# ROUTE_WHITELIST TABLE

Purpose

Overrides blacklist restrictions.

Examples

Emergency Numbers

Banking Systems

Government

VIP Customers

Testing Numbers

Whitelist always has precedence.

---

# ROUTE_SCHEDULES TABLE

Purpose

Time-based routing.

Examples

Business Hours

Weekend

Holiday

Night Mode

Maintenance Window

Disaster Recovery

Schedules may activate or deactivate routes automatically.

---

# ROUTE_DEPENDENCIES TABLE

Purpose

Defines relationships between routes.

Examples

Route A requires

↓

Primary SMSC

↓

TLS Certificate

↓

Health Profile

↓

Customer Enabled

↓

Schedule Active

Deployment validation checks every dependency before activation.

---

# Chapter 15

# MESSAGING DOMAIN

## Purpose

The Messaging Domain is the operational heart of JKANNEL.

Every SMS, whether Mobile Originated (MO), Mobile Terminated (MT), Delivery Report (DLR), Flash SMS, Binary SMS or future messaging format, is represented here.

This domain powers nearly every subsystem within JKANNEL.

Dashboard

Reporting

Customer Management

Routing

SMSC Analytics

Alerts

Monitoring

Billing

Auditing

Troubleshooting

Compliance

Every message shall remain fully traceable throughout its lifecycle.

Nothing about a message shall be hidden from the platform.

---

# Messaging Design Principles

The Messaging subsystem shall satisfy the following engineering principles.

Every message receives a globally unique identifier.

Every state transition is recorded.

Every routing decision is recorded.

Every retry is recorded.

Every queue movement is recorded.

Every DLR is recorded.

Every error is recorded.

Every modification is audited.

Messages are immutable except for lifecycle state transitions.

---

# Messaging Domain Entities

messages

message_parts

message_status_history

message_events

message_routing_trace

message_smsc_trace

message_queue_history

message_retry

message_errors

message_metadata

message_notes

message_labels

message_tags

message_exports

message_replay

message_cost

message_archive

message_lock

message_statistics

message_audit

---

# Message Lifecycle

A complete message lifecycle consists of the following states.

Received

↓

Authenticated

↓

Validated

↓

Customer Identified

↓

Sender Validated

↓

Route Selected

↓

SMSC Selected

↓

Queued

↓

Submitted

↓

Accepted

↓

Awaiting Delivery Report

↓

Delivered

or

Failed

or

Expired

or

Cancelled

↓

Archived

Every transition is recorded permanently.

---

# Message Status Values

accepted

authenticated

validated

queued

scheduled

submitted

sent

delivered

failed

rejected

expired

cancelled

retrying

dead_letter

unknown

archived

---

# MESSAGES TABLE

Purpose

Stores one logical SMS.

Columns

id

uuid

external_reference

correlation_id

request_id

customer_id

user_id

api_key_id

route_id

smsc_id

sender_id

source_address

destination_address

destination_country

destination_operator

message_direction

message_type

encoding

alphabet

data_coding

priority

status

message_text

message_length

segment_count

scheduled_at

submitted_at

accepted_at

queued_at

sent_at

delivered_at

failed_at

expired_at

completed_at

last_status_at

retry_count

maximum_retry_count

vendor_message_id

engine_message_id

operator_message_id

cost_amount

currency

billing_status

dlr_requested

dlr_received

dlr_status

notes

metadata

is_test

is_replayed

is_deleted

created_at

updated_at

deleted_at

created_by

updated_by

deleted_by

---

Indexes

uuid

external_reference

customer_id

route_id

smsc_id

status

submitted_at

destination_address

source_address

vendor_message_id

engine_message_id

correlation_id

---

Relationships

One Message

↓

Many Parts

Many Events

Many Retries

Many Queue Movements

Many Errors

Many DLR Events

Many Notes

Many Metadata Records

---

# MESSAGE_PARTS TABLE

Purpose

Stores multipart SMS.

Columns

id

message_id

part_number

total_parts

udh_reference

udh_header

payload

encoding

part_length

status

submitted_at

accepted_at

delivered_at

created_at

updated_at

One message

↓

Many parts

---

# MESSAGE_STATUS_HISTORY TABLE

Purpose

Stores every state transition.

Columns

id

message_id

previous_status

new_status

change_reason

source

changed_by

changed_at

correlation_id

This table reconstructs the complete lifecycle of every message.

---

# MESSAGE_EVENTS TABLE

Purpose

Stores operational events.

Examples

Message Accepted

Route Evaluated

Route Selected

SMSC Selected

Queued

Dequeued

Retry Scheduled

Retry Executed

Submitted

Accepted

Rejected

DLR Received

Expired

Archived

Columns

id

message_id

event_name

event_source

event_payload

severity

occurred_at

created_at

Events are immutable.

---

# MESSAGE_ROUTING_TRACE TABLE

Purpose

Explains WHY a route was selected.

Columns

id

message_id

route_id

rule_id

condition_result

action_result

priority

cost_score

latency_score

health_score

selected_smsc_id

selected_group_id

evaluation_time_ms

matched

rejected_reason

created_at

This table powers the Route Simulator.

---

# MESSAGE_SMSC_TRACE TABLE

Purpose

Records interaction with upstream providers.

Columns

id

message_id

smsc_id

connection_id

bind_type

submit_attempt

submit_time

response_time

response_code

response_message

window_size

window_used

latency_ms

sequence_number

accepted

created_at

Supports troubleshooting.

---

# MESSAGE_QUEUE_HISTORY TABLE

Purpose

Records queue movement.

Columns

id

message_id

previous_queue

current_queue

queue_position

entered_queue_at

left_queue_at

processing_time_ms

worker_name

reason

created_at

Queues include

Incoming

Outgoing

Retry

Scheduled

Priority

DLR

Dead Letter

Archive

---

# MESSAGE_RETRY TABLE

Purpose

Stores retry attempts.

Columns

id

message_id

attempt_number

route_id

smsc_id

retry_reason

retry_algorithm

scheduled_at

started_at

completed_at

result

error_code

error_message

next_retry_at

created_at

Retry history is immutable.

---

# MESSAGE_ERRORS TABLE

Purpose

Stores normalized failures.

Columns

id

message_id

error_source

error_category

error_code

vendor_error

engine_error

severity

description

recommendation

raw_response

occurred_at

created_at

Every failure shall be classified.

---

# MESSAGE_METADATA TABLE

Purpose

Stores extensible metadata.

Examples

HTTP Headers

Webhook Data

Plugin Information

Billing Metadata

Campaign IDs

Correlation Information

Columns

id

message_id

metadata_key

metadata_value

metadata_type

is_sensitive

created_at

Sensitive values are encrypted.

---

# MESSAGE_NOTES TABLE

Purpose

Stores operator notes.

Columns

id

message_id

user_id

note

is_internal

created_at

updated_at

Every note is audited.

---

# MESSAGE_EXPORTS TABLE

Purpose

Tracks message exports.

Columns

id

message_id

export_job_id

user_id

export_format

export_reason

exported_at

Every export is auditable.

---

# MESSAGE_REPLAY TABLE

Purpose

Stores replay history.

Columns

id

original_message_id

new_message_id

replayed_by

replay_type

reason

created_at

Replay Types

Retry

Clone

Resubmit

DLR Replay

Investigation

---

# MESSAGE_COST TABLE

Purpose

Future billing support.

Columns

id

message_id

customer_id

vendor_id

route_id

smsc_id

buy_price

sell_price

currency

margin

billing_rule

created_at

---

# MESSAGE_ARCHIVE TABLE

Purpose

Stores archive metadata.

Columns

id

message_id

archive_location

archive_checksum

archive_date

retention_until

restored_at

created_at

Archive storage may exist outside PostgreSQL.

---

# MESSAGE_LOCK TABLE

Purpose

Prevents duplicate processing.

Columns

id

message_id

lock_owner

lock_key

locked_at

expires_at

released_at

Processing workers respect active locks.

---

# MESSAGE_STATISTICS TABLE

Purpose

Stores aggregated statistics.

Examples

Messages Per Hour

Messages Per Customer

Messages Per SMSC

Delivery Rate

Retry Rate

Failure Rate

Queue Time

Average TPS

Peak TPS

Statistics are regenerated automatically.

---

# Message Partitioning

High-volume deployments shall partition

messages

message_events

message_status_history

message_queue_history

Recommended

Monthly

Future

Daily

---

# Retention Policy

Messages

180 Days

Message Events

365 Days

Routing Trace

365 Days

Retry History

365 Days

Message Statistics

Permanent

Retention is configurable.

---

# Search Requirements

The Message Explorer shall support searching by

UUID

Message ID

Customer

Recipient

Sender

Route

SMSC

Vendor Message ID

Operator Message ID

Correlation ID

Request ID

Status

Date Range

Country

Operator

Campaign

API Key

Message Text

Error Code

DLR Status

---

# Privacy Controls

The platform shall support

Message Body Encryption

Partial Message Masking

Role-Based Visibility

Export Restrictions

Automatic Redaction

Regional Data Protection Policies

---

# Acceptance Criteria

The Messaging Domain is complete when

- Every message is uniquely identifiable.
- Every lifecycle transition is recorded.
- Every routing decision is traceable.
- Every SMSC interaction is recorded.
- Queue movement is visible.
- Retry history is complete.
- Delivery reports are traceable.
- Search performs within target limits.
- Retention policies operate automatically.
- Privacy controls are enforced.




---

# Chapter 16

# DELIVERY REPORT (DLR) DOMAIN

## Purpose

The Delivery Report (DLR) Domain is responsible for recording, tracking and exposing the complete lifecycle of delivery acknowledgements received from SMSCs.

Unlike traditional SMS gateways where DLRs are simply logged, JKANNEL models DLRs as first-class business entities.

Every delivery report shall be permanently linked to its originating message.

Every DLR shall be searchable.

Every DLR shall be auditable.

Every DLR shall support historical analysis.

---

# DLR Design Principles

One Message

↓

Many DLR Events

↓

One Final Delivery State

The original message shall never be modified directly by an incoming DLR.

Instead

DLR Received

↓

DLR Stored

↓

Validation

↓

Message Status Updated

↓

Audit

↓

Statistics Updated

↓

Alerts Generated (if required)

---

# DLR Domain Entities

delivery_reports

delivery_report_events

delivery_report_status

delivery_report_raw

delivery_report_errors

delivery_report_retry

delivery_report_callbacks

delivery_report_statistics

delivery_report_history

---

# DELIVERY_REPORTS TABLE

Purpose

Stores the normalized DLR.

Columns

id

uuid

message_id

customer_id

smsc_id

route_id

vendor_message_id

operator_message_id

dlr_reference

delivery_status

delivery_code

delivery_description

delivery_timestamp

received_timestamp

latency_ms

network

operator

country

billing_status

created_at

updated_at

Indexes

message_id

vendor_message_id

delivery_status

received_timestamp

country

operator

---

Relationships

One Message

↓

Many Delivery Reports

---

# DELIVERY_REPORT_EVENTS TABLE

Purpose

Stores every DLR event.

Examples

DLR Received

DLR Parsed

DLR Validated

DLR Matched

DLR Applied

DLR Callback Sent

DLR Archived

Columns

id

delivery_report_id

event_name

event_payload

event_source

occurred_at

created_at

Events are immutable.

---

# DELIVERY_REPORT_RAW TABLE

Purpose

Stores the raw payload exactly as received.

Columns

id

delivery_report_id

protocol

raw_payload

headers

remote_ip

received_at

Purpose

For forensic investigations.

The raw payload shall never be modified.

---

# DELIVERY_REPORT_ERRORS TABLE

Purpose

Stores parsing and processing failures.

Columns

id

delivery_report_id

error_code

description

raw_payload

severity

recommendation

occurred_at

created_at

---

# DELIVERY_REPORT_CALLBACKS TABLE

Purpose

Tracks webhook callbacks triggered by DLRs.

Columns

id

delivery_report_id

customer_id

callback_url

http_method

http_status

retry_count

response_body

latency_ms

created_at

---

# DELIVERY_REPORT_STATISTICS TABLE

Purpose

Aggregated statistics.

Examples

Delivery Success

Delivery Failure

Average Delivery Time

DLR Latency

Callback Success

Callback Failure

---

# Chapter 17

# QUEUE DOMAIN

## Purpose

Queues regulate message flow throughout JKANNEL.

Queues are represented as business entities rather than engine implementation details.

The Queue Domain allows complete operational visibility.

---

# Queue Types

Incoming Queue

Outgoing Queue

Scheduled Queue

Retry Queue

Priority Queue

DLR Queue

Archive Queue

Dead Letter Queue

Plugin Queue

Notification Queue

Report Queue

Configuration Queue

Deployment Queue

---

# Queue Design

Producer

↓

Queue

↓

Worker

↓

Result

↓

Audit

↓

Metrics

↓

Dashboard

Queue state shall always be visible.

---

# Queue Domain Entities

queues

queue_messages

queue_history

queue_workers

queue_statistics

queue_limits

queue_policies

queue_events

queue_alerts

---

# QUEUES TABLE

Purpose

Represents a logical queue.

Columns

id

uuid

queue_name

description

queue_type

priority

maximum_size

current_size

maximum_workers

worker_timeout

retry_policy_id

retention_policy

is_enabled

created_at

updated_at

---

Queue Types

FIFO

Priority

Delayed

Scheduled

Retry

Dead Letter

Plugin

---

# QUEUE_MESSAGES TABLE

Purpose

Represents message membership.

Columns

id

queue_id

message_id

position

priority

entered_at

processing_started_at

completed_at

worker_id

status

Indexes

queue_id

message_id

status

position

---

# QUEUE_WORKERS TABLE

Purpose

Worker processes.

Columns

id

worker_name

host

container

queue_id

status

started_at

last_heartbeat

messages_processed

average_processing_time

current_message_id

---

# QUEUE_HISTORY TABLE

Purpose

Records queue movement.

Columns

id

message_id

previous_queue

new_queue

worker_id

reason

duration_ms

created_at

Every movement is permanently recorded.

---

# QUEUE_STATISTICS TABLE

Purpose

Stores queue metrics.

Metrics

Current Depth

Average Wait Time

Longest Wait

Messages Processed

Worker Utilization

Retry Rate

Failure Rate

Throughput

Statistics update continuously.

---

# Chapter 18

# MONITORING DOMAIN

## Purpose

Monitoring provides operational visibility into every component of JKANNEL.

Every measurable object shall expose metrics.

Monitoring is independent of Dashboard.

Dashboard consumes Monitoring.

---

# Monitoring Categories

Platform

Application

Engine

Database

Redis

Docker

API

Queues

SMSC

Routes

Messages

Security

Plugins

Infrastructure

---

# Monitoring Entities

system_metrics

api_metrics

database_metrics

docker_metrics

redis_metrics

smsc_metrics

queue_metrics

route_metrics

application_metrics

plugin_metrics

host_metrics

network_metrics

certificate_metrics

---

# SYSTEM_METRICS TABLE

Purpose

Stores global platform metrics.

Columns

id

metric_name

metric_value

metric_unit

metric_category

host

container

recorded_at

Examples

CPU

Memory

Disk

Network

Load

Uptime

Temperature

Open Files

Threads

Processes

---

# API_METRICS TABLE

Purpose

Measures REST performance.

Columns

id

endpoint

method

response_time

status_code

request_size

response_size

authenticated

user_id

recorded_at

Metrics

Average Response Time

P95

P99

Error Rate

Requests Per Second

---

# DATABASE_METRICS TABLE

Purpose

Measures PostgreSQL.

Metrics

Connections

Transactions

Locks

Slow Queries

Replication Lag

Deadlocks

Cache Hit Ratio

Index Usage

Storage Growth

---

# DOCKER_METRICS TABLE

Purpose

Measures Docker.

Metrics

Container Health

Restart Count

Memory

CPU

Disk

Image Version

Network IO

Container Status

---

# REDIS_METRICS TABLE

Purpose

Measures Redis.

Metrics

Memory

Connected Clients

Commands

Cache Hit Ratio

Replication

Persistence

Evictions

Latency

---

# Monitoring Retention

Raw Metrics

90 Days

Hourly Aggregates

1 Year

Daily Aggregates

Permanent

Monthly Aggregates

Permanent

---

# Acceptance Criteria

The Delivery Report, Queue and Monitoring Domains are complete when

- Every DLR is permanently linked to its originating message.
- Raw DLR payloads are preserved.
- Queue movement is fully traceable.
- Queue workers expose health and utilization.
- Platform metrics are continuously collected.
- API performance is measurable.
- Database health is measurable.
- Docker health is measurable.
- Redis health is measurable.
- Monitoring data supports dashboards, alerts and reporting.

---

# Chapter 19

# ALERTING DOMAIN

## Purpose

The Alerting Domain provides real-time operational awareness.

Every subsystem within JKANNEL shall be capable of generating alerts.

Alerts shall be intelligent, actionable and fully traceable.

The platform shall not simply report failures.

It shall explain

What happened

Why it happened

What is affected

What should be done

Who has been notified

Whether the issue has been resolved

Alerts are business objects.

They are not log messages.

---

# Alert Philosophy

Event

↓

Evaluation

↓

Alert Rule

↓

Alert Created

↓

Notification

↓

Escalation

↓

Acknowledgement

↓

Resolution

↓

Closure

↓

Archive

Every stage is recorded.

---

# Alert Categories

Infrastructure

Platform

Database

Redis

Docker

API

Authentication

Authorization

Security

Configuration

Deployment

Queue

Message

Delivery Report

SMSC

Route

Customer

Plugin

Backup

Disaster Recovery

Scheduler

Reporting

License (Future)

AI (Future)

---

# Alert Severity

Information

Notice

Warning

Minor

Major

Critical

Emergency

Severity determines

Escalation

Notification

Dashboard Visibility

Response Time

---

# Alert Domain Entities

alerts

alert_rules

alert_conditions

alert_events

alert_history

alert_assignments

alert_notifications

alert_acknowledgements

alert_escalations

alert_comments

alert_suppressions

alert_statistics

alert_categories

alert_tags

alert_labels

---

# ALERTS TABLE

Purpose

Represents one active alert.

Columns

id

uuid

alert_code

title

description

category

severity

status

source

source_type

source_id

customer_id

route_id

smsc_id

message_id

rule_id

assigned_user_id

acknowledged_by

resolved_by

closed_by

opened_at

acknowledged_at

resolved_at

closed_at

last_updated_at

occurrence_count

impact_score

priority

recommended_action

runbook_reference

correlation_id

created_at

updated_at

Indexes

status

severity

category

source

customer_id

smsc_id

opened_at

assigned_user_id

---

# ALERT_RULES TABLE

Purpose

Defines when alerts are created.

Examples

SMSC Offline

Queue > 5000

CPU > 90%

Redis Unavailable

Database Replication Failure

Certificate Expiring

Configuration Validation Failed

Worker Stopped

Disk Full

API Response > 2 Seconds

---

Columns

id

name

description

module

condition

threshold

evaluation_period

cooldown

notification_policy

escalation_policy

enabled

created_at

updated_at

---

# ALERT_EVENTS TABLE

Purpose

Stores lifecycle events.

Examples

Alert Created

Alert Escalated

Alert Assigned

Alert Acknowledged

Alert Reopened

Alert Resolved

Alert Closed

Notification Sent

Notification Failed

---

# ALERT_ASSIGNMENTS TABLE

Purpose

Tracks ownership.

Columns

id

alert_id

assigned_to

assigned_by

assigned_at

accepted_at

released_at

assignment_reason

---

# ALERT_ESCALATIONS TABLE

Purpose

Tracks escalation history.

Escalation Levels

Level 1

Level 2

Level 3

Management

Emergency

Columns

id

alert_id

level

trigger_time

executed_time

recipient

method

result

---

# ALERT_NOTIFICATIONS TABLE

Purpose

Tracks notification delivery.

Channels

Email

SMS

Telegram

Slack

Microsoft Teams

Discord

Webhook

Mobile Push

Future Voice

Columns

id

alert_id

channel

recipient

delivery_status

delivery_time

retry_count

response

created_at

---

# ALERT_COMMENTS TABLE

Purpose

Stores engineer comments.

Columns

id

alert_id

user_id

comment

visibility

created_at

updated_at

Comments are immutable after 15 minutes.

---

# ALERT_SUPPRESSIONS TABLE

Purpose

Suppress recurring alerts.

Examples

Maintenance Window

Known Issue

Planned Outage

Scheduled Upgrade

---

# ALERT_STATISTICS TABLE

Purpose

Stores aggregated data.

Metrics

Alerts Today

Mean Time To Detect

Mean Time To Acknowledge

Mean Time To Resolve

Escalation Rate

False Positive Rate

Alerts Per Module

Alerts Per Customer

Alerts Per SMSC

---

# Chapter 20

# REPORTING DOMAIN

## Purpose

The Reporting Domain transforms operational data into business intelligence.

Reports shall never execute heavy production queries directly.

Aggregated reporting tables shall be preferred where practical.

---

# Report Categories

Operational

Executive

Customer

Vendor

Financial (Future)

Traffic

Performance

Security

Compliance

Audit

Infrastructure

Capacity Planning

---

# Reporting Domain Entities

reports

report_templates

report_jobs

report_parameters

report_exports

report_schedules

report_history

report_statistics

report_recipients

report_delivery

---

# REPORTS TABLE

Purpose

Represents generated reports.

Columns

id

uuid

template_id

report_name

report_type

customer_id

generated_by

generation_status

generation_time

file_size

storage_location

checksum

expires_at

created_at

---

# REPORT_TEMPLATES TABLE

Purpose

Reusable report definitions.

Examples

Daily Traffic

Customer Usage

Top Routes

Top SMSCs

Queue Summary

Delivery Success

Platform Health

Security Events

Configuration Changes

---

# REPORT_JOBS TABLE

Purpose

Background generation.

Status

Pending

Running

Completed

Failed

Cancelled

Queued

Retrying

---

# REPORT_EXPORTS TABLE

Purpose

Tracks exports.

Formats

PDF

CSV

Excel

JSON

HTML

XML

Parquet (Future)

---

# REPORT_SCHEDULES TABLE

Purpose

Automated reports.

Frequency

Hourly

Daily

Weekly

Monthly

Quarterly

Yearly

Cron

Schedules generate jobs automatically.

---

# REPORT_STATISTICS TABLE

Purpose

Measures reporting subsystem.

Metrics

Average Runtime

Success Rate

Failure Rate

Export Count

Scheduled Reports

Storage Usage

---

# Chapter 21

# AUDIT DOMAIN

## Purpose

The Audit Domain provides immutable forensic history.

Every administrative action performed anywhere in JKANNEL shall generate an audit record.

Audit records shall never be modified.

Audit records shall never be deleted.

---

# Audit Principles

Immutable

Append Only

Tamper Evident

Time Ordered

Searchable

Exportable

Legally Defensible

---

# Audit Domain Entities

audit_log

audit_sessions

audit_categories

audit_actions

audit_entities

audit_exports

audit_reviews

audit_retention

audit_signatures

---

# AUDIT_LOG TABLE

Purpose

Master audit trail.

Columns

id

uuid

timestamp

user_id

service_account_id

session_id

ip_address

hostname

browser

operating_system

action

category

entity_type

entity_id

entity_name

old_value

new_value

reason

result

severity

correlation_id

request_id

execution_time_ms

created_at

---

Indexes

timestamp

user_id

action

entity_type

entity_id

correlation_id

request_id

severity

---

# AUDIT_SESSIONS TABLE

Purpose

Tracks user sessions.

Columns

id

user_id

login_time

logout_time

ip_address

browser

device

mfa_used

session_duration

termination_reason

---

# AUDIT_EXPORTS TABLE

Purpose

Tracks export operations.

Every audit export is itself audited.

---

# AUDIT_SIGNATURES TABLE

Purpose

Future tamper detection.

Stores

Digital Signature

Hash

Verification Date

Verification Status

Future blockchain anchoring may be supported.

---

# Acceptance Criteria

The Alerting, Reporting and Audit Domains are complete when

- Every subsystem can generate alerts.
- Alert escalation functions automatically.
- Notifications support multiple channels.
- Reports are generated asynchronously.
- Scheduled reports function correctly.
- Report exports are fully tracked.
- Every administrative action generates an immutable audit record.
- Audit searches perform within target limits.
- Audit exports are traceable.
- The platform provides complete forensic visibility.


---

# Chapter 32

# ENTERPRISE DATABASE ENGINEERING STANDARDS

## Purpose

This chapter defines the engineering standards that govern every database object within JKANNEL.

These standards are mandatory.

No engineer, AI coding agent or plugin developer may deviate from these standards without an approved Architecture Decision Record (ADR).

These standards ensure

Consistency

Performance

Scalability

Security

Maintainability

Operational Simplicity

Future Expansion

Every table, index, migration and query shall comply.

---

# Chapter 33

# DATABASE ENGINE PHILOSOPHY

JKANNEL shall use PostgreSQL as its primary relational database.

PostgreSQL was selected because it provides

Enterprise Stability

Excellent Query Planner

MVCC

Native JSON Support

Window Functions

Partitioning

Recursive Queries

Generated Columns

Materialized Views

Excellent Docker Support

Logical Replication

Streaming Replication

Point-In-Time Recovery

Future clustering shall continue using PostgreSQL.

Database portability is not a design goal.

---

# Chapter 34

# PRIMARY KEY STANDARD

Every major table shall contain

id BIGINT

Primary Key

Auto Increment Identity

uuid UUID

Globally Unique

The numeric ID shall be used internally.

The UUID shall be exposed externally.

Example

Internal

id = 87234

External

uuid =

550e8400-e29b-41d4-a716-446655440000

Business logic shall never depend upon sequential IDs.

---

# Chapter 35

# FOREIGN KEY STANDARD

All foreign keys shall

Reference numeric IDs

Be indexed

Use explicit constraints

Be named consistently

Examples

customer_id

route_id

smsc_id

message_id

alert_id

report_id

deployment_id

Foreign key naming

fk_messages_customer

fk_messages_route

fk_messages_smsc

Never use anonymous foreign key names.

---

# Chapter 36

# INDEXING STRATEGY

Indexes are mandatory.

Every table shall define indexes before implementation.

Types

Primary

Unique

Foreign Key

Composite

Partial

GIN

GiST

BRIN

Hash (Rare)

Expression

Indexes shall support expected query patterns.

Not theoretical patterns.

---

# Standard Indexes

Every table indexes

Primary Key

UUID

Creation Date

Foreign Keys

Frequently Filtered Columns

Frequently Sorted Columns

Status

Enabled Flag

Never index every column.

Indexes have maintenance costs.

---

# Composite Index Standards

Composite indexes shall match application queries.

Examples

(customer_id, status)

(route_id, created_at)

(smsc_id, submitted_at)

(status, created_at)

(destination_address, submitted_at)

(created_at, status)

Index order shall match query order.

---

# Partial Indexes

Partial indexes shall be used where practical.

Example

WHERE status='active'

WHERE is_deleted=false

WHERE is_enabled=true

Partial indexes reduce storage.

---

# Full Text Search

The following entities shall support Full Text Search.

Messages

Notes

Reports

Alerts

Audit

Logs

Plugins

GIN indexes shall be preferred.

---

# Chapter 37

# PARTITIONING STRATEGY

High-volume tables shall support partitioning.

Mandatory Candidates

messages

message_events

audit_log

system_metrics

api_metrics

queue_history

delivery_reports

Partition Strategy

Monthly

Default

Daily

High Throughput

Yearly

Archive

Partition creation shall be automated.

---

# Partition Naming

messages_2026_01

messages_2026_02

messages_2026_03

audit_2026_01

metrics_2026_01

No manually created partitions.

---

# Chapter 38

# TIME SERIES DESIGN

Metrics are time-series data.

Metrics shall never overwrite previous values.

Each sample represents a point in time.

Timestamp

↓

Metric

↓

Value

↓

Labels

↓

Source

↓

Host

↓

Container

Examples

CPU

Memory

TPS

Latency

Connections

Queue Depth

Storage

Time-series tables shall be append-only.

---

# Chapter 39

# DATA RETENTION POLICY

Every table shall define retention.

Example

Messages

180 Days

Queue History

180 Days

Metrics

365 Days

Alerts

3 Years

Reports

Permanent

Audit

Permanent

Retention shall be configurable.

---

# Retention Engine

Expired Data

↓

Archive

↓

Verification

↓

Compression

↓

Deletion

↓

Audit

Deletion without audit is prohibited.

---

# Chapter 40

# ARCHIVING STRATEGY

Historical data shall move to archive storage.

Archive methods

Compressed PostgreSQL

External Database

Object Storage

Cold Storage

Future Glacier

Archives remain searchable.

Archive metadata remains online.

---

# Chapter 41

# SOFT DELETE STANDARD

Operational entities

Soft Delete

Temporary entities

Hard Delete

Soft Delete Columns

is_deleted

deleted_at

deleted_by

Soft deleted objects remain visible in audit history.

---

# Chapter 42

# HARD DELETE POLICY

Hard delete permitted only for

Temporary Cache

Expired Tokens

Scheduler Locks

Temporary Imports

Failed Upload Chunks

Worker Sessions

Everything else

Soft Delete.

---

# Chapter 43

# VERSIONING STANDARD

The following entities are version-controlled

Routes

SMSC

Configuration

Templates

Alert Rules

Monitoring Profiles

Notification Profiles

Plugin Configuration

Each version contains

Version Number

Previous Version

Checksum

Author

Timestamp

Reason

Deployment Reference

Rollback Reference

Versions are immutable.

---

# Chapter 44

# MIGRATION STANDARDS

Every schema modification requires

Migration Script

Rollback Script

Verification Script

Migration Documentation

Performance Review

No manual database modification.

Every migration must be repeatable.

---

# Migration Naming

YYYYMMDD_HHMM_description

Example

20260706_1500_create_messages

20260706_1515_add_route_indexes

20260707_0900_create_alert_tables

Migration history shall never be edited.

---

# Chapter 45

# CONSTRAINT STANDARDS

Use constraints aggressively.

Primary Key

Unique

Foreign Key

Check

Not Null

Default

Examples

Retry Count >= 0

Priority Between 1 and 100

TPS > 0

Window Size > 0

Constraints protect business integrity.

---

# Acceptance Criteria

Database Engineering Standards are complete when

- Every table follows naming standards.
- Every FK is indexed.
- Partitioning strategy is implemented.
- Time-series data is append-only.
- Retention policies are defined.
- Archive strategy is implemented.
- Versioning is standardized.
- Migrations are repeatable.
- Constraints enforce business rules.
- Engineering standards are applied consistently.

---

# Chapter 46

# ORM ENGINEERING STANDARDS

## Purpose

JKANNEL shall use an Object Relational Mapper (ORM) to map business entities to PostgreSQL.

The ORM exists to improve maintainability.

It does not replace database engineering.

The database schema remains the authoritative design.

ORM models must accurately represent the schema.

The ORM shall never become the source of truth.

---

# ORM Philosophy

Database

↓

Migration

↓

Entity

↓

Repository

↓

Service

↓

API

Business rules shall never exist inside ORM models.

ORM models represent data.

Services represent behaviour.

---

# Entity Standards

Every entity shall contain

Primary Key

UUID

Relationships

Timestamps

Soft Delete (where applicable)

Version Number (where applicable)

Audit Support

Every entity shall expose

Validation

Computed Properties

Relationship Navigation

Serialization Rules

Hidden Fields

Mass Assignment Rules

---

# Relationship Standards

Supported Relationships

One to One

One to Many

Many to One

Many to Many

Self Referencing

Hierarchical

Polymorphic (Future)

Recursive

Recursive relationships shall be explicitly documented.

---

# Lazy Loading

Lazy loading shall be disabled by default.

Developers shall explicitly request related entities.

Reason

Prevent N+1 Queries

Improve Predictability

Improve Performance

---

# Eager Loading

Use eager loading only when

Related objects are guaranteed to be required.

Examples

Message

↓

Customer

↓

Route

↓

SMSC

↓

Delivery Status

Avoid loading unnecessary relationships.

---

# Hidden Fields

Sensitive fields shall never be serialized.

Examples

password_hash

api_key_hash

jwt_secret

private_key

certificate_private_key

backup_encryption_key

internal_notes

These fields require explicit access.

---

# Chapter 47

# REPOSITORY STANDARD

Repositories isolate persistence.

Business logic never communicates directly with PostgreSQL.

Instead

Business Service

↓

Repository

↓

Database

Each major entity owns one repository.

---

# Repository Responsibilities

Retrieve

Create

Update

Delete

Search

Pagination

Filtering

Sorting

Aggregation

Transactions

Repositories shall not contain business rules.

---

# Standard Repository Methods

find()

findByUuid()

findById()

findMany()

create()

update()

delete()

restore()

search()

exists()

count()

paginate()

lock()

Repositories expose business-friendly methods.

Not SQL.

---

# Search Strategy

Every repository supports

Pagination

Sorting

Filtering

Keyword Search

Date Range

Status Filters

Relationship Filters

Saved Queries

Repositories return domain models.

Not raw records.

---

# Chapter 48

# QUERY ENGINEERING STANDARDS

Every production query shall be reviewed.

Requirements

Indexed

Parameterized

Documented

Measured

Cached where appropriate

Audited if sensitive

Never use

SELECT *

Always request required columns.

---

# Query Classification

Simple

Medium

Complex

Analytical

Reporting

Batch

Streaming

Each class has different optimization strategies.

---

# Query Performance

Target

Simple

<20ms

Medium

<100ms

Complex

<500ms

Reports

Background

Slow queries shall automatically generate monitoring events.

---

# Chapter 49

# TRANSACTION MANAGEMENT

Transactions guarantee consistency.

Operations requiring transactions

Configuration Deployment

Rollback

User Creation

Role Assignment

Message Submission

Route Deployment

Backup Registration

Restore

Plugin Installation

Every transaction must satisfy ACID.

---

# Transaction Lifecycle

Begin

↓

Validate

↓

Execute

↓

Audit

↓

Commit

↓

Publish Events

If failure

Rollback

↓

Log

↓

Alert

↓

Notify

---

# Nested Transactions

Nested transactions shall be avoided.

When unavoidable

Use Savepoints.

---

# Long Running Transactions

Long-running transactions are prohibited.

Background processing shall be used instead.

---

# Chapter 50

# CONCURRENCY CONTROL

Multiple administrators may edit the platform simultaneously.

Concurrency shall be handled explicitly.

Strategies

Optimistic Locking

Pessimistic Locking

Distributed Locking

Queue Serialization

Version Checking

---

# Optimistic Locking

Default strategy.

Each versioned entity stores

version

Before update

Compare Version

↓

If changed

Reject Update

↓

Reload Entity

↓

Retry

Suitable for

Routes

Users

Templates

Reports

---

# Pessimistic Locking

Used only when required.

Examples

Configuration Deployment

Backup

Restore

Route Activation

Plugin Upgrade

These operations must be serialized.

---

# Distributed Locking

Redis provides distributed locks.

Examples

Generate Configuration

Deploy Configuration

Backup

Restore

Cluster Upgrade

Certificate Renewal

Only one node performs the operation.

---

# Chapter 51

# DEADLOCK PREVENTION

Rules

Always acquire locks in consistent order.

Keep transactions short.

Avoid interactive transactions.

Retry deadlocked transactions automatically.

Monitor deadlocks continuously.

Generate alerts after repeated deadlocks.

---

# Chapter 52

# BULK OPERATIONS

Bulk processing shall support

Insert

Update

Delete

Import

Export

Bulk operations execute asynchronously.

Progress shall be visible.

Cancellation shall be supported where practical.

---

# Bulk Import Workflow

Upload

↓

Validate

↓

Preview

↓

Background Queue

↓

Import

↓

Verification

↓

Audit

↓

Completion

---

# Chapter 53

# MATERIALIZED VIEWS

Materialized Views support

Dashboards

Reports

Statistics

Capacity Planning

Examples

Daily Message Summary

Customer Statistics

Route Statistics

SMSC Performance

Queue Summary

Alerts Summary

Views refresh automatically.

---

# Chapter 54

# READ MODELS

Frequently queried data shall have dedicated read models.

Examples

Dashboard

Executive Dashboard

Customer Dashboard

Operations Dashboard

Monitoring

Reports

Read models are optimized for retrieval.

Not updates.

---

# Chapter 55

# CQRS PREPARATION

Future versions may implement

Command Query Responsibility Segregation.

Commands

↓

Write Database

Queries

↓

Read Models

Current architecture shall not prevent future CQRS adoption.

---

# Chapter 56

# PERFORMANCE ANTI-PATTERNS

The following are prohibited.

SELECT *

N+1 Queries

Missing Indexes

Long Transactions

Blocking Queries

Chatty Repositories

Business Logic in Entities

Business Logic in Controllers

Repeated Queries

Duplicate Reads

Ignoring Query Plans

ORM Abuse

Premature Optimization

Every pull request shall be reviewed for these anti-patterns.

---

# Chapter 57

# DATABASE TESTING STANDARDS

Every repository shall have

Unit Tests

Integration Tests

Migration Tests

Transaction Tests

Performance Tests

Concurrency Tests

Rollback Tests

Load Tests

Repositories are considered incomplete without automated tests.

---

# Acceptance Criteria

The ORM and Data Access Layer are complete when

- ORM entities accurately represent the database schema.
- Repositories isolate persistence.
- Business logic exists only in services.
- Transactions are ACID compliant.
- Concurrency is explicitly managed.
- Deadlocks are minimized and monitored.
- Bulk operations execute asynchronously.
- Materialized views support reporting.
- Read models optimize retrieval.
- Performance anti-patterns are prevented.
- Repository test coverage meets project quality standards.

