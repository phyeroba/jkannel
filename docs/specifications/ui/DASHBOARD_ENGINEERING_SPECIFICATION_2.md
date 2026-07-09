# JKANNEL Dashboard Engineering Specification

Version: 1.0

Status: Draft

---

# 1. Purpose

The Dashboard is the primary operational interface of JKANNEL.

It provides a real-time view of the health, performance and activity of the entire SMS platform.

The Dashboard must answer one question immediately:

**"Is the platform healthy?"**

The Dashboard is designed for Network Operations Centres (NOC), System Administrators, Engineers, Support Staff and Executives.

---

# 2. Objectives

The Dashboard shall provide:

• Real-time visibility

• Operational awareness

• System health

• SMS traffic visibility

• SMSC health

• Queue visibility

• Alert visibility

• API monitoring

• Docker monitoring

• Database monitoring

• Customer activity

• Vendor activity

• Executive KPIs

---

# 3. Dashboard Principles

The Dashboard shall be:

Simple

Fast

Responsive

Role-based

Customizable

Real-time

Actionable

Every displayed metric shall allow drill-down into the originating module.

---

# 4. Dashboard Types

JKANNEL shall support multiple dashboards.

Executive Dashboard

Operations Dashboard

Engineering Dashboard

Support Dashboard

Customer Dashboard (Future)

Vendor Dashboard (Future)

Custom Dashboard

Each user may define a default dashboard.

---

# 5. Executive Dashboard

Displays business-level information.

Total Messages Today

Messages This Month

Delivery Success Rate

Current TPS

Top Customers

Top Vendors

Platform Availability

Current Incidents

Revenue Metrics (Future)

Growth Trends

Executive users do not require low-level technical metrics.

---

# 6. Operations Dashboard

Displays operational health.

Current SMS/sec

MO Rate

MT Rate

DLR Rate

Online SMSCs

Offline SMSCs

Bind Count

Queues

Critical Alerts

Failed Messages

Current Route Utilization

Retry Queue

Operations Dashboard refreshes continuously.

---

# 7. Engineering Dashboard

Displays technical metrics.

CPU

Memory

Disk

Docker Containers

Redis

PostgreSQL

Bearerbox

Smsbox

Engine Health

API Latency

Configuration Version

Connection Latency

Worker Status

Cache Usage

Open Connections

---

# 8. Support Dashboard

Support users primarily require customer information.

Customer Activity

Recent Failures

Failed Deliveries

DLR Status

Recent Logins

Recent Configuration Changes

Recent Alerts

Recent Support Incidents

Most Active Customers

---

# 9. Dashboard Layout

The dashboard is widget-based.

Widgets may be:

Moved

Resized

Hidden

Pinned

Duplicated

Saved

Shared

Each user maintains their own layout.

---

# 10. KPI Cards

Standard KPI cards include:

Messages Today

Messages This Hour

Delivery Rate

Current TPS

Failed Messages

Queued Messages

Online SMSCs

Offline SMSCs

Critical Alerts

API Requests

CPU Usage

Memory Usage

Disk Usage

KPI cards update automatically.

---

# 11. Charts

Supported charts.

Line Charts

Area Charts

Bar Charts

Stacked Bar Charts

Pie Charts

Donut Charts

Heat Maps

Geo Maps

Trend Graphs

Timeline Graphs

Charts support zooming and filtering.

---

# 12. Queue Widgets

Display:

Outgoing Queue

Incoming Queue

Retry Queue

DLR Queue

Expired Queue

Dead Letter Queue

Each queue displays:

Current Count

Growth Rate

Processing Rate

Average Wait Time

Peak Size

Health Status

---

# 13. SMSC Widgets

Every SMSC widget displays:

Status

Protocol

Host

Bind Status

TPS

Latency

Queue

Reconnect Count

Availability

Current Session

Error Rate

Last Failure

---

# 14. Infrastructure Widgets

Display:

CPU

RAM

Disk

Docker

Network

Redis

PostgreSQL

Operating System

SSL Certificate Status

Time Synchronization

---

# 15. Alert Panel

Displays:

Critical Alerts

Warnings

Acknowledged Alerts

Escalated Alerts

Recent Alerts

Alert Count

Alert Trend

Selecting an alert opens the Alerts Module.

---

# 16. Activity Timeline

Displays recent events.

User Login

Configuration Deployment

SMSC Connected

SMSC Disconnected

Alert Raised

Alert Cleared

API Failure

Database Failure

Backup Completed

Restore Completed

Every event links to detailed information.

---

# 17. Global Search

Accessible from every dashboard.

Supports searching for:

Messages

Customers

Users

Routes

SMSC

Alerts

Configuration Versions

API Keys

Logs

Search is global across JKANNEL.

---

# 18. Dashboard Permissions

Permissions include:

View Dashboard

Create Dashboard

Edit Dashboard

Delete Dashboard

Share Dashboard

Export Dashboard

Manage Widgets

View Executive Dashboard

View Engineering Dashboard

Permissions are role-based.

---

# 19. Refresh Strategy

Real-time updates use SignalR/WebSockets.

Polling is used only where real-time updates are unavailable.

Widgets refresh independently.

Failed widgets do not affect others.

---

# 20. Performance Requirements

Dashboard load time:

Under 2 seconds.

Widget refresh:

Under 1 second.

Search:

Under 2 seconds.

Charts:

Under 2 seconds.

Support at least:

100 concurrent dashboard users.

---

# 21. Acceptance Criteria

The Dashboard module is complete when:

- All widgets refresh correctly.
- Real-time updates function.
- Role-based dashboards function.
- Layouts are saved.
- Widgets support filtering.
- Drill-down navigation works.
- KPI values are accurate.
- Performance requirements are achieved.
- Dashboard permissions are enforced.

End of Dashboard Engineering Specification v1.0