# JKANNEL API Architecture

## Philosophy

All business functionality is exposed through REST APIs.

## Versioning

/api/v1/

## Authentication

JWT bearer tokens.

API keys for service integrations.

## Core Domains

-   Authentication
-   Users
-   SMSCs
-   Routes
-   Messages
-   Queues
-   DLRs
-   Configuration
-   Monitoring
-   Logs
-   Alerts
-   Backups

## Standards

-   JSON requests
-   JSON responses
-   Consistent error model
-   Pagination
-   Filtering
-   Audit logging
-   OpenAPI documentation
