# SMSC Manager Specification - Part 01 - Overview

## Purpose

The SMSC Manager is responsible for the complete lifecycle management of
SMSC connections.

No user should edit kannel.conf directly.

## Responsibilities

-   Create SMSC connections
-   Edit SMSC connections
-   Delete SMSC connections
-   Enable / Disable
-   Test connectivity
-   Validate configuration
-   Generate engine configuration
-   Deploy configuration
-   Rollback configuration
-   Monitor health
-   Monitor throughput

## Supported Engines

-   Kannel
-   Kamex

## Supported Connection Types

-   SMPP
-   HTTP
-   CIMD2
-   EMI/UCP
-   AT Modem
-   Fake SMSC (Testing)

## Primary Users

-   Administrator
-   Network Engineer
-   Support Engineer
-   Read-only Auditor

## Dependencies

-   Configuration Generator
-   User Management
-   Audit System
-   Monitoring Engine
-   Engine Adapter
