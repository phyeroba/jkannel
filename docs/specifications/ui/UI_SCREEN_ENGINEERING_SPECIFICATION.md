# JKANNEL UI Screen Engineering Specification

Version: 1.0  
Status: Master UI Behaviour Specification  
Design Authority: `/design_spec/`

---

# Chapter 1 — Design Authority

JKANNEL shall use the existing `design_spec/` folder as the visual design authority.

This document shall not redefine:

- colors
- typography
- spacing
- shadows
- icons
- form styling
- card styling
- chart styling
- responsive rules
- light/dark mode aesthetics

Codex shall review the existing `design_spec/` folder and adapt the visual system to JKANNEL.

The uploaded design handoff states that the prototype is the source of truth for layout, spacing, tokens, and data shape, but must be reimplemented as production components rather than shipped directly. :contentReference[oaicite:0]{index=0}

The visual direction includes Public Sans, JetBrains Mono, navy sidebar, violet accent, white cards, soft shadows, and Vuexy-style enterprise dashboard language. :contentReference[oaicite:1]{index=1}

This document defines what the JKANNEL screens do.

---

# Chapter 2 — JKANNEL Application Shell

## Main Layout

The JKANNEL console shall use:

- left sidebar navigation
- top search bar
- top status indicators
- user profile menu
- notification bell
- environment badge
- breadcrumb area
- main workspace
- optional right-side context drawer

## Top Bar

Top bar contains:

- global search
- current environment: Development / Staging / Production
- engine status indicator
- active alerts count
- notification bell
- theme toggle
- user menu

## Global Search

Searches:

- messages
- SMSCs
- routes
- customers
- alerts
- logs
- configuration versions
- users
- reports

Shortcut:

CTRL + K

---

# Chapter 3 — Primary Navigation

Main sidebar menu:

1. Dashboard
2. Messages
3. SMSC Manager
4. Routing
5. Configuration
6. Queues
7. Delivery Reports
8. Monitoring
9. Alerts
10. Reports
11. Customers
12. Users & Roles
13. API Gateway
14. Docker
15. Logs & Audit
16. Plugins
17. Backup & Restore
18. System Settings

---

# Chapter 4 — Dashboard Menu

## Dashboard Submenu

- Operations Dashboard
- Executive Dashboard
- Network Dashboard
- SMS Traffic Dashboard
- SMSC Health Dashboard
- Queue Dashboard
- Customer Dashboard
- Security Dashboard

## Breadcrumb Example

Home / Dashboard / Operations

## Operations Dashboard Widgets

- Platform Health
- Current SMS/sec
- MT Messages Today
- MO Messages Today
- DLR Success Rate
- Online SMSCs
- Offline SMSCs
- Queue Depth
- Failed Messages
- Critical Alerts
- Docker Health
- PostgreSQL Health
- Redis Health
- Kannel/Kamex Health

## Dashboard Actions

- Refresh
- Customize Layout
- Export Snapshot
- Open Alerts
- View Logs
- Full Screen NOC Mode

---

# Chapter 5 — Messages Menu

## Messages Submenu

- Message Explorer
- Outgoing Messages
- Incoming Messages
- Failed Messages
- Retried Messages
- Scheduled Messages
- Archived Messages
- Bulk Jobs
- Message Search

## Message Explorer Columns

- Message ID
- Date
- Customer
- Sender
- Recipient
- Direction
- Route
- SMSC
- Status
- DLR
- Retry Count
- Latency
- Actions

## Message Actions

- View Details
- Trace Route
- Trace SMSC
- Replay DLR
- Retry Message
- Clone Message
- Export
- Generate Incident

## Breadcrumb Example

Home / Messages / Message Explorer




---

# Chapter 6 — SMSC Manager

## Purpose

The SMSC Manager provides complete lifecycle management of all SMSC connections regardless of protocol or provider.

The objective is that an engineer should never need to edit a Kannel configuration file manually.

All configuration shall be performed through the UI.

---

## SMSC Navigation

SMSC Manager

├── Dashboard

├── All SMSCs

├── Active SMSCs

├── Disabled SMSCs

├── Templates

├── Provider Profiles

├── Certificates

