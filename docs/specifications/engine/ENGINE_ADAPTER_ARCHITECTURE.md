# JKANNEL Engine Adapter Architecture

## Purpose

Separate JKANNEL from any single SMS engine.

## Supported Engines

-   Kannel
-   Kamex

Future engines shall implement the same adapter contract.

## Responsibilities

-   Configuration generation
-   Message submission
-   Status collection
-   Queue information
-   DLR retrieval
-   Health reporting
-   Metrics collection
-   Log collection

Business modules never communicate directly with the SMS engine.
