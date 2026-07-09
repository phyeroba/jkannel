# SMSC Manager Specification - Part 06 - Database Design

## Core Tables

-   smsc
-   smsc_groups
-   smsc_versions
-   smsc_health
-   smsc_metrics
-   smsc_deployments
-   smsc_tags

## Relationships

One SMSC: - many health records - many deployments - many versions -
many metrics

Every deployment is auditable.