├── Bind History

├── Health Monitor

└── Deployment History

---

## Breadcrumb

Home

/

SMSC Manager

/

All SMSCs

---

## SMSC Dashboard Widgets

Online SMSCs

Offline SMSCs

Connecting SMSCs

Bound SMSCs

Failed SMSCs

Average TPS

Inbound TPS

Outbound TPS

Reconnect Attempts

Average Latency

Bind Success %

DLR Success %

Current Sessions

Certificate Expiry

---

## SMSC List

Columns

Status

Name

Provider

Protocol

Host

Port

System ID

Direction

Priority

Throughput

Connected Since

Health

Version

Actions

---

## SMSC Actions

View

Edit

Clone

Disable

Enable

Restart

Reconnect

Validate

Deploy

Rollback

Delete

View Logs

View Metrics

View Statistics

View Raw Configuration

View Deployment History

Export Configuration

---

## SMSC Detail Tabs

Overview

Configuration

Connection

Monitoring

Statistics

Certificates

Logs

Events

Alerts

Audit

Versions

Dependencies

---

## Connection Screen

Display

Current State

Bind State

Connected Since

Reconnect Count

Average Response Time

Packets Sent

Packets Received

Window Size

Outstanding Requests

Enquire Link Status

TCP State

SSL Status

Certificate Status

---

## Statistics Screen

Messages Submitted

Messages Delivered

Messages Failed

DLRs Received

DLRs Failed

Average TPS

Peak TPS

Latency

Error Rate

Retries

Throttle Events

Charts

Hourly

Daily

Weekly

Monthly

---

## Health Screen

Health Score

CPU Usage

Memory Usage

Socket Status

Bind Status

Latency Trend

Reconnect Trend

Certificate Expiry

Warnings

Recommendations

---

# Chapter 7 — Routing

## Purpose

The Routing module controls how every message travels through the platform.

Routing shall be visual.

Administrators should understand routing without reading configuration syntax.

---

## Navigation

Routing

├── Route Dashboard

├── Routes

├── Routing Rules

├── Prefix Rules

├── Customer Rules

├── Time Rules

├── Country Rules

├── Operator Rules

├── Failover Rules

├── Throttling

├── Simulations

└── Deployment History

---

## Breadcrumb

Home

/

Routing

/

Routes

---

## Route Dashboard

Widgets

Active Routes

Disabled Routes

Failed Routes

Pending Deployment

Simulation Success %

Average Route Time

Failover Events

Throttle Events

Route Errors

Route Warnings

---

## Route List

Columns

Priority

Route Name

Customer

Country

Operator

SMSC

Rule Count

Status

Version

Last Deployment

Actions

---

## Route Actions

View

Edit

Clone

Validate

Simulate

Deploy

Rollback

Disable

Delete

Export

---

## Route Detail

Tabs

Overview

Rules

Conditions

Dependencies

Simulation

Statistics

History

Audit

Versions

Deployment

---

## Route Builder

Visual drag-and-drop rule editor.

Components

Conditions

Actions

Priority

Branches

Failover

Variables

Rule Groups

Validation

Live Preview

---

## Route Simulation

Inputs

Sender

Recipient

Country

Operator

Customer

Time

Message Type

Priority

Route Override

Simulation Output

Matched Rule

Rejected Rules

Chosen SMSC

Estimated Cost

Estimated Delivery Time

Warnings

Recommendations

Simulation shall never transmit a live message.

---

# Chapter 8 — Configuration Management

## Navigation

Configuration

├── Current Configuration

├── Drafts

├── Generated Configurations

├── Validation

├── Compare Versions

├── Deployment Queue

├── Rollback History

├── Templates

└── Engine Configuration

---

## Dashboard

Current Version

Pending Changes

Deployment Status

Validation Status

Rollback Points

Configuration Drift

Latest Deployment

Configuration Checksum

---

## Configuration Actions

Generate

Preview

Validate

Compare

Deploy

Rollback

Export

Download

Archive

Delete

---

## Configuration Comparison

Side-by-side comparison.

Highlight

Added Objects

Removed Objects

Modified Objects

Dependency Changes

Risk Score

Validation Differences

