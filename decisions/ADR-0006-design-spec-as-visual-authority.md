# ADR-0006: Design Specification as Visual Authority

- Status: Accepted
- Date: 2026-07-06

## Context

The supplied `design_spec` assets originate from another application and contain useful visual patterns but unrelated JVIDEO terminology.

## Decision

Preserve `design/design_spec/` unchanged as the visual authority for aesthetic direction. Rebuild patterns as JKANNEL-native Vue components. Screen behavior, permissions, menus, breadcrumbs, and workflows come from `UI_SCREEN_ENGINEERING_SPECIFICATION.md`. Never copy JVIDEO domain language.

## Consequences

Visual continuity is retained without domain contamination. Every adopted pattern needs accessibility and responsive validation.

