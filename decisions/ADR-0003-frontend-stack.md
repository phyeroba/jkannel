# ADR-0003: Frontend Stack

- Status: Accepted
- Date: 2026-07-06

## Context

`FRONTEND_ENGINEERING_SPECIFICATION.md` names React, while the more comprehensive master engineering handbook selects Vue 3, Vite, and Tailwind CSS. The mission brief also prefers Vue 3.

## Decision

Use Vue 3 with the Composition API, TypeScript, Vite, Vue Router, and Tailwind CSS. Treat React references in the older frontend specification as superseded implementation details while retaining its framework-neutral requirements.

## Consequences

Vue is canonical and future frontend work must not introduce React. A later specification revision should remove the stale React wording.