Deployment Impact

---

## Deployment Screen

Shows

Validation

Deployment Progress

Docker Status

Kannel Reload

Verification

Health Checks

Audit

Notifications

Progress Timeline

---

# Chapter 9 — Queue Management

## Navigation

Queues

├── Queue Dashboard

├── Active Queues

├── Retry Queue

├── Dead Letter Queue

├── Delayed Queue

├── Scheduled Queue

├── Queue Workers

└── Queue Statistics

---

## Queue Dashboard

Widgets

Current Queue Depth

Messages Waiting

Retry Queue

Dead Letters

Worker Status

Average Processing Time

Current TPS

Peak TPS

---

## Queue List

Columns

Queue Name

Messages

Workers

Status

Processing Rate

Retries

Failures

Health

Actions

---

## Queue Actions

Pause

Resume

Drain

Flush

Move Messages

Retry Failed

Rebalance

Export

Inspect

---

## Queue Detail

Tabs

Overview

Messages

Workers

Statistics

Events

Alerts

Audit

Configuration

Dependencies

---

# Chapter 10 — Delivery Reports (DLR)

## Purpose

The Delivery Report module provides complete visibility into the lifecycle of every submitted SMS.

The DLR module shall preserve raw delivery reports while presenting a normalized view to operators.

---

## Navigation

Delivery Reports

├── Dashboard

├── Live DLR Feed

├── Delivered

├── Pending

├── Failed

├── Expired

├── Unknown

├── Raw DLR

├── DLR Replay

└── Statistics

---

## Breadcrumb

Home

/

Delivery Reports

/

Dashboard

---

## Dashboard Widgets

DLRs Today

Delivery Success Rate

Pending DLRs

Expired DLRs

Average Delivery Time

Current DLR TPS

Failed DLRs

Callback Queue

Provider Performance

Operator Performance

---

## Live Feed

Columns

Time

Message ID

Customer

Recipient

Provider

Operator

DLR Status

Latency

Callback Status

Actions

---

## Actions

View Timeline

Replay Callback

View Raw DLR

Download Raw Packet

Trace Message

Export

Generate Incident

---

## DLR Timeline

Submission

↓

Accepted

↓

Queued

↓

Submitted

↓

Carrier Accepted

↓

Delivered

↓

Callback Sent

↓

Completed

Timeline shall be graphical.

---

## DLR Detail Tabs

Overview

Timeline

Callback

Routing

Provider

Audit

Events

Raw Payload

Attachments

---

# Chapter 11 — Monitoring

## Purpose

The Monitoring module provides live operational visibility into every component of JKANNEL.

This module functions as the primary NOC console.

---

## Navigation

Monitoring

├── Overview

├── System

├── Docker

├── PostgreSQL

├── Redis

├── API

├── SMSCs

├── Routes

├── Queues

├── Workers

├── Certificates

├── Network

└── Dependencies

---

## Dashboard Widgets

Platform Health

CPU

Memory

Disk

Network

Database

Redis

Docker

API Response Time

Current TPS

Queue Depth

Worker Status

Certificate Expiry

Replication Status

Backup Status

---

## Health Indicators

Green

Healthy

Blue

Informational

Yellow

Warning

Orange

Degraded

Red

Critical

Grey

Unknown

---

## Monitoring Views

Card View

Table View

Topology View

Timeline View

Heatmap

Trend Graph

NOC Wall

Fullscreen Mode

---

## Component Detail

Health

Metrics

Dependencies

Events

Logs

Alerts

Performance

Recommendations

Audit

---

# Chapter 12 — Alerts

## Purpose

Provides centralized alert management.

Alerts are operational objects.

Every alert has a lifecycle.

---

## Navigation

Alerts

├── Active Alerts

├── Critical

├── Warning

├── Informational

├── Acknowledged

├── Assigned

├── Resolved

├── Closed

├── Suppressed

├── Alert Rules

├── Escalation

└── Notification History

---

## Dashboard Widgets

Critical Alerts

Warning Alerts

Resolved Today

Average Resolution Time

Escalated Alerts

Open Incidents

Suppressed Alerts

Notification Failures

---

## Alert Table

Columns

Severity

Status

