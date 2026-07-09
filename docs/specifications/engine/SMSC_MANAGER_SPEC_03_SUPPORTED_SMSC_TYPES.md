# SMSC Manager Specification - Part 03 - Supported SMSC Types

## Phase 1

-   SMPP Client
-   SMPP Server
-   HTTP SMS
-   Fake SMSC
-   AT Modem

## Phase 2

-   CIMD2
-   EMI/UCP

## Future

-   SS7 adapters
-   REST providers
-   Cloud SMS APIs

## Connection Attributes

Every SMSC shall support:

-   Name
-   Description
-   Host
-   Port
-   Username
-   Password
-   System Type
-   TON
-   NPI
-   Bind Mode
-   Window Size
-   TPS
-   Priority
-   Retry Policy
-   Timeout
-   Keepalive
-   TLS
-   Tags
-   Notes

Each adapter may expose engine-specific advanced settings.
