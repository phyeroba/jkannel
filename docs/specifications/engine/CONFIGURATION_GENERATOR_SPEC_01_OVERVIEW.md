# Configuration Generator Specification - Part 01 - Overview

## Purpose

Generate engine configuration from database objects.

No user edits configuration files manually.

## Responsibilities

-   Generate bearerbox configuration
-   Generate smsbox configuration
-   Generate SMSC configuration
-   Validate syntax
-   Preview changes
-   Version every generated configuration
-   Support rollback
-   Engine independent through adapter layer