Title

Component

Customer

Assigned To

Created

Updated

Duration

Actions

---

## Alert Actions

View

Acknowledge

Assign

Comment

Escalate

Resolve

Close

Suppress

Reopen

Export

Generate Ticket

---

## Alert Detail

Tabs

Overview

Timeline

Comments

Events

Notifications

Related Logs

Dependencies

Audit

---

## Alert Timeline

Raised

↓

Notification

↓

Acknowledged

↓

Assigned

↓

Investigation

↓

Resolved

↓

Closed

Timeline shall remain permanently visible.

---

# Chapter 13 — Reporting

## Purpose

The Reporting module generates operational, executive and customer reports.

All report generation shall execute asynchronously.

---

## Navigation

Reports

├── Report Dashboard

├── Executive Reports

├── Operations Reports

├── Customer Reports

├── SMS Traffic

├── Provider Reports

├── Route Reports

├── Queue Reports

├── Security Reports

├── Audit Reports

├── Scheduled Reports

├── Report Templates

└── Report History

---

## Dashboard Widgets

Reports Generated

Scheduled Reports

Running Reports

Failed Reports

Storage Used

Average Generation Time

Most Downloaded

Template Usage

---

## Report Wizard

Step 1

Choose Template

↓

Step 2

Choose Date Range

↓

Step 3

Choose Filters

↓

Step 4

Choose Output Format

↓

Step 5

Preview

↓

Generate

---

## Supported Formats

PDF

Excel

CSV

JSON

HTML

ZIP

---

## Report History

Columns

Name

Type

Generated By

Created

Completed

Format

Size

Status

Downloads

Actions

---

## Report Actions

Preview

Generate

Download

Duplicate

Schedule

Share

Archive

Delete

Export Template

---

## Scheduled Reports

Daily

Weekly

Monthly

Quarterly

Yearly

Cron Expression

Timezone

Recipients

Delivery Method

---

## Report Detail

Tabs

Overview

Parameters

Output

Downloads

History

Audit

Recipients

Notifications

---

# Chapter 14 — Global Search

The Global Search available from every screen shall support:

Messages

Customers

SMSC

Routes

Alerts

Reports

Logs

Configuration Versions

Users

API Keys

Plugins

Backups

System Settings

Keyboard Shortcut

CTRL + K

Results shall appear grouped by category with keyboard navigation support.

---

# Chapter 15 — Global Notifications

The notification center shall display:

Critical Alerts

Deployment Results

Backup Status

Plugin Events

User Activity

Certificate Warnings

Docker Events

Monitoring Events

Unread items shall be highlighted.

Notifications may be filtered by:

Severity

Module

User

Date

Category

---

---

# Chapter 16 — Customer Management

## Purpose

The Customer module manages organizations, departments, resellers and future multi-tenant customers.

Customers are business entities.

They own

Routes

Sender IDs

API Keys

Users

Statistics

Reports

Quotas

Billing (Future)

---

## Navigation

Customers

├── Dashboard

├── All Customers

├── Active Customers

├── Disabled Customers

├── Sender IDs

├── Quotas

├── Usage

├── Reports

├── Statistics

└── Audit

---

## Breadcrumb

Home

/

Customers

/

All Customers

---

## Dashboard Widgets

Total Customers

Active Customers

Disabled Customers

Messages Today

Average TPS

Total Routes

Quota Utilization

Top Customers

Top SMSCs

Recent Activity

---

## Customer List

Columns

Status

Customer Name

Code

Country

Default Route

Default SMSC

Users

TPS

Monthly Messages

Quota

Created

Actions

---

## Customer Actions

View

Edit

Enable

Disable

Reset API Keys

Assign Routes

Assign SMSCs

Generate Report

Export

Clone

Archive

Delete

---

## Customer Detail Tabs

Overview

Users

Routes

Sender IDs

API Keys

Statistics

Reports

Alerts

Audit

Settings

---

# Chapter 17 — Users

## Navigation

Users

├── Dashboard

├── All Users

├── Online Users

├── Disabled Users

├── Locked Users

├── Sessions

├── MFA

├── Audit

└── Activity

---

## Dashboard Widgets

Total Users

