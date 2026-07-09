# JKANNEL Message Explorer Engineering Specification

Version: 1.0

Status: Draft

---

# 1. Purpose

The Message Explorer is the primary operational interface for viewing, searching, analysing and troubleshooting every message processed by JKANNEL.

It shall provide complete visibility into the message lifecycle from submission to final delivery or failure.

The Message Explorer shall become the primary troubleshooting tool for Network Operations, Customer Support and SMS Engineers.

---

# 2. Objectives

The module shall provide:

• Complete message visibility

• Extremely fast searching

• Complete message history

• Complete DLR history

• Message replay tools

• Route tracing

• SMSC tracing

• Customer visibility

• Sender ID visibility

• Audit history

• Export capabilities

---

# 3. Supported Message Types

The explorer shall display

Mobile Originated (MO)

Mobile Terminated (MT)

Delivery Reports (DLR)

Retry Messages

Queued Messages

Expired Messages

Rejected Messages

Failed Messages

Scheduled Messages

Bulk Messages

Test Messages

Loopback Messages

---

# 4. Message Lifecycle

Every message shall expose its complete lifecycle.

Message Received

↓

Validated

↓

Authenticated

↓

Customer Identified

↓

Sender ID Validated

↓

Routing Engine

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

Delivered

↓

DLR Received

↓

Completed

Every transition shall be timestamped.

---

# 5. Search Engine

The search engine shall support:

Message ID

External Reference

Internal Reference

Phone Number

Destination Number

Sender ID

Customer

Route

SMSC

Vendor

Operator

Country

Status

Message Type

Submission Time

Delivery Time

DLR Status

Message Length

Encoding

Tags

Notes

Free Text Search

Multiple simultaneous filters shall be supported.

---

# 6. Advanced Filters

Examples

Show:

Failed Messages

from yesterday

using Vendor X

to Uganda

over SMPP

larger than 160 characters

with Retry Count > 3

Another example

Messages

Customer ABC

between

08:00

and

09:00

that failed because

Bind Failure

Filters shall be saveable.

---

# 7. Message List

The default grid shall display:

Message ID

Date

Customer

Source

Destination

Sender ID

Message Type

Encoding

Length

Route

SMSC

Vendor

Operator

Status

DLR

Retry Count

Processing Time

Cost (Future)

Actions

Columns shall be configurable.

---

# 8. Message Details

Selecting a message opens a detailed inspection view.

Sections

General

Routing

SMSC

Customer

Delivery

DLR

Retries

Timeline

Audit

Technical Metadata

Attachments (Future)

---

# 9. Technical Metadata

Display

Internal UUID

External UUID

SMPP Sequence Number

PDU Reference

TON

NPI

ESM Class

Data Coding

Priority Flag

Validity Period

Protocol

Bind Session

Connector

Queue Name

Correlation ID

Latency Measurements

Every available protocol field should be visible.

---

# 10. Message Timeline

Every message displays a chronological timeline.

Example

09:15:01

API Request Received

09:15:01

Authentication Successful

09:15:01

Customer Validated

09:15:02

Route Selected

09:15:02

Queued

09:15:03

Submitted

09:15:03

Accepted

09:15:11

DLR Received

09:15:11

Completed

Timeline entries are immutable.

---

# 11. Route Trace

Every message shall expose

Selected Route

Rejected Routes

Evaluation Order

Matched Rules

Priority Calculations

Cost Evaluation

Load Balance Decision

Failover Decisions

This becomes invaluable during troubleshooting.

---

# 12. SMSC Trace

Display

Selected SMSC

Bind Session

Connection State

Window Usage

Submit Time

Response Time

Submit Result

Error Code

Retry Attempts

DLR Received

---

# 13. Customer View

Display

Customer

Account

Role

API Key Used

Quota

Sender IDs

Assigned Routes

Assigned SMSCs

Authentication Method

IP Address

Session Information

---

# 14. Delivery Report View

Every DLR shall display

Original Message

Original SMSC

Original Route

Delivery Status

Delivery Time

Operator Response

SMPP Error

Vendor Error

Raw DLR Payload

Retry Count

Final Result

---

# 15. Replay Functions

Operators may

Replay DLR

Requeue Message

Clone Message

Export Message

Forward Message

Copy Technical Details

Generate Incident

All replay actions are audited.

---

# 16. Export

Supported formats

CSV

Excel

JSON

PDF

XML

Exports shall support filtering and scheduling.

---

# 17. Permissions

Read Only

Support

Engineer

Administrator

API

Each role shall expose only permitted information.

Sensitive fields such as passwords, API secrets and credentials shall never appear.

---

# 18. Audit Requirements

Every action is recorded.

Viewed

Exported

Replayed

Cloned

Requeued

Deleted (if permitted)

Shared

Printed

Audit history is immutable.

---

# 19. Performance Requirements

Search results under 2 seconds.

Pagination supported.

Server-side filtering.

Incremental loading.

Full-text indexing.

Partitioned historical storage.

Optimised indexes.

---

# 20. Acceptance Criteria

The module shall be considered complete when:

- Every processed message can be located.
- Message history is complete.
- Route trace is available.
- SMSC trace is available.
- DLR history is available.
- Timeline is complete.
- Search performance meets targets.
- Exports function correctly.
- Replay functions operate correctly.
- Audit history is complete.

End of Message Explorer Engineering Specification v1.0