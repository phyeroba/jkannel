# API Platform Primitives

Updated: 2026-07-09

This note records the implemented platform primitives that support the REST API standard without pretending that every endpoint is fully documented or every async workflow is complete.

## OpenAPI

- `GET /api/v1/openapi.json` serves a raw OpenAPI 3.1 document.
- The document currently covers platform-critical primitives and selected operational paths.
- Full automatic endpoint/schema generation remains a traceability gap.

## Idempotency

- Authenticated mutating requests may send `Idempotency-Key`.
- Keys are scoped by tenant, HTTP method and normalized route.
- The backend hashes method, route and request body to reject accidental key reuse with different payloads.
- Completed requests return the stored response body rather than executing twice.
- In-flight duplicate requests return a conflict so clients can retry safely later.
- SMSC runtime actions keep their domain-specific operation history while the platform interceptor provides the generic retry primitive.

## Long-running jobs

- Migration `009_api_platform_primitives` adds tenant-isolated `api_jobs` and `api_idempotency_records`.
- `GET /api/v1/jobs` lists platform jobs.
- `GET /api/v1/jobs/{id}` returns job state.
- `POST /api/v1/jobs` creates a queued platform job placeholder and supports `Idempotency-Key`.
- `POST /api/v1/jobs/{id}/cancel` cancels queued or running jobs.

The current job service is an API and persistence foundation. Worker execution, scheduling, queue processors and large-result export jobs remain future implementation gaps.