Online Users

Locked Accounts

Failed Logins

Active Sessions

MFA Enabled

Password Expiry

Recent Activity

---

## User List

Columns

Avatar

Name

Username

Email

Department

Role

Status

Last Login

Sessions

Actions

---

## User Actions

View

Edit

Reset Password

Unlock

Disable

Enable

Terminate Sessions

Reset MFA

Clone

Delete

---

## User Profile Tabs

Overview

Roles

Permissions

Sessions

MFA

API Activity

Audit

Notifications

Preferences

Devices

---

# Chapter 18 — Roles & Permissions

## Navigation

Security

├── Roles

├── Permissions

├── Permission Matrix

├── Access Policies

├── Security Profiles

└── Audit

---

## Role List

Columns

Role

Users

Permissions

Created

Updated

Status

Actions

---

## Role Actions

Create

Edit

Clone

Export

Disable

Delete

Assign Users

Assign Permissions

---

## Permission Matrix

Rows

Modules

Columns

Roles

Display

View

Create

Edit

Delete

Deploy

Rollback

Export

Approve

Administrator can edit permissions directly from the matrix.

---

## Permission Categories

Dashboard

Messages

SMSC

Routes

Configuration

Queues

Monitoring

Alerts

Reports

Customers

Users

API

Docker

Plugins

Backups

System

---

# Chapter 19 — API Keys

## Navigation

API Gateway

├── API Keys

├── Service Accounts

├── OAuth (Future)

├── Rate Limits

├── Usage

├── Webhooks

├── SDK

└── Audit

---

## API Key List

Columns

Name

Owner

Status

Last Used

Requests Today

Rate Limit

Expiry

Actions

---

## API Key Actions

Generate

Rotate

Disable

Enable

Copy

Export

Delete

View Usage

View Audit

---

## API Key Detail Tabs

Overview

Permissions

Usage

Rate Limits

IP Restrictions

Audit

History

Statistics

---

# Chapter 20 — Service Accounts

## Purpose

Service Accounts authenticate background services.

Examples

Monitoring

Backup

Scheduler

Deployment Engine

Plugins

AI Agents

Automation

---

## List

Columns

Name

Status

Permissions

Last Used

Expiry

Owner

Actions

---

## Actions

Create

Rotate Token

Disable

Enable

View Usage

View Audit

Delete

---

# Chapter 21 — Authentication

## Navigation

Authentication

├── Login History

├── Active Sessions

├── Failed Logins

├── MFA

├── Password Policies

├── Lockout Policies

├── Trusted Devices

└── Authentication Logs

---

## Dashboard

Successful Logins

Failed Logins

Locked Accounts

MFA Success

MFA Failures

Average Login Time

Concurrent Sessions

---

## Login History

Columns

User

Time

IP

Location

Browser

Platform

Result

Reason

Actions

---

# Chapter 22 — Session Management

## Session List

Columns

User

Device

Browser

Platform

IP

Location

Started

Last Activity

Status

Actions

---

## Actions

Terminate Session

Terminate All

Lock Session

Export

View Activity

View API Calls

---

## Session Detail

Overview

Timeline

API Requests

Permissions

Device

Audit

Location

---

# Chapter 23 — User Preferences

Every authenticated user may configure

Language

Timezone

Theme

Dashboard Layout

Landing Page

Notification Preferences

Keyboard Shortcuts

Default Reports

Default Dashboard

Accessibility

---

## Notification Preferences

Email

SMS

Telegram

Slack

Microsoft Teams

Discord

Webhook

Push

Per-category subscriptions shall be supported.

---

# Chapter 24 — Administrative Search

Administrators shall search

Users

Customers

Roles

Permissions

API Keys

Sessions

Service Accounts

Audit

Reports

Search shall support

Live Filtering

Saved Searches

Advanced Filters

Export Results

---

# Chapter 25 — Acceptance Criteria

The Administration UI is complete when

- Customers are fully manageable.
- Users support full lifecycle management.
- Roles and permissions provide RBAC administration.
- API Keys support secure automation.
- Service Accounts support background services.
- Authentication history is searchable.
- Active sessions can be managed.
- User preferences are configurable.
- Administrative search provides rapid access across security-related resources.

---

# Chapter 26 — Docker Management

## Purpose

The Docker module manages every container required by JKANNEL.

Administrators shall never require SSH access for normal operational tasks.

---

## Navigation

Docker

├── Overview

├── Containers

├── Images

├── Networks

├── Volumes

├── Compose Services

├── Events

├── Resource Usage

├── Logs

└── Registry

---

## Dashboard Widgets

Docker Engine

Container Health

CPU Usage

Memory Usage

Disk Usage

Running Containers

Stopped Containers

Restart Count

Image Updates

Volume Usage

---

## Container List

Columns

Status

Container

Image

Version

CPU

Memory

Restart Count

Health

Uptime

Actions

---

## Container Actions

Start

Stop

Restart

Recreate

Upgrade

Download Logs

View Metrics

View Events

Inspect

Terminal (Future)

---

## Container Detail Tabs

Overview

Metrics

Logs

Events

Volumes

Networks

Environment

Audit

Dependencies

---

# Chapter 27 — Plugin Manager

## Navigation

Plugins

├── Installed

├── Marketplace

├── Updates

├── Dependencies

├── Settings

├── Metrics

└── Audit

---

## Plugin List

Columns

Status

Plugin

Vendor

Version

License

Health

Dependencies

Last Updated

Actions

---

## Plugin Actions

Install

Enable

Disable

Upgrade

Rollback

Configure

Export Settings

Delete

---

## Plugin Detail

Overview

Settings

Metrics

Dependencies

Events

Permissions

Audit

Versions

---

# Chapter 28 — Backup & Restore

## Navigation

Backup

├── Dashboard

├── Backups

├── Restore

├── Destinations

├── Verification

├── Retention

├── Schedule

└── Audit

---

## Dashboard Widgets

Latest Backup

Backup Success

Restore Points

Storage Used

Retention Status

Verification Status

Backup Duration

Failed Jobs

---

## Backup List

Columns

Status

Backup Name

Type

Size

Destination

Created

Verified

Retention

Actions

---

## Backup Actions

Create

Verify

Restore

Download

Archive

Delete

Export Metadata

---

## Restore Wizard

Step 1

Select Backup

↓

Step 2

Integrity Verification

↓

Step 3

Compatibility Check

↓

Step 4

Preview

↓

Step 5

Restore

↓

Step 6

Health Verification

↓

Completion

---

# Chapter 29 — Audit Explorer

## Purpose

Provides complete forensic visibility across the platform.

---

## Navigation

Audit

├── Explorer

├── User Activity

├── Configuration

├── Security

├── Deployments

├── API Activity

├── Export

└── Statistics

---

## Explorer Filters

Date

User

Customer

Route

SMSC

Alert

Message

Configuration

Severity

Correlation ID

Request ID

IP Address

Browser

Action

---

## Audit Actions

View

Export

Generate Report

Copy Correlation ID

Open Related Entity

Timeline View

---

## Timeline View

Chronological activity visualization.

Each event links directly to the affected object.

---

# Chapter 30 — Log Explorer

## Navigation

Logs

├── Live Logs

├── System

├── API

├── Docker

├── PostgreSQL

├── Redis

├── Kannel

├── SMSC

├── Workers

├── Security

├── Scheduler

└── Archived

---

## Live Log Viewer

Features

Auto Scroll

Pause

Search

Regex Search

Highlight

Bookmark

Download

Export

Copy

Filter by Module

Filter by Severity

Filter by Correlation ID

---

## Log Detail

Timestamp

Severity

Module

Component

Correlation ID

Request ID

Thread

Message

Stack Trace (Admin Only)

Metadata

---

# Chapter 31 — Scheduler

## Navigation

Scheduler

├── Dashboard

├── Scheduled Jobs

├── Running Jobs

├── Failed Jobs

├── Workers

├── Queue

├── History

└── Statistics

---

## Job Actions

Run

Pause

Resume

Cancel

Duplicate

Export

Delete

---

## Job Detail

Overview

History

Execution Timeline

Output

Audit

Metrics

Dependencies

Notifications

---

# Chapter 32 — Notification Center

## Navigation

Notifications

├── Inbox

├── Email

├── SMS

├── Telegram

├── Slack

├── Teams

├── Discord

├── Webhooks

├── Templates

└── Delivery History

---

## Notification Actions

Mark Read

Archive

Retry

Delete

Export

Open Related Alert

Open Related Message

---

# Chapter 33 — System Settings

## Navigation

System

├── General

├── Platform

├── Database

├── Redis

├── Docker

├── Security

├── Authentication

├── Monitoring

├── Notifications

├── Logging

├── Backups

├── Integrations

├── Certificates

├── Licensing (Future)

└── About

---

## Settings Layout

Each settings page shall contain

Description

Configuration

Validation

Documentation Link

Restore Defaults

Save

Discard

Audit History

Validation Status

---

# Chapter 34 — Help Center

## Navigation

Help

├── User Guide

├── Administrator Guide

├── API Documentation

├── Keyboard Shortcuts

├── Release Notes

├── Known Issues

├── Support Bundle

├── Diagnostics

└── About JKANNEL

---

## Diagnostics

Generate Support Bundle

Export Configuration

Export Logs

Export Metrics

Export Audit

System Health Report

Docker Status

Environment Information

The Support Bundle shall automatically redact secrets.

---

# Chapter 35 — Global UI Standards

## Breadcrumbs

Every screen shall display breadcrumbs.

Example

Home

/

Monitoring

/

SMSC

/

Provider A

---

## Page Header

Every screen shall display

Title

Description

Primary Actions

Secondary Actions

Search

Breadcrumb

---

## Loading States

Every asynchronous operation shall display

Skeleton Screen

Progress Indicator

Estimated Duration

Cancel Option (where applicable)

---

## Empty States

Every empty screen shall provide

Explanation

Suggested Next Step

Create Button

Documentation Link

---

## Error States

Errors shall display

Title

Description

Correlation ID

Retry

Diagnostics

Related Documentation

Never display raw exceptions.

---

## Confirmation Dialogs

Required for

Delete

Deploy

Rollback

Restore

Shutdown

Restart

Disable

Bulk Operations

Dialogs shall explain consequences.

---

## Toast Notifications

Levels

Success

Information

Warning

Error

Persistent

Auto-dismiss configurable.

---

## Keyboard Shortcuts

CTRL + K

Global Search

CTRL + /

Command Palette

CTRL + R

Refresh

CTRL + SHIFT + F

Advanced Search

CTRL + SHIFT + D

Dashboard

CTRL + SHIFT + M

Messages

CTRL + SHIFT + A

Alerts

ESC

Close Dialog

---

## Accessibility

Support

WCAG 2.2 AA

Keyboard Navigation

Screen Readers

High Contrast

Reduced Motion

Font Scaling

Focus Indicators

Color Blind Safe Charts

---

## Responsive Behaviour

Desktop

Primary interface.

Tablet

Operational interface.

Mobile

Monitoring and emergency administration.

Configuration editing on mobile is discouraged.

---

# Chapter 36 — Cross-Screen Navigation

Every entity shall link to related entities.

Examples

Message

↓

Route

↓

SMSC

↓

Customer

↓

Delivery Report

↓

Audit

↓

Logs

↓

Alerts

No isolated screens shall exist.

---

# Chapter 37 — Screen Acceptance Criteria

Every screen shall

Use the Design Specification.

Consume documented REST APIs.

Enforce RBAC.

Support localization.

Support keyboard navigation.

Support accessibility.

Support breadcrumbs.

Support loading states.

Support empty states.

Support error states.

Support audit links.

Support correlation IDs.

Support responsive layouts.

---

# Chapter 38 — UI Engineering Principles

The JKANNEL interface shall behave as a modern Network Operations Center.

The interface shall prioritize

Operational awareness

Rapid navigation

Minimal clicks

Context preservation

High information density

Consistency

Performance

Accessibility

Engine independence

Every screen shall answer three questions immediately:

What is happening?

Why is it happening?

What action should I take?

The UI shall reduce operator cognitive load while maximizing situational awareness.

---

End of UI_SCREEN_ENGINEERING_SPECIFICATION.md Version 1.0